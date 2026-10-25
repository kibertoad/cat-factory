import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { ProvisioningLogEntry, ProvisioningSubsystem } from '~/types/provisioningLogs'
import { useWorkspaceStore } from '~/stores/workspace'

interface LogState {
  entries: ProvisioningLogEntry[]
  loading: boolean
  error: string | null
}

interface RunRecord {
  mounts: number
  latest: number
  latestVisible: number
  visiblePending: boolean
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
  // Per-run bookkeeping the UI never reads, so NOT reactive. It lives and dies with the run's
  // `byExecution` entry: a load holds the record it started with, so after `release` drops a run
  // its stragglers write only to the detached state and record, never to a re-opened drawer's.
  //   - `mounts`: how many drawers show the run. Two surfaces can show one run at once, so the
  //     entry goes only when the last one releases it.
  //   - `latest`: the newest load ticket. The silent poll and a visible refresh can be in flight at
  //     once, each ending in a REPLACE-style `s.entries = entries`, so only the newest commits and a
  //     slower, staler fetch never clobbers a fresher timeline.
  //   - `latestVisible` / `visiblePending`: the newest visible load, and whether it is still in
  //     flight. It owns the spinner, and a silent poll never supersedes it.
  const runs = new Map<string, RunRecord>()
  const EMPTY: Readonly<LogState> = Object.freeze(emptyState())

  function ensureRun(executionId: string) {
    // Read the state back through the map: an assignment expression yields the raw object, and
    // writes to it would not reach the drawer (#2394).
    byExecution[executionId] ??= emptyState()
    let record = runs.get(executionId)
    if (!record) {
      record = { mounts: 0, latest: 0, latestVisible: 0, visiblePending: false }
      runs.set(executionId, record)
    }
    return { s: byExecution[executionId], record }
  }

  /** A run's log state for a reader, or a frozen empty state before its first load. */
  function stateFor(executionId: string): Readonly<LogState> {
    return byExecution[executionId] ?? EMPTY
  }

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
   * an error banner. The visible refresh path (initial open / manual refresh) owns those, so a
   * poll that fires while a visible load is in flight is skipped: superseding it would discard
   * the visible result and leave the drawer empty if the poll then failed.
   */
  async function loadForExecution(executionId: string, opts?: { silent?: boolean }) {
    const ws = useWorkspaceStore()
    const { s, record } = ensureRun(executionId)
    if (opts?.silent && record.visiblePending) return
    const seq = ++record.latest
    if (!opts?.silent) {
      record.latestVisible = seq
      record.visiblePending = true
      s.loading = true
      s.error = null
    }
    try {
      const { entries } = await api.listProvisioningLogs(ws.requireId(), {
        executionId,
        limit: 200,
      })
      // A newer load superseded this one while it was in flight: discard this staler result so it
      // can't clobber the fresher timeline.
      if (record.latest !== seq) return
      s.entries = entries
      s.error = null
    } catch (err) {
      if (record.latest !== seq) return
      // A background poll keeps the last snapshot on a blip; only a visible load reports.
      if (!opts?.silent) {
        s.error = err instanceof Error ? err.message : 'Failed to load logs'
        s.entries = []
      }
    } finally {
      // Only the newest visible load ends the spinner: an older one resolving first would show the
      // empty state while the newer one is still on its way.
      if (record.latestVisible === seq) {
        record.visiblePending = false
        s.loading = false
      }
    }
  }

  /** A drawer starts showing a run. Pair every call with `release`. */
  function retain(executionId: string) {
    ensureRun(executionId).record.mounts++
  }

  /**
   * A drawer stops showing a run. The last release drops the run's state, so `byExecution` does
   * not grow by one entry per run viewed across a long board session; a drawer re-fetches when it
   * opens again.
   */
  function release(executionId: string) {
    const record = runs.get(executionId)
    if (!record || --record.mounts > 0) return
    delete byExecution[executionId]
    runs.delete(executionId)
  }

  return { bySubsystem, byExecution, stateFor, load, loadForExecution, retain, release }
})
