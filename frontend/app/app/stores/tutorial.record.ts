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
  /**
   * Counts LOCAL changes to this record, and nothing else. Session-lived.
   *
   * The mirror watches this rather than the state itself, and the distinction is the whole reason
   * it exists: adopting the server's ids in {@link mergeServerProgress} also changes the state, so
   * a watcher over the state pushes the server's own row straight back at it on every fresh-browser
   * board load. Counting only what the USER did means a write happens exactly when this browser has
   * something to say.
   */
  const localRev = ref(0)
  /**
   * The local `decision` has changed and has not been mirrored yet, so it must survive a snapshot.
   *
   * Without this, a failed mirror write silently UNDOES the user's answer: they click "No thanks",
   * the push fails, and the next snapshot re-adopts the older `accepted` from the server row,
   * re-arming every contextual offer they just declined. The server row wins on `decision` because
   * it is the shared record of the latest answer, but only where this browser is not itself holding
   * a newer one that the server has not seen.
   */
  const decisionDirty = ref(false)

  const isCompleted = (tourId: string) => completedTourIds.value.includes(tourId)
  const wasNudged = (tourId: string) => nudgedTourIds.value.includes(tourId)

  /** Record a finished walkthrough. Idempotent: the same tour taken twice is still one entry. */
  function markCompleted(tourId: string) {
    if (isCompleted(tourId)) return
    completedTourIds.value = [...completedTourIds.value, tourId]
    localRev.value += 1
  }

  /** Spend the contextual offer for a tour. Idempotent, so an offer can never be made twice. */
  function markNudged(tourId: string) {
    if (wasNudged(tourId)) return
    nudgedTourIds.value = [...nudgedTourIds.value, tourId]
    localRev.value += 1
  }

  /** Record an answer to the launch prompt, and ask the mirror to carry it. */
  function answer(next: TutorialDecision) {
    if (decision.value === next) return
    decision.value = next
    decisionDirty.value = true
    localRev.value += 1
  }

  /** Starting a tour IS accepting the tutorial, however the user got there. */
  function acceptOffer() {
    answer('accepted')
  }

  /** The explicit "no thanks": saved, so the launch prompt never auto-opens again. */
  function declineOffer() {
    answer('declined')
  }

  /**
   * Fold the signed-in user's SERVER copy into this browser's, and report whether the local copy
   * held anything the server did not.
   *
   * A union rather than a replace, in the same direction and for the same reason the server merges:
   * both lists are grow-only sets of things that HAPPENED, so neither side is ever right to un-say
   * one. A replace here would lose a tour finished while the mirror write was failing; a replace on
   * the server would lose a tour finished on another machine. `decision` is taken from the server
   * when it HAS one and this browser is not holding an un-mirrored answer of its own
   * ({@link decisionDirty}), because it is a preference someone re-answers rather than an
   * accumulating fact — while a server row with no answer is not evidence that the local answer
   * never happened.
   *
   * The return value closes the loop: `true` means this browser knows something the server does not,
   * so the merged state is worth pushing back. Recomputing that comparison at the call site would be
   * a second copy of the union rule. It is also what makes the server's un-guarded merge safe: the
   * PUT's response goes through here too, so a merge that lost a concurrent writer's ids comes back
   * missing something local, and the re-push is automatic rather than hoped for.
   */
  function mergeServerProgress(remote: RemoteTutorialRecord | null): boolean {
    // No server copy at all (no accounts, no store wired, or the read degraded) is NOT a reason to
    // push: there is nothing to reconcile against, and treating an absent row as an empty one would
    // make every such board load write a mirror nothing reads.
    if (!remote) return false
    const union = (mine: string[], theirs: readonly string[]) => [...new Set([...theirs, ...mine])]
    const completed = union(completedTourIds.value, remote.completedTourIds)
    const nudged = union(nudgedTourIds.value, remote.nudgedTourIds)
    const keepLocalDecision = decisionDirty.value || remote.decision === null
    const localOnly =
      completed.length > remote.completedTourIds.length ||
      nudged.length > remote.nudgedTourIds.length ||
      (keepLocalDecision && decision.value !== remote.decision)
    completedTourIds.value = completed
    nudgedTourIds.value = nudged
    if (!keepLocalDecision) decision.value = remote.decision
    if (localOnly) serverPushNeeded.value = true
    return localOnly
  }

  /**
   * The mirror has caught up: this browser's state is on the server, including its answer.
   *
   * Called BEFORE the response is reconciled, so that a response missing something local can flip
   * {@link serverPushNeeded} back on and re-trigger the watcher. Clearing it after would look
   * identical and would swallow exactly the retry that matters.
   */
  function markServerPushed() {
    serverPushNeeded.value = false
    decisionDirty.value = false
  }

  /**
   * Forget the whole record, including the answered offer.
   *
   * The decision goes with it deliberately: "Reset" is asked for by someone handing the app to a
   * colleague, demoing it, or re-walking the product after it changed, and every one of those wants
   * the first-launch experience back, which a cleared completion list alone does not restore. The
   * spent contextual offers go too, or a board that has already run something would never make
   * those offers again to the colleague the app was just handed to.
   *
   * Deliberately does NOT bump {@link localRev}, and cancels any pending mirror write. The server
   * side of a reset is a DELETE, and a PUT of the freshly-emptied state racing it would re-create
   * the row the DELETE just removed — leaving "reset it" distinguishable from "never touched the
   * tutorial", which is the one thing the reset has to get right.
   */
  function reset() {
    completedTourIds.value = []
    nudgedTourIds.value = []
    decision.value = null
    serverPushNeeded.value = false
    decisionDirty.value = false
  }

  return {
    decision,
    completedTourIds,
    nudgedTourIds,
    serverPushNeeded,
    localRev,
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
