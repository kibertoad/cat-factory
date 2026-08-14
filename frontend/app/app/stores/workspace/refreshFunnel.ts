import type { WorkspaceSnapshot } from '~/types/domain'
import type { LiveWriteBaselines } from '~/stores/workspace/hydrate'

/**
 * The one door every full-snapshot refresh goes through.
 *
 * WHY A FUNNEL. `workspace.refresh()` is the client's heaviest operation: a ~20-read snapshot
 * aggregate on the server, then 31 hydrate calls into 24 stores. Roughly 35 call sites reach for it
 * directly after a mutation, and the event stream schedules its own on every coarse `board` event,
 * so the paths that produce the most events are exactly the paths that stacked the most redundant
 * snapshots. Making the funnel the FUNCTION every caller already calls is what lets those call
 * sites stay as they are: there is nothing for a new mutation to remember to opt into.
 *
 * THE COALESCING RULE, and why it is not plain single-flight. A caller that awaits `refresh()`
 * after its own mutation is entitled to a snapshot that INCLUDES that mutation. Handing it the
 * promise of a fetch already in flight would break that: the in-flight request may have been issued
 * before the mutation committed. So a call arriving during a fetch does not join it, it joins a
 * SINGLE queued follow-up that starts once the current one settles. Any number of callers during
 * one slow fetch therefore cost one extra fetch between them, never one each, and every caller
 * still observes a snapshot read after it called.
 *
 * THE COVERAGE MARK. A coarse `board` event means "something changed, resync", and a snapshot whose
 * fetch was ISSUED after that event arrived necessarily contains the change (the server emits the
 * event after committing it). {@link RefreshFunnel.refreshMark} + {@link RefreshFunnel.hydratedSince}
 * let the stream's debounce ask exactly that question and drop a refresh some mutation's own
 * `refresh()` already covered, which is the duplicate the direct call sites otherwise pay twice.
 * The mark counts fetches STARTED and only a fetch that actually HYDRATED advances the answer, so a
 * discarded or failed one never reads as coverage.
 *
 * Ordering needs no sequence guard: at most one fetch is ever in flight, so two snapshots cannot
 * resolve out of order. The workspace-id check remains, because a board SWITCH during a fetch makes
 * the result answer a question nobody is asking any more.
 */
export interface RefreshFunnelDeps {
  /** The active workspace id, or null before bootstrap. Read fresh on each attempt. */
  readonly currentWorkspaceId: () => string | null
  readonly fetchSnapshot: (workspaceId: string) => Promise<WorkspaceSnapshot>
  /**
   * Capture the live-write baselines BEFORE the fetch: anything a live event writes while this
   * (potentially slow) snapshot is in flight is newer than the snapshot, so the hydrate must not
   * clobber it back.
   */
  readonly captureBaselines: () => LiveWriteBaselines
  readonly apply: (snapshot: WorkspaceSnapshot, baselines: LiveWriteBaselines) => void
}

export interface RefreshFunnel {
  /** Re-fetch the snapshot and re-hydrate, coalesced as described above. */
  readonly refresh: () => Promise<void>
  /** A token to compare against later: how many snapshot fetches have STARTED. */
  readonly refreshMark: () => number
  /** Whether a snapshot fetch issued after `mark` has already hydrated. */
  readonly hydratedSince: (mark: number) => boolean
}

export function createRefreshFunnel(deps: RefreshFunnelDeps): RefreshFunnel {
  let starts = 0
  let lastHydratedStart = 0
  let inFlight: Promise<void> | null = null
  let queued: Promise<void> | null = null

  async function fetchAndApply(): Promise<void> {
    const targetId = deps.currentWorkspaceId()
    if (!targetId) return
    const start = ++starts
    const baselines = deps.captureBaselines()
    const snapshot = await deps.fetchSnapshot(targetId)
    // The active board switched while this fetch was in flight: its snapshot describes a board
    // nothing is showing, so applying it would replace the new board's state with the old one's.
    if (deps.currentWorkspaceId() !== targetId) return
    deps.apply(snapshot, baselines)
    lastHydratedStart = start
  }

  function refresh(): Promise<void> {
    if (!inFlight) {
      const run = fetchAndApply().finally(() => {
        if (inFlight === run) inFlight = null
      })
      inFlight = run
      return run
    }
    // A fetch is already running and may predate this caller's write, so hand back a follow-up
    // that starts after it rather than its result. One follow-up serves every caller that arrives
    // during this fetch. `settle` swallows only the ORDERING dependency on the current attempt:
    // the failure itself already reached that attempt's own caller, and this caller gets the
    // outcome of the fresh fetch below.
    queued ??= inFlight.then(settle, settle).then(() => {
      queued = null
      return refresh()
    })
    return queued
  }

  return {
    refresh,
    refreshMark: () => starts,
    hydratedSince: (mark) => lastHydratedStart > mark,
  }
}

/** Resolve regardless of how the awaited attempt ended: this chain sequences, it does not report. */
function settle(): void {}
