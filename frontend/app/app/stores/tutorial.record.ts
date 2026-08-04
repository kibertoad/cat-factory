import { ref } from 'vue'

/** The launch-prompt answer. `null` = never answered, so the app asks again next launch. */
export type TutorialDecision = 'accepted' | 'declined'

/** The server's copy of a user's record, as the snapshot delivers it. */
export interface RemoteTutorialRecord {
  decision: TutorialDecision | null
  completedTourIds: readonly string[]
  nudgedTourIds: readonly string[]
}

/**
 * The PERSISTED tier of the tutorial's state: the standing record of what this PERSON has done.
 *
 * Extracted from `stores/tutorial.ts` along the boundary that store's own docblock already draws.
 * Everything here outlives a visit and is mirrored to the signed-in user's server row; everything
 * left behind (the prompt, the catalogue, the step cursor, the resume point, which offer is on
 * screen) is session state that a reload is right to discard. Splitting on that line also put every
 * piece of the sync story in one module: the union rule, what counts as "this browser knows more",
 * and the flag the mirror acts on.
 *
 * A factory rather than a second Pinia store, because the two tiers are one store's worth of state
 * to every consumer: the returned refs go straight into the setup store's state, so
 * `persist: { pick: [...] }` and every existing `tutorial.completedTourIds` read are unchanged.
 */
export function createTutorialRecord() {
  /** The saved launch-prompt answer. Written only by an explicit accept/decline/reset. */
  const decision = ref<TutorialDecision | null>(null)
  /** Ids of tours the user finished (reached the last step's Done). */
  const completedTourIds = ref<string[]>([])
  /**
   * Ids the CONTEXTUAL offer has already been spent on (see `newlyAvailableTour`). Persisted beside
   * the completions, because "we have mentioned this once" is a fact about the person, not about
   * this visit: re-offering the parked-run walkthrough on every reload is a nag, and the gates it
   * watches flip several times per run.
   */
  const nudgedTourIds = ref<string[]>([])
  /**
   * This browser holds progress the server row does not, so the mirror owes it a write.
   *
   * Session-lived and a FLAG rather than a direct call, because the merge below runs inside the
   * snapshot fan-out, which is synchronous and store-only. `useTutorialSync` watches it.
   */
  const serverPushNeeded = ref(false)

  const isCompleted = (tourId: string) => completedTourIds.value.includes(tourId)
  const wasNudged = (tourId: string) => nudgedTourIds.value.includes(tourId)

  /** Record a finished walkthrough. Idempotent: the same tour taken twice is still one entry. */
  function markCompleted(tourId: string) {
    if (!isCompleted(tourId)) completedTourIds.value = [...completedTourIds.value, tourId]
  }

  /** Spend the contextual offer for a tour. Idempotent, so an offer can never be made twice. */
  function markNudged(tourId: string) {
    if (!wasNudged(tourId)) nudgedTourIds.value = [...nudgedTourIds.value, tourId]
  }

  /** Starting a tour IS accepting the tutorial, however the user got there. */
  function acceptOffer() {
    decision.value = 'accepted'
  }

  /** The explicit "no thanks": saved, so the launch prompt never auto-opens again. */
  function declineOffer() {
    decision.value = 'declined'
  }

  /**
   * Fold the signed-in user's SERVER copy into this browser's, and report whether the local copy
   * held anything the server did not.
   *
   * A union rather than a replace, in the same direction and for the same reason the server merges:
   * both lists are grow-only sets of things that HAPPENED, so neither side is ever right to un-say
   * one. A replace here would lose a tour finished while the mirror write was failing; a replace on
   * the server would lose a tour finished on another machine. Only `decision` is taken from the
   * server when it HAS one, because that is a preference someone re-answers rather than an
   * accumulating fact, and the server row is the shared record of the latest answer — while a server
   * row with no answer is not evidence that the local answer never happened.
   *
   * The return value closes the loop: `true` means this browser knows something the server does not,
   * so the merged state is worth pushing back. Recomputing that comparison at the call site would be
   * a second copy of the union rule.
   */
  function mergeServerProgress(remote: RemoteTutorialRecord | null): boolean {
    // No server copy at all (no accounts, no store wired, or the read degraded) is NOT a reason to
    // push: there is nothing to reconcile against, and treating an absent row as an empty one would
    // make every such board load write a mirror nothing reads.
    if (!remote) return false
    const union = (mine: string[], theirs: readonly string[]) => [...new Set([...theirs, ...mine])]
    const completed = union(completedTourIds.value, remote.completedTourIds)
    const nudged = union(nudgedTourIds.value, remote.nudgedTourIds)
    const localOnly =
      completed.length > remote.completedTourIds.length ||
      nudged.length > remote.nudgedTourIds.length ||
      (remote.decision === null && decision.value !== null)
    completedTourIds.value = completed
    nudgedTourIds.value = nudged
    if (remote.decision !== null) decision.value = remote.decision
    if (localOnly) serverPushNeeded.value = true
    return localOnly
  }

  /** The mirror has caught up; stop asking for a push. */
  function markServerPushed() {
    serverPushNeeded.value = false
  }

  /**
   * Forget the whole record, including the answered offer.
   *
   * The decision goes with it deliberately: "Reset" is asked for by someone handing the app to a
   * colleague, demoing it, or re-walking the product after it changed, and every one of those wants
   * the first-launch experience back, which a cleared completion list alone does not restore. The
   * spent contextual offers go too, or a board that has already run something would never make
   * those offers again to the colleague the app was just handed to.
   */
  function reset() {
    completedTourIds.value = []
    nudgedTourIds.value = []
    decision.value = null
  }

  return {
    decision,
    completedTourIds,
    nudgedTourIds,
    serverPushNeeded,
    isCompleted,
    wasNudged,
    markCompleted,
    markNudged,
    acceptOffer,
    declineOffer,
    mergeServerProgress,
    markServerPushed,
    reset,
  }
}
