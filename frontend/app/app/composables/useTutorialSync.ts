import { watch } from 'vue'

/**
 * The tutorial's server calls, with no watchers attached — safe to call from anywhere, as many
 * times as you like.
 *
 * Split from {@link useTutorialSync} for exactly that reason: the catalogue's "Reset progress"
 * button needs the DELETE, and reaching it through the composable that installs the mirror watchers
 * would install a second set of them every time the catalogue mounted.
 *
 * Everything here is BEST-EFFORT and nothing throws into a caller. That is the design rather than a
 * shortcut: the browser-persisted store stays the source the SPA reads and stays fully functional on
 * a deployment with no accounts, with no progress store wired, or offline. A failed mirror costs a
 * re-offer on another machine; it must never cost the walkthrough the user is taking.
 */
export function useTutorialServer() {
  const tutorial = useTutorialStore()
  const api = useApi()

  /**
   * Push the local state to the server. The endpoint MERGES, so a retry, a racing write from
   * another tab, and a stale copy are all harmless — which is what makes fire-and-forget correct
   * here rather than merely convenient.
   */
  function push() {
    void api
      .updateTutorialProgress({
        decision: tutorial.decision,
        completedTourIds: [...tutorial.completedTourIds],
        nudgedTourIds: [...tutorial.nudgedTourIds],
      })
      .then(() => tutorial.markServerPushed())
      .catch(() => {
        // silent-catch-ok: the local store is authoritative for this session and the next board
        // load re-runs the whole reconciliation, so there is nothing to report and nothing a user
        // could act on. (The SPA has no logger seam — see CLAUDE.md's silent-catch scope.)
      })
  }

  /** Count one funnel event. */
  function recordEvent(event: 'started' | 'completed' | 'abandoned', tourId: string) {
    void api.recordTutorialEvent({ event, tourId }).catch(() => {
      // silent-catch-ok: a dropped metric is a dropped metric. Failing a walkthrough over one, or
      // retrying it, would both be worse than the missing data point.
    })
  }

  /** Clear the server row too, so "Reset progress" is not undone by the next snapshot. */
  function resetServerProgress() {
    void api.resetTutorialProgress().catch(() => {
      // silent-catch-ok: the local reset already happened. The failure mode is that the next
      // snapshot restores the server copy, which is the state the user just left.
    })
  }

  return { push, recordEvent, resetServerProgress }
}

/**
 * Mirror the tutorial's persisted state to the signed-in user's server row, and count the funnel.
 *
 * Two things a browser-only store could not do, both of which the in-app-tutorial tracker left
 * open:
 *
 *  - progress that follows the PERSON. Client-persisted only, a second machine re-asks the launch
 *    question and re-makes every contextual offer, because "which walkthroughs have I finished" was
 *    a fact about a browser profile.
 *  - MEASUREMENT. Whether the catalogue is found and whether a tour is FINISHED was unmeasured, so
 *    every further slice of this feature was chosen on a guess.
 *
 * Called once, from `pages/index.vue`.
 */
export function useTutorialSync() {
  const tutorial = useTutorialStore()
  const { push, recordEvent } = useTutorialServer()

  // The adoption half runs in the snapshot fan-out (`stores/workspace/hydrate.ts` →
  // `mergeServerProgress`), which is where every other per-user slice is hydrated and, crucially,
  // early enough that the launch prompt decides whether to appear against the merged state rather
  // than against this browser's copy alone. All that is left here is the write-back it asks for.
  watch(
    () => tutorial.serverPushNeeded,
    (needed) => {
      if (needed) push()
    },
    { immediate: true },
  )

  // Every later local change is mirrored. Watching the STATE rather than wrapping each action keeps
  // this a single seam as the store grows: a new action that records a completion is covered by
  // being a state change, where a hand-wired call per action is one more place to forget.
  watch(
    () => [tutorial.decision, tutorial.completedTourIds.length, tutorial.nudgedTourIds.length],
    (_next, previous) => {
      // Skip the watcher's own first run: nothing has changed yet, and pushing here would write
      // this browser's copy before the snapshot has had a chance to bring the server's.
      if (previous !== undefined) push()
    },
  )

  /**
   * Derive the funnel events from the cursor rather than emitting them from each action.
   *
   * One watcher instead of calls in `startTour` / `resumeTour` / `stopTour` / `completeTour` /
   * `takeNextTour`, because those are five sites and a sixth is one refactor away — and a missing
   * `started` does not fail anything, it just quietly biases the number the rest of this feature
   * will be planned against.
   *
   * Vue batches, which is what makes the derivation work across the finish card's handoff: that
   * completes one tour and starts the next in a single tick, so the cursor goes `A → null → B` and
   * this sees `A → B` with the completion list one longer. It reports "A completed, B started",
   * which is what happened. A plain Skip is `A → null` with the list unchanged: abandoned.
   *
   * A RESUME counts as a start. That is a deliberate reading, not an oversight: from the funnel's
   * point of view an attempt is an attempt, and the alternative (silently not counting re-entries)
   * would make completions exceed starts for anyone who breaks off and comes back.
   */
  watch(
    () => [tutorial.activeTourId, tutorial.completedTourIds.length] as const,
    ([activeId, completedCount], previous) => {
      if (previous === undefined) return
      const [previousId, previousCount] = previous
      if (activeId === previousId) return
      if (previousId !== null) {
        const finished = completedCount > previousCount
        recordEvent(finished ? 'completed' : 'abandoned', previousId)
      }
      if (activeId !== null) recordEvent('started', activeId)
    },
  )
}
