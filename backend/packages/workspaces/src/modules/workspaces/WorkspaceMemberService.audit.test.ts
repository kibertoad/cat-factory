import { describe, expect, it, vi } from 'vitest'
import type {
  AuditEvent,
  Membership,
  MembershipRepository,
  WorkspaceMemberRecord,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { AUDIT_ACTION_DETAIL_KEYS } from '@cat-factory/contracts'
import { WorkspaceMemberService } from './WorkspaceMemberService.js'

// The audit half of the board roster. Three properties are pinned here that the account-tier
// tests cannot cover:
//
//   - an event is keyed to the board's ACCOUNT (the viewer reads by account, so a row filed
//     without one is a row no admin will ever see);
//   - a REMOVE reads the row before deleting it, so the event can say what was removed and an
//     idempotent no-op produces nothing;
//   - with no acting user (the `AUTH_DEV_OPEN` path) NOTHING is recorded, rather than an event
//     claiming `system` did what a human did.

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

function makeService(opts: { members?: WorkspaceMemberRecord[]; accountId?: string | null } = {}) {
  const rows = new Map<string, WorkspaceMemberRecord>(
    (opts.members ?? []).map((m) => [`${m.workspaceId}:${m.userId}`, m]),
  )
  const workspaceMemberRepository = {
    get: (workspaceId: string, userId: string) =>
      Promise.resolve(rows.get(`${workspaceId}:${userId}`) ?? null),
    upsert: vi.fn((record: WorkspaceMemberRecord) => {
      rows.set(`${record.workspaceId}:${record.userId}`, record)
      return Promise.resolve()
    }),
    remove: vi.fn((workspaceId: string, userId: string) => {
      rows.delete(`${workspaceId}:${userId}`)
      return Promise.resolve()
    }),
  } as unknown as WorkspaceMemberRepository
  const accountId = opts.accountId === undefined ? 'acc-1' : opts.accountId
  const workspaceRepository = {
    accessRowOf: () =>
      Promise.resolve({ id: 'ws-1', accountId, ownerUserId: 'usr-owner', accessMode: 'account' }),
    setAccessMode: vi.fn(() => Promise.resolve()),
    get: () => Promise.resolve({ id: 'ws-1', name: 'Board', createdAt: 1 }),
    linkAccount: vi.fn(() => Promise.resolve()),
  } as unknown as WorkspaceRepository
  const membershipRepository = {
    get: (acc: string, userId: string) =>
      Promise.resolve({ accountId: acc, userId, roles: ['developer'], createdAt: 1 } as Membership),
  } as unknown as MembershipRepository
  const audit = recorder()
  return {
    events: audit.events,
    members: workspaceMemberRepository,
    service: new WorkspaceMemberService({
      workspaceMemberRepository,
      workspaceRepository,
      membershipRepository,
      clock: { now: () => 1_000 },
      audit: audit.recorder,
    }),
  }
}

const member = (role: WorkspaceMemberRecord['role']): WorkspaceMemberRecord => ({
  workspaceId: 'ws-1',
  userId: 'usr-target',
  role,
  createdAt: 1,
  addedByUserId: 'usr-admin',
})

describe('WorkspaceMemberService audit events', () => {
  it('keys a roster add to the board’s account and names the board', async () => {
    const { service, events } = makeService()

    await service.add('ws-1', 'usr-target', 'member', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      workspaceId: 'ws-1',
      actor: { kind: 'user', userId: 'usr-admin' },
      action: 'workspace.member_added',
      targetType: 'user',
      targetId: 'usr-target',
      details: { role: 'member' },
    })
  })

  it('records a board role change with the previous role', async () => {
    const { service, events } = makeService({ members: [member('viewer')] })

    await service.setRole('ws-1', 'usr-target', 'admin', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      action: 'workspace.member_role_changed',
      details: { previousRole: 'viewer', role: 'admin' },
    })
  })

  it('records the role a removed member HELD, reading it before the delete', async () => {
    const { service, events } = makeService({ members: [member('admin')] })

    await service.remove('ws-1', 'usr-target', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'workspace.member_removed',
      targetId: 'usr-target',
      // After the delete there is nothing left to say what was removed.
      details: { role: 'admin' },
    })
  })

  it('refuses an unresolvable account BEFORE the write, never after it', async () => {
    // The audit event is account-keyed, and resolving that key can refuse (an unscoped board).
    // Resolved after the upsert, the refusal would report a failure for a role change that had
    // already committed — the caller retries, and the row it is told does not exist does.
    const { service, members } = makeService({ accountId: null, members: [member('viewer')] })

    await expect(service.setRole('ws-1', 'usr-target', 'admin', 'usr-admin')).rejects.toThrow(
      /not linked to an account/,
    )
    expect(members.upsert).not.toHaveBeenCalled()
  })

  it('removes a member with no audit actor to name even on an unscoped board', async () => {
    // The mirror of the case above: with nothing to attribute, nothing is resolved either, so the
    // audit decision cannot turn a working removal into a refusal.
    const { service, members, events } = makeService({
      accountId: null,
      members: [member('viewer')],
    })

    await expect(service.remove('ws-1', 'usr-target', null)).resolves.toBeUndefined()
    expect(members.remove).toHaveBeenCalledWith('ws-1', 'usr-target')
    expect(events).toEqual([])
  })

  it('records nothing when removing a member who held no row', async () => {
    // `remove` is idempotent, so the no-op must not produce an event claiming someone was removed.
    const { service, events } = makeService()

    await service.remove('ws-1', 'usr-absent', 'usr-admin')

    expect(events).toEqual([])
  })

  it('records an access-mode flip against the board', async () => {
    const { service, events } = makeService()

    await service.setAccessMode('ws-1', 'restricted', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      workspaceId: 'ws-1',
      action: 'workspace.access_mode_changed',
      targetType: 'workspace',
      targetId: 'ws-1',
      details: { accessMode: 'restricted' },
    })
  })

  it('records NOTHING when there is no acting user, rather than blaming the engine', async () => {
    // Reachable only under `AUTH_DEV_OPEN`, where no session resolves. `system` asserts the engine
    // acted with no human in the loop, and a human plainly did — so an unaudited write is the
    // honest outcome and a misattributed one would be a defect in the log.
    const { service, events } = makeService({ members: [member('viewer')] })

    await service.add('ws-1', 'usr-a', 'member', null)
    await service.setRole('ws-1', 'usr-target', 'admin', null)
    await service.remove('ws-1', 'usr-target', null)
    await service.setAccessMode('ws-1', 'restricted', null)

    expect(events).toEqual([])
  })

  it('still performs the mutation when the audit actor is absent', async () => {
    // The audit decision must not change what the write does.
    const { service } = makeService({ members: [member('viewer')] })

    await expect(service.setRole('ws-1', 'usr-target', 'admin', null)).resolves.toMatchObject({
      role: 'admin',
    })
  })
})
