import { describe, expect, it, vi } from 'vitest'
import type {
  AccountInvitationRecord,
  AccountInvitationRepository,
  AccountRecord,
  AccountRepository,
  AuditEvent,
  Membership,
  MembershipRepository,
} from '@cat-factory/kernel'
import { AUDIT_ACTION_DETAIL_KEYS } from '@cat-factory/contracts'
import { InvitationService } from './InvitationService.js'

// The audit half of the invitation lifecycle. Two properties beyond "an event was written":
//
//   - the raw accept TOKEN never reaches the log (it is the credential the invitation grants);
//   - a SUPERSEDED pending invite is not recorded as a revocation, because that action means an
//     admin withdrew an invitation and the two must not read the same.

function recorder() {
  const events: AuditEvent[] = []
  return {
    events,
    recorder: {
      record: (event: AuditEvent) => {
        // Every event, not case by case: the viewer interpolates details by key, so a missing one
        // renders a gap and an extra one is a value no locale has a slot for.
        expect(Object.keys(event.details).sort()).toEqual(
          [...AUDIT_ACTION_DETAIL_KEYS[event.action]].sort(),
        )
        events.push(event)
        return Promise.resolve()
      },
    },
  }
}

function makeService(opts: { invitations?: AccountInvitationRecord[] } = {}) {
  const rows = new Map<string, AccountInvitationRecord>(
    (opts.invitations ?? []).map((i) => [i.id, i]),
  )
  const account: AccountRecord = {
    id: 'acc-1',
    type: 'org',
    name: 'Acme',
    githubAccountLogin: null,
    ownerUserId: null,
    createdAt: 1,
  }
  const invitationRepository = {
    create: vi.fn((record: AccountInvitationRecord) => {
      rows.set(record.id, record)
      return Promise.resolve()
    }),
    get: (id: string) => Promise.resolve(rows.get(id) ?? null),
    listByAccount: () => Promise.resolve([...rows.values()]),
    setStatus: vi.fn((id: string, status: AccountInvitationRecord['status']) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, status })
      return Promise.resolve()
    }),
    findByTokenHash: () => Promise.resolve([...rows.values()][0] ?? null),
  } as unknown as AccountInvitationRepository
  const accountRepository = { get: () => Promise.resolve(account) } as unknown as AccountRepository
  const membershipRepository = {
    get: (accountId: string, userId: string) =>
      Promise.resolve({ accountId, userId, roles: ['admin'], createdAt: 1 } as Membership),
    upsert: vi.fn(() => Promise.resolve()),
  } as unknown as MembershipRepository
  const audit = recorder()
  return {
    events: audit.events,
    rows,
    service: new InvitationService({
      invitationRepository,
      accountRepository,
      membershipRepository,
      idGenerator: { next: (p: string) => `${p}_1` },
      clock: { now: () => 1_000 },
      audit: audit.recorder,
    }),
  }
}

const invitation = (overrides: Partial<AccountInvitationRecord> = {}): AccountInvitationRecord => ({
  id: 'inv_0',
  accountId: 'acc-1',
  email: 'someone@acme.test',
  roles: ['developer'],
  tokenHash: 'hash',
  invitedBy: 'usr-admin',
  status: 'pending',
  expiresAt: 9_999_999,
  createdAt: 1,
  ...overrides,
})

describe('InvitationService audit events', () => {
  it('records a created invitation with the invitee and roles, and never the token', async () => {
    const { service, events } = makeService()

    const created = await service.invite('acc-1', 'usr-admin', 'New.Person@Acme.test', [
      'developer',
    ])

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      actor: { kind: 'user', userId: 'usr-admin' },
      action: 'account.invitation_created',
      targetType: 'invitation',
      // The NORMALISED address, so the log matches the row the invitation was written as.
      details: { email: 'new.person@acme.test', roles: 'developer' },
    })
    // The accept token is the credential the invitation grants; it must never reach the log.
    expect(JSON.stringify(events[0]?.details)).not.toContain(created.token)
  })

  it('does not record a SUPERSEDED pending invite as a revocation', async () => {
    // Re-inviting the same address revokes the prior pending row. Recording that as
    // `invitation_revoked` would make an automatic supersession and a deliberate withdrawal
    // indistinguishable in the log.
    const { service, events } = makeService({
      invitations: [invitation({ id: 'inv_prior', email: 'dup@acme.test' })],
    })

    await service.invite('acc-1', 'usr-admin', 'dup@acme.test')

    expect(events.map((e) => e.action)).toEqual(['account.invitation_created'])
  })

  it('records a deliberate revocation against the invitation', async () => {
    const { service, events } = makeService({ invitations: [invitation({ id: 'inv_live' })] })

    await service.revoke('acc-1', 'usr-admin', 'inv_live')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'account.invitation_revoked',
      targetType: 'invitation',
      targetId: 'inv_live',
      details: { email: 'someone@acme.test' },
    })
  })

  it('attributes an acceptance to the person accepting, keeping the inviter in the details', async () => {
    const { service, events } = makeService({
      invitations: [invitation({ id: 'inv_open', invitedBy: 'usr-admin' })],
    })

    await service.accept('raw-token', 'usr-joiner', 'someone@acme.test')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'account.invitation_accepted',
      // The ACCEPTING user, not the admin who offered it: this event records that a membership
      // came into existence. The inviter rides the details, so the pair reads as one story.
      actor: { kind: 'user', userId: 'usr-joiner' },
      details: { email: 'someone@acme.test', roles: 'developer', invitedBy: 'usr-admin' },
    })
  })

  it('records nothing when an acceptance is refused', async () => {
    const { service, events } = makeService({ invitations: [invitation({ id: 'inv_open' })] })

    // Wrong email for the invitation ⇒ refused, so no membership and no event.
    await expect(service.accept('raw-token', 'usr-joiner', 'other@acme.test')).rejects.toThrow()
    expect(events).toEqual([])
  })
})
