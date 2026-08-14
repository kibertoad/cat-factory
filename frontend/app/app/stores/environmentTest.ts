import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { EnvironmentTestRun } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Ephemeral-environment self-test runs. A developer starts one from a service frame's inspector
 * (`POST …/blocks/:id/environment-test`); the backend drives the create-branch → provision →
 * tear-down → delete-branch cycle durably and pushes live `envTest` stage events, which
 * `useWorkspaceStream` folds in via {@link upsert}. In-flight runs also arrive in the workspace
 * snapshot ({@link hydrate}) so the inspector re-attaches to a running test after a reconnect.
 *
 * Runs are keyed by their FRAME block id for the inspector's per-service lookup ({@link runForBlock}
 * returns the newest run for a block). Terminal runs are kept in memory for the session so the
 * inspector can show the last outcome; the snapshot only carries running ones.
 */
export const useEnvironmentTestStore = defineStore('environmentTest', () => {
  const api = useApi()

  /** All known runs (running + this session's terminal ones), newest first. */
  const runs = ref<EnvironmentTestRun[]>([])

  function sortByCreated(list: EnvironmentTestRun[]): EnvironmentTestRun[] {
    return [...list].sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Reconcile the cached runs with a server snapshot for `workspaceId`. A snapshot is
   * authoritative EXCEPT where a live `envTest` event has already advanced (or ADDED) a run
   * past what this (possibly stale) read observed — a `board`-event refresh or the on-connect
   * resync can resolve AFTER a newer event already landed. Same two clobber hazards as
   * `agentRuns.hydrate`, both handled here:
   *   - REGRESS: a run present in BOTH the snapshot and the cache — keep the newer-by-`updatedAt`
   *     version, so a lagging refresh can't revert a `failed`/`succeeded` run to `running`
   *     (terminal runs emit nothing further, so the inspector would be stuck on "testing").
   *   - DROP: a run a live event just ADDED that the (older) snapshot never saw — replacing from
   *     the snapshot alone would silently drop it (and terminal runs are omitted from the
   *     snapshot by design, so a finished run the inspector still shows would vanish).
   *     Preserve such cached runs, scoped to `workspaceId` so a board SWITCH still starts clean.
   *
   * A preserved RUNNING run absent from the snapshot may also have reached terminal while the
   * socket was down (no event replays, and the snapshot omits terminal runs) — point-read it
   * best-effort to pick up the outcome; {@link upsert}'s monotonic guard makes the read safe
   * against racing live events.
   */
  function hydrate(snapshotRuns: EnvironmentTestRun[], workspaceId: string) {
    const incomingIds = new Set(snapshotRuns.map((r) => r.id))
    const held = new Map(runs.value.map((r) => [r.id, r]))
    const reconciled = snapshotRuns.map((incoming) => {
      const current = held.get(incoming.id)
      return current && current.updatedAt > incoming.updatedAt ? current : incoming
    })
    const preserved = [...held.values()].filter(
      (r) => !incomingIds.has(r.id) && r.workspaceId === workspaceId,
    )
    runs.value = sortByCreated([...reconciled, ...preserved])
    // A still-`running` preserved run wasn't in the snapshot, so either the snapshot is stale
    // (the run is genuinely newer) or the run FINISHED while we were disconnected — resolve
    // which by re-reading it (non-blocking; failures leave the cached state as-is).
    for (const r of preserved) {
      if (r.status === 'running') void reconcileRun(workspaceId, r.id)
    }
  }

  /**
   * Runs whose point-read is already out, and whether a later hydrate asked again while it was.
   * Overlapping refreshes preserve the same still-running runs and would each re-issue the same
   * GET, so the reads multiply with refresh frequency exactly when the board is busiest.
   *
   * Dropping the later ask outright would be wrong for the same reason plain single-flight is wrong
   * for `workspace.refresh()`: the outstanding read may have been ISSUED before the run reached
   * terminal, and it is the later ask that would have observed the outcome. Nothing asks again after
   * that (terminal runs emit no event and the snapshot omits them), so the inspector would sit on
   * "testing" for the rest of the session. One queued follow-up per run keeps the dedupe while
   * leaving the newest ask an answer: N overlapping hydrates cost one extra read between them.
   */
  const reconciling = new Map<string, { again: boolean }>()

  /** Best-effort point-read of one run, folded in through the monotonic {@link upsert}. */
  async function reconcileRun(workspaceId: string, id: string) {
    const outstanding = reconciling.get(id)
    if (outstanding) {
      outstanding.again = true
      return
    }
    const state = { again: false }
    reconciling.set(id, state)
    try {
      upsert(await api.getEnvironmentTest(workspaceId, id))
    } catch {
      // Best-effort: a transient fetch failure just leaves the cached state; the next
      // snapshot/event reconciles it.
    } finally {
      reconciling.delete(id)
    }
    if (state.again) await reconcileRun(workspaceId, id)
  }

  /**
   * Fold a live-pushed (or freshly-started/stopped) run into the cache. Monotonic by
   * `updatedAt`: never let a stale/out-of-order write regress a run a newer one already
   * advanced — e.g. a `start()` response resolving AFTER a fast-failing run's terminal
   * event already landed (same guard as {@link hydrate}).
   */
  function upsert(run: EnvironmentTestRun) {
    const i = runs.value.findIndex((r) => r.id === run.id)
    if (i >= 0) {
      if (run.updatedAt >= runs.value[i]!.updatedAt) runs.value[i] = run
    } else runs.value.unshift(run)
  }

  function runById(id: string): EnvironmentTestRun | undefined {
    return runs.value.find((r) => r.id === id)
  }

  /** The newest run for a service frame — the inspector's per-service attach point. */
  function runForBlock(blockId: string): EnvironmentTestRun | undefined {
    return runs.value.find((r) => r.blockId === blockId)
  }

  /** Start a self-test against a service frame; the returned run is tracked immediately. */
  async function start(blockId: string): Promise<EnvironmentTestRun> {
    const ws = useWorkspaceStore()
    const run = await api.startEnvironmentTest(ws.requireId(), blockId)
    upsert(run)
    return run
  }

  /** Stop a running self-test (best-effort cleanup, then failed). */
  async function stop(id: string): Promise<EnvironmentTestRun> {
    const ws = useWorkspaceStore()
    const run = await api.stopEnvironmentTest(ws.requireId(), id)
    upsert(run)
    return run
  }

  return { runs, hydrate, upsert, runById, runForBlock, start, stop }
})
