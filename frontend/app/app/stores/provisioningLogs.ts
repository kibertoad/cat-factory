import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { ProvisioningLogEntry, ProvisioningSubsystem } from '~/types/provisioningLogs'
import { useWorkspaceStore } from '~/stores/workspace'

interface LogState {
  entries: ProvisioningLogEntry[]
  loading: boolean
  error: string | null
}

function emptyState(): LogState {
  return { entries: [], loading: false, error: null }
}

/**
 * The unified provisioning event log, loaded on demand for two surfaces:
 *   - per SUBSYSTEM, for the "View logs" drawers in the environment-provider and
 *     self-hosted runner-pool config panels;
 *   - per EXECUTION (run), for the "Infrastructure attempts" drawer in a run's step
 *     details — this is the surface that makes the `container` rows (per-run container
 *     dispatch/release/poll-failure) and the `executionId` filter visible.
 * Each shows every spin-up/tear-down attempt with its outcome + the exact error.
 */
export const useProvisioningLogsStore = defineStore('provisioningLogs', () => {
  const api = useApi()
  const bySubsystem = reactive<Record<ProvisioningSubsystem, LogState>>({
    environment: emptyState(),
    'runner-pool': emptyState(),
    container: emptyState(),
  })
  const byExecution = reactive<Record<string, LogState>>({})
  // Monotonic per-execution load counter: the drawer's silent background poll and a manual/visible
  // refresh can be in flight at once, and each ends in a REPLACE-style `s.entries = entries`. Without
  // ordering a slower/staler fetch resolving AFTER a newer one clobbers the fresher timeline (the
  // same out-of-order-overwrite hazard the CLAUDE.md live-push rules warn about, and that
  // stores/workspace.ts guards its full refresh with). Stamp each load; only the latest-issued one
  // commits its result. NOT reactive — pure bookkeeping the UI never reads.
  const loadSeq = new Map<string, number>()

  async function load(subsystem: ProvisioningSubsystem) {
    const ws = useWorkspaceStore()
    const s = bySubsystem[subsystem]
    s.loading = true
    s.error = null
    try {
      const { entries } = await api.listProvisioningLogs(ws.requireId(), { subsystem, limit: 200 })
      s.entries = entries
    } catch (err) {
      s.error = err instanceof Error ? err.message : 'Failed to load logs'
      s.entries = []
    } finally {
      s.loading = false
    }
  }

  /**
   * Load a run's provisioning attempts. `silent` is for the drawer's background poll
   * while the run is live: it must NOT flip the `loading` spinner (it would flicker
   * every poll) and a transient failure must NOT clear the last-good entries or surface
   * an error banner — the visible refresh path (initial open / manual refresh) owns those.
   */
  async function loadForExecution(executionId: string, opts?: { silent?: boolean }) {
    const ws = useWorkspaceStore()
    const s = (byExecution[executionId] ??= emptyState())
    if (!opts?.silent) {
      s.loading = true
      s.error = null
    }
    const seq = (loadSeq.get(executionId) ?? 0) + 1
    loadSeq.set(executionId, seq)
    try {
      const { entries } = await api.listProvisioningLogs(ws.requireId(), {
        executionId,
        limit: 200,
      })
      // A newer load (silent poll or manual refresh) superseded this one while it was in flight —
      // discard this staler result so it can't clobber the fresher timeline.
      if (loadSeq.get(executionId) !== seq) return
      s.entries = entries
      s.error = null
    } catch (err) {
      if (loadSeq.get(executionId) !== seq) return
      // A background poll keeps the last snapshot on a blip; only a visible load reports.
      if (!opts?.silent) {
        s.error = err instanceof Error ? err.message : 'Failed to load logs'
        s.entries = []
      }
    } finally {
      // The visible spinner is owned by the visible request that turned it on, so clear it in its
      // own finally regardless of supersession — a superseded load still ends its own spinner.
      if (!opts?.silent) s.loading = false
    }
  }

  /**
   * Drop a run's accumulated log state (called by the drawer on unmount). `byExecution` would
   * otherwise accrete one entry per execution viewed and never evict — a slow memory creep across
   * a long board session. The drawer re-fetches on re-mount, so dropping a closed run's state is
   * free; keeping it while OPEN is what the manual-refresh-after-terminal affordance relies on.
   */
  function evict(executionId: string) {
    delete byExecution[executionId]
    loadSeq.delete(executionId)
  }

  return { bySubsystem, byExecution, load, loadForExecution, evict }
})
