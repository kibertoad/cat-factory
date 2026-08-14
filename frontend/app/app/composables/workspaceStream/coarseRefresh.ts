/**
 * How the stream asks for a FULL resync: the on-(re)connect reconcile and the coarse `board`
 * event's debounced fan-out, which are the same operation reached two ways.
 *
 * Extracted from `useWorkspaceStream` (which keeps the socket lifecycle and the event routing) so
 * the scheduling rules below are unit-testable without a WebSocket. Every dependency is a bound
 * callback, so nothing here reaches for a store.
 */
export interface CoarseRefreshDeps {
  /** True once the stream has stopped: a scheduled pass stands down rather than firing. */
  readonly stopped: () => boolean
  /** The board the stream is bound to right now, or null before bootstrap. */
  readonly currentWorkspaceId: () => string | null
  /** `workspace.refresh()`: the one funnel every full-snapshot refresh goes through. */
  readonly refresh: () => Promise<void>
  /** The funnel's coverage mark, taken when a coarse event arrives. */
  readonly refreshMark: () => number
  /** Whether a snapshot fetch issued after `mark` has already hydrated. */
  readonly hydratedSince: (mark: number) => boolean
}

export interface CoarseRefresh {
  /**
   * Reconcile the board now, retrying a transient failure. Resolves once the board HAS been
   * reconciled, or once the attempts are spent; a caller may treat that as "safe to announce".
   */
  readonly withRetry: (workspaceId: string) => Promise<void>
  /** Schedule a debounced coarse resync (the `board`-event fan-out). */
  readonly schedule: () => void
  /** Drop any pending pass. */
  readonly cancel: () => void
}

// A coarse board refresh (the resync on reconnect, and the `board` event fan-out) must not be
// left silently stale by ONE transient failure: retry a few times with backoff so a blip
// self-heals. Bounded (the socket-level reconnect + the offline banner are the backstop for a
// genuine outage). Aborts between attempts if the stream stopped or the workspace switched.
const REFRESH_MAX_ATTEMPTS = 4

// The coarse-event debounce. Trailing, so a burst of `board` events costs one refresh, and
// CAPPED, because trailing alone re-armed the timer forever under a sustained sub-300ms stream:
// the board stopped resyncing exactly when the workspace was busiest. Past the cap the pending
// refresh fires on schedule and the next event starts a fresh window.
const BOARD_DEBOUNCE_MS = 300
const BOARD_DEBOUNCE_MAX_WAIT_MS = 2_000

export function createCoarseRefresh(deps: CoarseRefreshDeps): CoarseRefresh {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // A chain stands down when a NEWER one has started: the backoff sleeps run for seconds, so a
  // sustained event stream used to leave several chains alive at once, each still issuing full
  // snapshot fetches for a resync a later chain had already superseded.
  //
  // Standing down HANDS THE CALLER THE NEWER CHAIN rather than resolving, because the socket's
  // `onopen` announces `connected` off this promise: resolving on supersession would announce a
  // board whose reconcile is still in flight, which is the stale-readiness bug the
  // resync-before-announce ordering exists to prevent. A stood-down chain always awaits a STRICTLY
  // newer one, so the wait terminates at whichever chain is newest.
  let chainCount = 0
  let newest: Promise<void> = Promise.resolve()

  function withRetry(workspaceId: string): Promise<void> {
    const chain = ++chainCount
    const run = drive(workspaceId, chain)
    newest = run
    return run
  }

  async function drive(workspaceId: string, chain: number): Promise<void> {
    for (let i = 0; i < REFRESH_MAX_ATTEMPTS; i++) {
      if (deps.stopped() || deps.currentWorkspaceId() !== workspaceId) return
      if (chain !== chainCount) return newest
      try {
        await deps.refresh()
        return
      } catch {
        if (i < REFRESH_MAX_ATTEMPTS - 1) await sleep(Math.min(4_000, 400 * 2 ** i))
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let windowStart = 0
  // The funnel's coverage mark as of the LATEST coarse event in this window. A snapshot fetch
  // issued after that event necessarily contains what the event announced (the server emits it
  // after committing), so if one has already hydrated by the time the timer fires there is nothing
  // left to resync. This is what stops a mutation that refreshes directly AND raises a coarse
  // event from paying for two full snapshots.
  let coverageMark = 0

  function schedule() {
    const workspaceId = deps.currentWorkspaceId()
    if (!workspaceId) return
    const now = Date.now()
    coverageMark = deps.refreshMark()
    if (timer) clearTimeout(timer)
    else windowStart = now
    const wait = Math.max(
      0,
      Math.min(BOARD_DEBOUNCE_MS, windowStart + BOARD_DEBOUNCE_MAX_WAIT_MS - now),
    )
    timer = setTimeout(() => {
      timer = null
      if (deps.hydratedSince(coverageMark)) return
      void withRetry(workspaceId)
    }, wait)
  }

  /**
   * `timer` is NULLED, not just cleared: it is what says "a window is open", so a stale handle left
   * behind here would make the first event of the next session inherit the previous session's
   * window start, whose max-wait has long since expired, and fire a full snapshot fetch immediately
   * with no debounce at all.
   */
  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { withRetry, schedule, cancel }
}
