import { describe, expect, it, vi } from 'vitest'
import type {
  AccountRecord,
  AccountRepository,
  AuditEvent,
  Membership,
  MembershipRepository,
} from '@cat-factory/kernel'
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
  return { events, recorder: { record: (event: AuditEvent) => events.push(event) } }
}

function makeService(
  overrides: {
    account?: Partial<AccountRecord>
    memberships?: Membership[]
    /** Omit the recorder entirely, to prove the service runs unaudited. */
    unaudited?: boolean
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
  const deps: AccountServiceDependencies = {
    accountRepository,
    membershipRepository,
    idGenerator: { next: (p: string) => `${p}_1` },
    clock: { now: () => 1_000 },
    ...(overrides.unaudited ? {} : { audit: audit.recorder }),
  }
  return { service: new AccountService(deps), events: audit.events, account }
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
    })
    expect(events[0]?.summary).toContain('developer')
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
    })
    // Without the previous value a reader cannot tell this promotion from a demotion.
    expect(events[0]?.summary).toContain('developer')
    expect(events[0]?.summary).toContain('admin')
  })

  it('records a budget change, and states a cleared limit as cleared rather than as a value', async () => {
    const { service, events } = makeService()

    await service.updateSettings('acc-1', 'usr-admin', { spendMonthlyLimit: 500 })
    await service.updateSettings('acc-1', 'usr-admin', { spendMonthlyLimit: undefined })

    expect(events.map((e) => e.action)).toEqual([
      'account.budget_changed',
      'account.budget_changed',
    ])
    expect(events[0]?.summary).toContain('500')
    expect(events[1]?.summary).toMatch(/cleared/i)
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
