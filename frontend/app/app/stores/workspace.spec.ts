import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block, WorkspaceSnapshot } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { useWorkspaceStore } from '~/stores/workspace'

// The workspace store's `hydrate` fans out to ~20 sibling stores via Nuxt auto-imports, which
// aren't defined under plain vitest. Stub every one INERT (a proxy whose every method is a no-op)
// EXCEPT the board store, which we keep real so the block list a refresh commits is observable.
const INERT_STORES = [
  'useAccountsStore',
  'useAgentConfigStore',
  'useAgentRunsStore',
  'useAgentsStore',
  'useBrainstormStore',
  'useClarityStore',
  'useConsensusStore',
  'useDocInterviewStore',
  'useEnvironmentTestStore',
  'useExecutionStore',
  'useFragmentsStore',
  'useGitHubStore',
  'useInitiativesStore',
  'useRiskPoliciesStore',
  'useModelPresetsStore',
  'useNotificationsStore',
  'usePipelinesStore',
  'useProviderConnectionsStore',
  'useRecurringPipelinesStore',
  'useRequirementsStore',
  'useServiceFragmentDefaultsStore',
  'useServicesStore',
  'useSharedStacksStore',
  'useTrackerStore',
  'useUserSettingsStore',
  'useWorkspaceSettingsStore',
]
beforeEach(() => {
  const inert = () => new Proxy({}, { get: () => () => undefined })
  for (const name of INERT_STORES) vi.stubGlobal(name, inert)
  // The real board store (same active Pinia) so `getBlock` reflects the snapshot a refresh hydrates.
  vi.stubGlobal('useBoardStore', useBoardStore)
})

// Regression for the live-push CLOBBER race: `board`-type stream events (and the on-connect
// resync) each trigger a full-snapshot `refresh()`, and `hydrate` REPLACES the block list. Two
// refreshes can be in flight at once (events >300ms apart, or a resync + a board event), and if a
// slower/staler fetch resolves AFTER a newer one, its hydrate used to clobber the newer state —
// dropping a just-spawned block whose only live delivery was the coarse board event, so its card
// never reappeared (no further event to restore it). This surfaced as an intermittent e2e timeout
// where a spawned task/document card never rendered. `refresh()` now stamps each call so only the
// latest-issued one commits; this test pins that a stale out-of-order refresh can't win.

/** Minimal block — only the fields the board store's index getters read. */
function block(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level: 'frame',
    parentId: null,
    ...over,
  }
}

/** Minimal snapshot — the arrays a bare hydrate iterates; everything else defaults. */
function snapshot(id: string, blocks: Block[]): WorkspaceSnapshot {
  return {
    workspace: { id, name: id, accountId: null },
    blocks,
    pipelines: [],
    executions: [],
  } as unknown as WorkspaceSnapshot
}

describe('workspace store refresh ordering', () => {
  it('a stale refresh resolving out of order does not clobber a newer one', async () => {
    const frame = block('f1')
    const spawned = block('spawned', { level: 'task', parentId: 'f1' })
    let resolveStale!: (s: WorkspaceSnapshot) => void
    let resolveFresh!: (s: WorkspaceSnapshot) => void

    const getWorkspace = vi
      .fn()
      // 1) switchTo establishes the active board (no spawned block yet).
      .mockResolvedValueOnce(snapshot('ws1', [frame]))
      // 2) the EARLIER-issued refresh (stale: still no spawned block) — resolved LAST below.
      .mockReturnValueOnce(new Promise<WorkspaceSnapshot>((r) => (resolveStale = r)))
      // 3) the LATER-issued refresh (fresh: the spawned block landed) — resolved FIRST below.
      .mockReturnValueOnce(new Promise<WorkspaceSnapshot>((r) => (resolveFresh = r)))
    vi.stubGlobal('useApi', () => ({ getWorkspace }))

    const ws = useWorkspaceStore()
    const board = useBoardStore()
    await ws.switchTo('ws1')
    expect(board.getBlock('spawned')).toBeUndefined()

    // Two overlapping refreshes: the later-issued one carries the fresher snapshot, but the
    // earlier-issued (stale) one resolves last — the exact out-of-order clobber the guard blocks.
    const stalePass = ws.refresh()
    const freshPass = ws.refresh()
    resolveFresh(snapshot('ws1', [frame, spawned]))
    resolveStale(snapshot('ws1', [frame]))
    await Promise.all([stalePass, freshPass])

    // The fresh snapshot won and the stale one was discarded: the spawned card survives.
    expect(board.getBlock('spawned')).toBeDefined()
  })

  // Regression for the SECOND clobber axis: a refresh vs an interleaved live `upsert`. The
  // `refreshSeq` guard above only orders refreshes against each OTHER — it does nothing when a
  // single refresh's (slow) fetch overlaps a targeted live event. A run's status transitions
  // (…→ in_progress → pr_ready/done) arrive as `execution`-event `board.upsert`s; a refresh whose
  // snapshot was FETCHED while the block was still `in_progress` must not, on resolving later,
  // replace that block back to the stale status. This was the reliable-under-CI-latency e2e
  // timeout where a run never showed a terminal `data-status`. The board store now stamps each
  // live upsert and `refresh()` captures a baseline before its fetch so the newer live state wins.
  it('a refresh started before a live upsert does not clobber the newer live status', async () => {
    const frame = block('f1')
    const task = block('t1', { level: 'task', parentId: 'f1', status: 'in_progress' })
    let resolveRefresh!: (s: WorkspaceSnapshot) => void
    const getWorkspace = vi
      .fn()
      // 1) switchTo — the task is mid-run (`in_progress`).
      .mockResolvedValueOnce(snapshot('ws1', [frame, task]))
      // 2) a refresh whose fetch is in flight while a live terminal event lands.
      .mockReturnValueOnce(new Promise<WorkspaceSnapshot>((r) => (resolveRefresh = r)))
    vi.stubGlobal('useApi', () => ({ getWorkspace }))

    const ws = useWorkspaceStore()
    const board = useBoardStore()
    await ws.switchTo('ws1')
    expect(board.getBlock('t1')?.status).toBe('in_progress')

    // A refresh starts (captures the board baseline; its snapshot still shows `in_progress`).
    const pass = ws.refresh()
    // A live execution event lands mid-fetch: the run reached terminal, so the block is `done`.
    board.upsert(block('t1', { level: 'task', parentId: 'f1', status: 'done' }))
    expect(board.getBlock('t1')?.status).toBe('done')
    // The now-stale refresh resolves with its older `in_progress` snapshot.
    resolveRefresh(snapshot('ws1', [frame, block('t1', { level: 'task', parentId: 'f1' })]))
    await pass

    // The live terminal status survives — the stale refresh did NOT clobber it back.
    expect(board.getBlock('t1')?.status).toBe('done')
  })
})

// Cold-open waterfall flattening (app-startup initiative, item 8): `init()` fetches the persisted
// board's snapshot SPECULATIVELY, in parallel with the workspace list, instead of waiting for the
// list to resolve before the (heaviest) snapshot fetch. These pin that (a) a still-valid persisted
// board is opened with EXACTLY ONE snapshot fetch — the reused speculative one — and (b) a stale
// persisted id falls back cleanly, discarding the speculative result.
describe('workspace store cold-open speculative snapshot', () => {
  beforeEach(() => {
    // A working accounts store (the inert stub returns non-promises, which init's `.catch` chain +
    // `accountWorkspaces` can't use). Auth off ⇒ all boards are in scope.
    vi.stubGlobal('useAccountsStore', () => ({
      load: async () => {},
      enabled: false,
      activeAccountId: null,
    }))
  })

  it('reuses the speculative persisted snapshot — one getWorkspace on a cold open', async () => {
    const getWorkspace = vi.fn().mockResolvedValue(snapshot('ws1', [block('f1')]))
    const listWorkspaces = vi.fn().mockResolvedValue([{ id: 'ws1', name: 'ws1', accountId: null }])
    vi.stubGlobal('useApi', () => ({ getWorkspace, listWorkspaces }))

    const ws = useWorkspaceStore()
    ws.workspaceId = 'ws1' // the persisted board (read from localStorage on a real cold open)
    await ws.init()

    // The persisted board's snapshot was fetched exactly once (speculatively) and REUSED —
    // resolveActiveBoard did not fetch it a second time.
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    expect(getWorkspace).toHaveBeenCalledTimes(1)
    expect(getWorkspace).toHaveBeenCalledWith('ws1')
    expect(useBoardStore().getBlock('f1')).toBeDefined()
  })

  it('falls back to the first board when the persisted id is gone', async () => {
    const getWorkspace = vi.fn(async (id: string) => {
      if (id === 'gone') throw new Error('404') // the speculative fetch for a removed board rejects
      return snapshot(id, [block('f2')])
    })
    const listWorkspaces = vi.fn().mockResolvedValue([{ id: 'ws2', name: 'ws2', accountId: null }])
    vi.stubGlobal('useApi', () => ({ getWorkspace, listWorkspaces }))

    const ws = useWorkspaceStore()
    ws.workspaceId = 'gone'
    await ws.init()

    // The rejected speculative fetch didn't wedge init; it fell back to the one board in scope.
    expect(getWorkspace).toHaveBeenNthCalledWith(1, 'gone')
    expect(getWorkspace).toHaveBeenCalledWith('ws2')
    expect(ws.workspaceId).toBe('ws2')
    expect(useBoardStore().getBlock('f2')).toBeDefined()
  })

  it('no persisted board: no speculative fetch, opens the first board', async () => {
    const getWorkspace = vi.fn().mockResolvedValue(snapshot('ws3', [block('f3')]))
    const listWorkspaces = vi.fn().mockResolvedValue([{ id: 'ws3', name: 'ws3', accountId: null }])
    vi.stubGlobal('useApi', () => ({ getWorkspace, listWorkspaces }))

    const ws = useWorkspaceStore()
    ws.workspaceId = null
    await ws.init()

    expect(getWorkspace).toHaveBeenCalledTimes(1)
    expect(getWorkspace).toHaveBeenCalledWith('ws3')
    expect(useBoardStore().getBlock('f3')).toBeDefined()
  })

  // Slice 8 (workspace-RBAC frontend): the resolved `access` the auth gate attaches to the
  // snapshot must land on the store so `useWorkspaceAccess()` can gate affordances.
  it('hydrates the resolved workspace access from the snapshot', async () => {
    const snap = snapshot('ws1', [block('f1')]) as WorkspaceSnapshot
    snap.access = { role: 'viewer', permissions: ['workspace.read'] }
    const getWorkspace = vi.fn().mockResolvedValue(snap)
    vi.stubGlobal('useApi', () => ({ getWorkspace }))

    const ws = useWorkspaceStore()
    await ws.switchTo('ws1')
    expect(ws.access).toEqual({ role: 'viewer', permissions: ['workspace.read'] })

    // A subsequent snapshot WITHOUT access (older backend / dev-open) clears it back to null.
    const snap2 = snapshot('ws1', [block('f1')]) as WorkspaceSnapshot
    getWorkspace.mockResolvedValue(snap2)
    await ws.refresh()
    expect(ws.access).toBeNull()
  })
})
