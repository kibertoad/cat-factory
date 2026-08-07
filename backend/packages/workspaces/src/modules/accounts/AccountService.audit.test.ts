import { describe, expect, it, vi } from 'vitest'
import type {
  AccountRecord,
  AccountRepository,
  AuditEvent,
  Membership,
  MembershipRepository,
} from '@cat-factory/kernel'
import { AUDIT_ACTION_DETAIL_KEYS } from '@cat-factory/contracts'
import { AccountService, type AccountServiceDependencies } from './AccountService.js'

// The audit half of the tenancy service: WHICH privileged actions produce an event, and what each
// one states. These are assertions about the CONTENT of the log rather than about the store, so
// they run against a recording recorder and no database.
//
// The two properties worth pinning beyond "an event was written": a role change records the
// PREVIOUS role set (a log holding only the new value cannot tell a promotion from a demotion),
// and a two-key settings patch produces TWO events rather than one vague "settings edited".

function recorder() {
  const events: AuditEvent[] = []
  return {
    events,
    recorder: {
      record: (event: AuditEvent) => {
        // Checked for EVERY event this file records, not case by case: the viewer interpolates
        // details into translated copy by key, so a missing key renders a gap in a sentence and an
        // extra one is a value no locale has a slot for.
        expect(Object.keys(event.details).sort()).toEqual(
          [...AUDIT_ACTION_DETAIL_KEYS[event.action]].sort(),
        )
        events.push(event)
        return Promise.resolve()
      },
    },
  }
}

function makeService(
  overrides: {
    account?: Partial<AccountRecord>
    memberships?: Membership[]
    /** Omit the recorder entirely, to prove the service runs unaudited. */
    unaudited?: boolean
    /** Omit the session-revocation callback, to prove the service refuses rather than pretends. */
    noRevoker?: boolean
  } = {},
) {
  const account: AccountRecord = {
    id: 'acc-1',
    type: 'org',
    name: 'Acme',
    githubAccountLogin: null,
    ownerUserId: null,
    createdAt: 1,
    ...overrides.account,
  }
  const rows = new Map<string, Membership>(
    (
      overrides.memberships ?? [
        { accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'] as const, createdAt: 1 },
      ]
    ).map((m) => [`${m.accountId}:${m.userId}`, m as Membership]),
  )
  const accountRepository = {
    get: () => Promise.resolve(account),
    updateSettings: vi.fn((_id: string, patch: Record<string, unknown>) => {
      Object.assign(account, patch)
      return Promise.resolve()
    }),
  } as unknown as AccountRepository
  const membershipRepository = {
    get: (accountId: string, userId: string) =>
      Promise.resolve(rows.get(`${accountId}:${userId}`) ?? null),
    upsert: vi.fn((m: Membership) => {
      rows.set(`${m.accountId}:${m.userId}`, m)
      return Promise.resolve()
    }),
  } as unknown as MembershipRepository
  const audit = recorder()
  const revoked: string[] = []
  const deps: AccountServiceDependencies = {
    accountRepository,
    membershipRepository,
    idGenerator: { next: (p: string) => `${p}_1` },
    clock: { now: () => 1_000 },
    ...(overrides.unaudited ? {} : { audit: audit.recorder }),
    ...(overrides.noRevoker
      ? {}
      : {
          revokeUserSessions: (userId: string) => {
            revoked.push(userId)
            return Promise.resolve(1)
          },
        }),
  }
  return { service: new AccountService(deps), events: audit.events, account, revoked }
}

describe('AccountService audit events', () => {
  it('records a member add with the granted roles', async () => {
    const { service, events } = makeService()

    await service.addMember('acc-1', 'usr-admin', 'usr-new', ['developer'])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      actor: { kind: 'user', userId: 'usr-admin' },
      action: 'account.member_added',
      targetType: 'user',
      targetId: 'usr-new',
      details: { roles: 'developer' },
    })
  })

  it('records a role change with BOTH the old and the new role set', async () => {
    const { service, events } = makeService({
      memberships: [
        { accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'], createdAt: 1 },
        { accountId: 'acc-1', userId: 'usr-target', roles: ['developer'], createdAt: 1 },
      ],
    })

    await service.setMemberRoles('acc-1', 'usr-admin', 'usr-target', ['admin'])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'account.member_roles_changed',
      targetId: 'usr-target',
      // Without the previous value a reader cannot tell this promotion from a demotion.
      details: { previousRoles: 'developer', roles: 'admin' },
    })
  })

  it('records a budget change, and states a cleared limit as null rather than as a value', async () => {
    const { service, events } = makeService()

    await service.updateSettings('acc-1', 'usr-admin', { spendMonthlyLimit: 500 })
    await service.updateSettings('acc-1', 'usr-admin', { spendMonthlyLimit: undefined })

    expect(events.map((e) => e.action)).toEqual([
      'account.budget_changed',
      'account.budget_changed',
    ])
    // A ceiling stays a NUMBER (the viewer formats it as currency for its locale), and "no limit"
    // reads as null: a 0 there would say the opposite policy.
    expect(events.map((e) => e.details)).toEqual([{ limit: 500 }, { limit: null }])
  })

  it('splits a two-key settings patch into one event per key that actually changed', async () => {
    const { service, events } = makeService()

    await service.updateSettings('acc-1', 'usr-admin', {
      defaultCloudProvider: 'aws',
      spendMonthlyLimit: 250,
    })

    // One vague "settings edited" event would make a budget raise unreadable beside a provider
    // switch, which is the whole reason an audit action names WHAT changed.
    expect(events.map((e) => e.action)).toEqual([
      'account.settings_changed',
      'account.budget_changed',
    ])
  })

  it('records nothing for a settings call that names no key', async () => {
    const { service, events } = makeService()

    await service.updateSettings('acc-1', 'usr-admin', {})

    expect(events).toEqual([])
  })

  it('records nothing when the action is REFUSED', async () => {
    // The event goes in after the write commits, so a rejected action must leave no trace: an
    // audit log recording attempts as if they succeeded is worse than none.
    const { service, events } = makeService({
      memberships: [
        { accountId: 'acc-1', userId: 'usr-plain', roles: ['developer'], createdAt: 1 },
      ],
    })

    await expect(service.addMember('acc-1', 'usr-plain', 'usr-new')).rejects.toThrow()
    expect(events).toEqual([])
  })

  it('revokes a member’s sessions and records who did it to whom', async () => {
    const { service, events, revoked } = makeService({
      memberships: [
        { accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'], createdAt: 1 },
        { accountId: 'acc-1', userId: 'usr-target', roles: ['developer'], createdAt: 1 },
      ],
    })

    await service.revokeMemberSessions('acc-1', 'usr-admin', 'usr-target')

    expect(revoked).toEqual(['usr-target'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      actor: { kind: 'user', userId: 'usr-admin' },
      action: 'account.member_sessions_revoked',
      targetType: 'user',
      targetId: 'usr-target',
      // No values: who revoked whose sessions and when is the whole fact, and all three are
      // columns. The recorder above asserts the detail keys match the vocabulary, so an empty
      // set here is checked rather than merely written.
      details: {},
    })
  })

  it('leaves the member’s roles alone — revocation withdraws AUTHENTICATION, not permission', async () => {
    // The distinction the whole route exists for: signing somebody out must not quietly demote
    // them, and a role change must not quietly sign them out.
    const { service, revoked } = makeService({
      memberships: [
        { accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'], createdAt: 1 },
        { accountId: 'acc-1', userId: 'usr-target', roles: ['developer'], createdAt: 1 },
      ],
    })

    await service.revokeMemberSessions('acc-1', 'usr-admin', 'usr-target')
    expect(await service.rolesFor('acc-1', 'usr-target')).toEqual(['developer'])

    // …and the converse: a role change revokes nothing.
    await service.setMemberRoles('acc-1', 'usr-admin', 'usr-target', ['product'])
    expect(revoked).toEqual(['usr-target'])
  })

  it('refuses to revoke sessions of somebody who is not a member of this account', async () => {
    // Without this an admin of ANY account could end the sessions of ANY user on the deployment
    // by guessing an id. It must also not record an event for a revocation that did not happen.
    const { service, events, revoked } = makeService({
      memberships: [{ accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'], createdAt: 1 }],
    })

    await expect(
      service.revokeMemberSessions('acc-1', 'usr-admin', 'usr-outsider'),
    ).rejects.toThrow()
    expect(revoked).toEqual([])
    expect(events).toEqual([])
  })

  it('refuses a non-admin caller, revoking nothing', async () => {
    const { service, events, revoked } = makeService({
      memberships: [
        { accountId: 'acc-1', userId: 'usr-plain', roles: ['developer'], createdAt: 1 },
        { accountId: 'acc-1', userId: 'usr-target', roles: ['developer'], createdAt: 1 },
      ],
    })

    await expect(service.revokeMemberSessions('acc-1', 'usr-plain', 'usr-target')).rejects.toThrow()
    expect(revoked).toEqual([])
    expect(events).toEqual([])
  })

  it('REFUSES rather than reporting success when no revoker is wired', async () => {
    // The one place a missing optional dependency must not degrade quietly: an offboarding tool
    // that returned 204 having withdrawn nothing tells an operator the opposite of the truth.
    const { service, events } = makeService({
      noRevoker: true,
      memberships: [
        { accountId: 'acc-1', userId: 'usr-admin', roles: ['admin'], createdAt: 1 },
        { accountId: 'acc-1', userId: 'usr-target', roles: ['developer'], createdAt: 1 },
      ],
    })

    await expect(service.revokeMemberSessions('acc-1', 'usr-admin', 'usr-target')).rejects.toThrow()
    expect(events).toEqual([])
  })

  it('runs unaudited without a recorder wired', async () => {
    // The service must stay usable standalone (tests, a deployment with no audit store): the
    // absent recorder normalises to the no-op rather than throwing on the mutation path.
    const { service, events } = makeService({ unaudited: true })

    await expect(service.addMember('acc-1', 'usr-admin', 'usr-new')).resolves.toMatchObject({
      userId: 'usr-new',
    })
    expect(events).toEqual([])
  })
})
