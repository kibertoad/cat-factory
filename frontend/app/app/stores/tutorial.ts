import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** The launch-prompt answer. `null` = never answered, so the app asks again next launch. */
export type TutorialDecision = 'accepted' | 'declined'

/**
 * The in-app tutorial state: the launch-prompt decision, per-tour completion, and the
 * live progress of whichever tour is running.
 *
 * Two tiers of state, split on purpose:
 *
 *  - PERSISTED (`decision`, `completedTourIds`) — the user's explicit answer to "would you
 *    like a tour?" and which tours they have finished. Browser-persisted like the interface
 *    tier (`uiMode`): it is a per-person, per-browser preference, and `null` (never asked)
 *    is a real state distinct from `declined` — only an explicit answer stops the launch
 *    prompt from returning, while closing it without answering merely defers it to the
 *    next launch.
 *  - SESSION-ONLY (`promptOpen`, `activeTourId`, `stepIndex`) — a tour is anchored to live
 *    DOM, so replaying progress across a reload would point step N at a board that hasn't
 *    reached that state; a reloaded tour restarts from its beginning instead.
 *
 * The store deliberately knows nothing about WHICH tours exist: the catalog lives in the
 * `tutorialTours` slot (see `modular/tutorial-tours.ts`), so tours ship and evolve — first-
 * party and consumer-contributed alike — without this store changing. It tracks ids and a
 * step cursor; the overlay resolves definitions and drives the cursor.
 */
export const useTutorialStore = defineStore(
  'tutorial',
  () => {
    /** The saved launch-prompt answer. Written only by an explicit accept/decline/start. */
    const decision = ref<TutorialDecision | null>(null)
    /** Ids of tours the user finished (reached the last step's Done), persisted. */
    const completedTourIds = ref<string[]>([])

    const promptOpen = ref(false)
    /** Once-per-session guard for the launch auto-open; later opens are user-driven. */
    const promptAutoOpened = ref(false)
    const activeTourId = ref<string | null>(null)
    const stepIndex = ref(0)

    /** A tour is currently running (the overlay mounts off this). */
    const touring = computed(() => activeTourId.value !== null)

    /**
     * Auto-open the launch prompt, at most once per session and only while the user has
     * never answered it. Callers gate on the rest of the launch context (board ready, no
     * other startup advisory open) — see `pages/index.vue`.
     */
    function maybeOfferOnLaunch() {
      if (decision.value !== null || promptAutoOpened.value) return
      promptAutoOpened.value = true
      promptOpen.value = true
    }

    /** User-driven open (command palette), regardless of any saved decision. */
    function openPrompt() {
      promptOpen.value = true
    }

    /**
     * Withdraw an offer this store made, because something the user actually has to answer
     * (a startup advisory, the GitHub onboarding gate) opened on top of it — and re-arm, so
     * the offer returns once that surface is gone. Distinct from {@link closePrompt}: no
     * decision is written EITHER way, but a deferral was not the user's doing, so it must
     * not consume this session's one offer.
     *
     * Only ever withdraws the auto-opened prompt; a prompt the user opened themselves from
     * the palette is theirs to close.
     */
    function deferPrompt() {
      if (!promptAutoOpened.value) return
      promptOpen.value = false
      promptAutoOpened.value = false
    }

    /** Close without answering: no decision is written, so the next launch asks again. */
    function closePrompt() {
      promptOpen.value = false
    }

    /** The explicit "no thanks": saved, so the launch prompt never auto-opens again. */
    function decline() {
      decision.value = 'declined'
      promptOpen.value = false
    }

    /**
     * Begin a tour from its first step. Starting one IS accepting the tutorial (also when
     * launched later from the palette after a decline — the user changed their mind, and
     * leaving `declined` in place would misdescribe what happened).
     */
    function startTour(tourId: string) {
      decision.value = 'accepted'
      promptOpen.value = false
      activeTourId.value = tourId
      stepIndex.value = 0
    }

    /** Move the step cursor; the overlay owns bounds/skip logic and never goes below 0. */
    function setStepIndex(index: number) {
      stepIndex.value = Math.max(0, index)
    }

    /** Abandon the running tour without marking it complete (the Skip action). */
    function stopTour() {
      activeTourId.value = null
      stepIndex.value = 0
    }

    /** Finish the running tour: record completion (idempotent) and clear the cursor. */
    function completeTour() {
      const id = activeTourId.value
      if (id && !completedTourIds.value.includes(id)) {
        completedTourIds.value = [...completedTourIds.value, id]
      }
      stopTour()
    }

    function isCompleted(tourId: string): boolean {
      return completedTourIds.value.includes(tourId)
    }

    return {
      decision,
      completedTourIds,
      promptOpen,
      promptAutoOpened,
      activeTourId,
      stepIndex,
      touring,
      maybeOfferOnLaunch,
      openPrompt,
      closePrompt,
      deferPrompt,
      decline,
      startTour,
      setStepIndex,
      stopTour,
      completeTour,
      isCompleted,
    }
  },
  { persist: { pick: ['decision', 'completedTourIds'] } },
)
