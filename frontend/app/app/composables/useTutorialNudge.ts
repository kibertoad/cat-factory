import { ref, watch } from 'vue'
import { resolveNudge } from '~/utils/tutorial'

/**
 * The contextual offer: watch the resolved tour catalogue and hold out the ONE walkthrough that
 * just became takeable.
 *
 * This is the half of the tutorial the catalogue could not fix. The catalogue made every tour
 * reachable, but nothing brings one UP: starting any tour saves `decision: 'accepted'`, which is
 * what stops the launch prompt auto-opening again, so after a user's first tour the product never
 * mentions the tutorial unless they go looking. The two walkthroughs that matter most are also
 * the two that are only available inside a transient window — `answer-park` while something is
 * actually waiting for a human, `review-merge` once a run has produced something to merge — so
 * "go and look" and "be available" rarely coincide.
 *
 * The rule itself is pure and lives in `resolveNudge` (over `newlyAvailableTour`); this is the
 * reactive half and nothing more. That split is deliberate: the one piece of state here that
 * cannot be pure is the BASELINE, and a wrong baseline silently converts a moment-triggered offer
 * into an every-board-load greeting, which is the failure this mechanism is supposed to be the
 * cure for.
 *
 * Called once from `pages/index.vue`. Never suppresses anything itself — whether the offer may be
 * on screen right now is the component's business (`TutorialNudge.vue`), because the offer is
 * held rather than dropped while a tutorial window or a tour is up.
 */
export function useTutorialNudge() {
  const tutorial = useTutorialStore()
  const workspace = useWorkspaceStore()
  const { catalogue } = useTutorialTours()

  /**
   * The ids that were already takeable last time we looked, so an offer fires on a TRANSITION
   * rather than on the standing state. `null` = no baseline yet (never seeded, or the board went
   * away and the next one must seed its own).
   *
   * `resolveNudge` decides when this is seeded, advanced and discarded; the only reason it lives
   * out here is that a pure function cannot hold it.
   */
  const previouslyReady = ref<Set<string> | null>(null)

  watch(
    // `workspace.ready` is what makes the baseline mean anything. Every board-state requirement a
    // tour declares reads a store the workspace SNAPSHOT fills, so before `ready` they are all
    // false, and a baseline seeded then records "nothing is takeable" — leaving the board's own
    // hydration to read as a transition. `ready` is also re-set to false per board, which is what
    // makes switching boards re-seed instead of offering everything the new board satisfies.
    () => [catalogue.value, workspace.ready] as const,
    ([entries, boardReady]) => {
      const { baseline, offer } = resolveNudge({
        boardReady,
        catalogue: entries,
        previouslyReady: previouslyReady.value,
        declined: tutorial.decision === 'declined',
        isCompleted: (id) => tutorial.isCompleted(id),
        wasNudged: (id) => tutorial.wasNudged(id),
      })
      previouslyReady.value = baseline
      if (offer) tutorial.offerNudge(offer.id)
    },
    { immediate: true },
  )
}
