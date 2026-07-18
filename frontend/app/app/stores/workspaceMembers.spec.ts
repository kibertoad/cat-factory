import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceMembersStore } from '~/stores/workspaceMembers'
import { useWorkspaceStore } from '~/stores/workspace'
import type { WorkspaceMember } from '~/types/domain'

/** Minimal member view — only the fields the store passes through. */
function member(over: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    workspaceId: 'ws1',
    userId: 'usr_1',
    role: 'member',
    createdAt: 1,
    addedBy: null,
    ...over,
  }
}

describe('workspaceMembers store', () => {
  beforeEach(() => {
    // The store patches the board-list row on an access-mode flip; seed one restricted-capable row.
    const workspace = useWorkspaceStore()
    workspace.workspaces = [
      { id: 'ws1', name: 'Board', accountId: 'acc1', accessMode: 'account', viewerRole: 'admin' },
    ] as never
  })

  it('load replaces the roster and records which board it belongs to', async () => {
    vi.stubGlobal('useApi', () => ({
      listWorkspaceMembers: () =>
        Promise.resolve([member({ userId: 'a' }), member({ userId: 'b' })]),
    }))

    const store = useWorkspaceMembersStore()
    await store.load('ws1')

    expect(store.members.map((m) => m.userId)).toEqual(['a', 'b'])
    expect(store.loadedFor).toBe('ws1')
  })

  it('load is monotonic — a superseded slow fetch cannot clobber a newer board', async () => {
    // Two loads in flight; the OLDER-issued one (wsA) resolves LAST. It must be dropped so
    // the switcher never renders the previous board's roster over the current one.
    const resolvers = new Map<string, (v: WorkspaceMember[]) => void>()
    vi.stubGlobal('useApi', () => ({
      listWorkspaceMembers: (ws: string) =>
        new Promise<WorkspaceMember[]>((resolve) => resolvers.set(ws, resolve)),
    }))

    const store = useWorkspaceMembersStore()
    const first = store.load('wsA') // slow, issued first
    const second = store.load('wsB') // newer, issued second

    resolvers.get('wsB')?.([member({ userId: 'b', workspaceId: 'wsB' })])
    await second
    resolvers.get('wsA')?.([member({ userId: 'a', workspaceId: 'wsA' })])
    await first

    expect(store.members.map((m) => m.userId)).toEqual(['b'])
    expect(store.loadedFor).toBe('wsB')
  })

  it('add upserts the returned member', async () => {
    vi.stubGlobal('useApi', () => ({
      listWorkspaceMembers: () => Promise.resolve([member({ userId: 'a' })]),
      addWorkspaceMember: (_ws: string, userId: string, role: WorkspaceMember['role']) =>
        Promise.resolve(member({ userId, role })),
    }))

    const store = useWorkspaceMembersStore()
    await store.load('ws1')
    await store.add('ws1', 'b', 'viewer')

    expect(store.members.map((m) => m.userId)).toEqual(['a', 'b'])
    expect(store.members.find((m) => m.userId === 'b')?.role).toBe('viewer')
  })

  it('setRole replaces the member in place', async () => {
    vi.stubGlobal('useApi', () => ({
      listWorkspaceMembers: () => Promise.resolve([member({ userId: 'a', role: 'member' })]),
      setWorkspaceMemberRole: (_ws: string, userId: string, role: WorkspaceMember['role']) =>
        Promise.resolve(member({ userId, role })),
    }))

    const store = useWorkspaceMembersStore()
    await store.load('ws1')
    await store.setRole('ws1', 'a', 'admin')

    expect(store.members).toHaveLength(1)
    expect(store.members[0]?.role).toBe('admin')
  })

  it('remove drops the member from the roster', async () => {
    vi.stubGlobal('useApi', () => ({
      listWorkspaceMembers: () =>
        Promise.resolve([member({ userId: 'a' }), member({ userId: 'b' })]),
      removeWorkspaceMember: () => Promise.resolve(),
    }))

    const store = useWorkspaceMembersStore()
    await store.load('ws1')
    await store.remove('ws1', 'a')

    expect(store.members.map((m) => m.userId)).toEqual(['b'])
  })

  it('setAccessMode patches the board-list row in place, preserving the viewerRole annotation', async () => {
    vi.stubGlobal('useApi', () => ({
      setWorkspaceAccessMode: (workspaceId: string, accessMode: string) =>
        // The single-workspace response carries no `viewerRole` (that's a list annotation).
        Promise.resolve({ id: workspaceId, name: 'Board', accountId: 'acc1', accessMode }),
    }))

    const store = useWorkspaceMembersStore()
    await store.setAccessMode('ws1', 'restricted')

    const row = useWorkspaceStore().workspaces.find((w) => w.id === 'ws1')
    expect(row?.accessMode).toBe('restricted')
    // The merge must not clobber the list-only badge.
    expect(row?.viewerRole).toBe('admin')
  })
})
