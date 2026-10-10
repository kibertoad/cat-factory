import { ref, watch } from 'vue'
import { boardStateFingerprint, resolveNudge } from '~/utils/tutorial'
import { createSharedComposables } from '@modular-vue/vue'
import type { AppDeps } from '~/modular/registry'

const { useOptional } = createSharedComposables<AppDeps>()

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
  // The same registered `gates` service the catalogue resolves against, so the fingerprint below
  // can never describe a different board than the availability it is paired with. `useOptional`
  // for the bare-install case the nav filter also allows: no gates means no board state to move,
  // so the offer simply never fires.
  const gates = useOptional('gates')

  /**
   * What the last look saw: which tours were takeable, and the board-state stamp they went with.
   * `null` = no baseline yet (never seeded, or the board went away and the next one must seed its
   * own).
   *
   * `resolveNudge` decides when this is seeded, advanced and discarded; the only reason it lives
   * out here is that a pure function cannot hold it.
   */
  const previous = ref<{ ready: ReadonlySet<string>; boardState: string } | null>(null)

  watch(
    // Two inputs beyond the catalogue, and each closes a different half of the "the app starting up
    // is not a moment" problem. `workspace.ready` gates taking a baseline at all on the snapshot
    // having landed, and is re-set per board so a SWITCH re-seeds. The board-state fingerprint is
    // what an offer requires to have moved, so the permissions and capability probes that resolve
    // after `ready` widen availability without being mistaken for something the user did.
    () =>
      [catalogue.value, workspace.ready, gates.value ? boardStateFingerprint(gates.value) : ''] as [
        typeof catalogue.value,
        boolean,
        string,
      ],
    ([entries, boardReady, boardState]) => {
      const { baseline, offer } = resolveNudge({
        boardReady,
        catalogue: entries,
        boardState,
        previous: previous.value,
        declined: tutorial.decision === 'declined',
        isCompleted: (id) => tutorial.isCompleted(id),
        wasNudged: (id) => tutorial.wasNudged(id),
      })
      previous.value = baseline
      if (offer) tutorial.offerNudge(offer.id)
    },
    { immediate: true },
  )
}
