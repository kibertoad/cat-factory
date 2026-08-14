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
 * resolve out of order. A board SWITCH is the one thing that outdates a request rather than
 * ordering it, so it is checked twice: an arrived snapshot for a board nothing is showing is
 * discarded, and a queued follow-up for such a board is never issued (it would fetch the CURRENT
 * board on a caller that asked about the old one, and report that as its answer).
 *
 * SERIALIZING MAKES A STALL EVERYONE'S PROBLEM, which is why the slot is bounded: see
 * {@link SNAPSHOT_DEADLINE_MS}.
 */
export interface RefreshFunnelDeps {
  /** The active workspace id, or null before bootstrap. Read fresh on each attempt. */
  readonly currentWorkspaceId: () => string | null
  /** Read the snapshot. `signal` aborts on the deadline, so a stalled request is released. */
  readonly fetchSnapshot: (workspaceId: string, signal: AbortSignal) => Promise<WorkspaceSnapshot>
  /**
   * Capture the live-write baselines BEFORE the fetch: anything a live event writes while this
   * (potentially slow) snapshot is in flight is newer than the snapshot, so the hydrate must not
   * clobber it back.
   */
  readonly captureBaselines: () => LiveWriteBaselines
  readonly apply: (snapshot: WorkspaceSnapshot, baselines: LiveWriteBaselines) => void
  /** Override the deadline below. Exists for the tests; production takes the default. */
  readonly deadlineMs?: number
}

/**
 * How long the funnel holds its one slot before giving up on a fetch.
 *
 * The snapshot read goes through the shared wretch client, which sets no timeout, so a stalled
 * connection (a dropped mobile or VPN link) leaves a GET pending without ever rejecting. With every
 * refresh serialized behind one slot, that single stall would wedge the whole path: no later fetch
 * is issued, the coarse-event resync stops running, the stream's bounded retry never sees a failure
 * to retry, and every awaited `refresh()` hangs its caller forever. A deadline turns it into an
 * ordinary failure all three can act on. It ABORTS as well as abandons, so the stalled request is
 * released rather than left to answer into nothing, and a snapshot that lands after the deadline is
 * never applied: the funnel has already moved on, and its baselines are that much staler.
 *
 * Sized well above a slow-but-real snapshot (the aggregate is ~20 reads) so it only ever fires on a
 * connection that is not coming back.
 */
const SNAPSHOT_DEADLINE_MS = 30_000

export interface RefreshFunnel {
  /** Re-fetch the snapshot and re-hydrate, coalesced as described above. */
  readonly refresh: () => Promise<void>
  /** A token to compare against later: how many snapshot fetches have STARTED. */
  readonly refreshMark: () => number
  /** Whether a snapshot fetch issued after `mark` has already hydrated. */
  readonly hydratedSince: (mark: number) => boolean
}

export function createRefreshFunnel(deps: RefreshFunnelDeps): RefreshFunnel {
  const deadlineMs = deps.deadlineMs ?? SNAPSHOT_DEADLINE_MS
  let starts = 0
  let lastHydratedStart = 0
  let inFlight: Promise<void> | null = null
  /**
   * The one queued follow-up, tagged with the board it was queued FOR. A caller joins it only when
   * it asks about the same board: after a switch mid-fetch, a caller asking about the NEW board must
   * be neither served nor stood down by a follow-up queued for the old one.
   */
  let queued: { readonly targetId: string; readonly promise: Promise<void> } | null = null

  /** Read the snapshot under the deadline, aborting the request when it expires. */
  async function fetchSnapshot(targetId: string): Promise<WorkspaceSnapshot> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<WorkspaceSnapshot>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`Board snapshot fetch timed out after ${deadlineMs}ms`))
        }, deadlineMs)
        deps.fetchSnapshot(targetId, controller.signal).then(resolve, reject)
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchAndApply(targetId: string): Promise<void> {
    const start = ++starts
    const baselines = deps.captureBaselines()
    const snapshot = await fetchSnapshot(targetId)
    // The active board switched while this fetch was in flight: its snapshot describes a board
    // nothing is showing, so applying it would replace the new board's state with the old one's.
    if (deps.currentWorkspaceId() !== targetId) return
    deps.apply(snapshot, baselines)
    lastHydratedStart = start
  }

  function refresh(): Promise<void> {
    const targetId = deps.currentWorkspaceId()
    if (!targetId) return Promise.resolve()
    if (!inFlight) {
      inFlight = fetchAndApply(targetId).finally(() => {
        inFlight = null
      })
      return inFlight
    }
    if (queued?.targetId === targetId) return queued.promise
    // A fetch is already running and may predate this caller's write, so hand back a follow-up
    // that starts after it rather than its result. One follow-up serves every caller that arrives
    // during this fetch asking about the same board. `settle` swallows only the ORDERING dependency
    // on the current attempt: the failure itself already reached that attempt's own caller, and
    // this caller gets the outcome of the fresh fetch below.
    const promise = inFlight.then(settle, settle).then(() => {
      if (queued?.promise === promise) queued = null
      // The board switched while this follow-up waited. Fetching now would read the CURRENT
      // board's snapshot on behalf of a caller that asked about the old one, hydrate it beside
      // the switch's own hydrate, and resolve as though the board it asked about had refreshed.
      if (deps.currentWorkspaceId() !== targetId) return
      return refresh()
    })
    queued = { targetId, promise }
    return promise
  }

  return {
    refresh,
    refreshMark: () => starts,
    hydratedSince: (mark) => lastHydratedStart > mark,
  }
}

/** Resolve regardless of how the awaited attempt ended: this chain sequences, it does not report. */
function settle(): void {}
