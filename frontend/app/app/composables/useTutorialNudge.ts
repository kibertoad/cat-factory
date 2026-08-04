import { ref, watch } from 'vue'
import { newlyAvailableTour, readyTourIds } from '~/utils/tutorial'

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
 * The rule itself is pure and lives in `newlyAvailableTour`; this is the reactive half plus the
 * one piece of state that cannot be pure: the BASELINE.
 *
 * Called once from `pages/index.vue`. Never suppresses anything itself — whether the offer may be
 * on screen right now is the component's business (`TutorialNudge.vue`), because the offer is
 * held rather than dropped while a tutorial window or a tour is up.
 */
export function useTutorialNudge() {
  const tutorial = useTutorialStore()
  const { catalogue } = useTutorialTours()

  /**
   * The ids that were already takeable last time we looked, so an offer fires on a TRANSITION
   * rather than on the standing state.
   *
   * Null until the first resolution, which SEEDS it and offers nothing. That first pass is not
   * an optimisation and not an edge case: on any board that has ever run something, most of the
   * catalog is ready at load, and firing on the standing state would greet the user with an
   * offer about a walkthrough that has been available for weeks. What this mechanism is for is
   * the moment something CHANGED.
   *
   * The baseline advances on every resolution, including the ones that produce a candidate, so a
   * tour that flickers ready → blocked → ready (which live run gates do) cannot re-offer itself.
   * `offerNudge` is idempotent against the persisted list anyway; this makes it cheap as well.
   */
  const previouslyReady = ref<Set<string> | null>(null)

  watch(
    catalogue,
    (entries) => {
      const ready = readyTourIds(entries)
      const baseline = previouslyReady.value
      previouslyReady.value = ready
      if (baseline === null) return
      const candidate = newlyAvailableTour({
        catalogue: entries,
        previouslyReady: baseline,
        declined: tutorial.decision === 'declined',
        isCompleted: (id) => tutorial.isCompleted(id),
        wasNudged: (id) => tutorial.wasNudged(id),
      })
      if (candidate) tutorial.offerNudge(candidate.id)
    },
    { immediate: true },
  )
}
