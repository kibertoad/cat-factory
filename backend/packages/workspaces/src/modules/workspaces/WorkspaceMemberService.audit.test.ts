import { describe, expect, it, vi } from 'vitest'
import type {
  AuditEvent,
  Membership,
  MembershipRepository,
  WorkspaceMemberRecord,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
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
  return { events, recorder: { record: (event: AuditEvent) => events.push(event) } }
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
  } as unknown as WorkspaceRepository
  const membershipRepository = {
    get: (acc: string, userId: string) =>
      Promise.resolve({ accountId: acc, userId, roles: ['developer'], createdAt: 1 } as Membership),
  } as unknown as MembershipRepository
  const audit = recorder()
  return {
    events: audit.events,
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
    })
  })

  it('records a board role change with the previous role', async () => {
    const { service, events } = makeService({ members: [member('viewer')] })

    await service.setRole('ws-1', 'usr-target', 'admin', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      accountId: 'acc-1',
      action: 'workspace.member_role_changed',
    })
    expect(events[0]?.summary).toContain('viewer')
    expect(events[0]?.summary).toContain('admin')
  })

  it('records the role a removed member HELD, reading it before the delete', async () => {
    const { service, events } = makeService({ members: [member('admin')] })

    await service.remove('ws-1', 'usr-target', 'usr-admin')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'workspace.member_removed', targetId: 'usr-target' })
    // After the delete there is nothing left to say what was removed.
    expect(events[0]?.summary).toContain('admin')
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
    })
    expect(events[0]?.summary).toContain('restricted')
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
