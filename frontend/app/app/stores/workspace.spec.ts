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
})
