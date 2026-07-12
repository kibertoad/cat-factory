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
   * Replace the RUNNING runs from a full snapshot WITHOUT dropping this session's terminal runs.
   * A REPLACE of the whole list would clobber a just-finished run the inspector is still showing
   * (the snapshot omits terminal runs), so merge: keep local terminal runs, swap in the snapshot's
   * running set (its `id` wins for any run present in both).
   */
  function hydrate(snapshotRuns: EnvironmentTestRun[]) {
    const snapshotIds = new Set(snapshotRuns.map((r) => r.id))
    const keptTerminal = runs.value.filter((r) => r.status !== 'running' && !snapshotIds.has(r.id))
    runs.value = sortByCreated([...snapshotRuns, ...keptTerminal])
  }

  /** Fold a live-pushed (or freshly-started) run into the cache. */
  function upsert(run: EnvironmentTestRun) {
    const i = runs.value.findIndex((r) => r.id === run.id)
    if (i >= 0) runs.value[i] = run
    else runs.value.unshift(run)
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
