import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createLaunchPrompt } from '~/stores/launchPrompt'
import { createTutorialRecord } from '~/stores/tutorial.record'

// `TutorialDecision` is deliberately NOT re-exported from here even though it used to live here:
// both store modules are auto-import sources, so two exports of one name make Nuxt drop one of them
// with a build warning. It is reachable unqualified anywhere in the layer, from `tutorial.record.ts`
// where it is declared beside the state it describes.

/**
 * The in-app tutorial state: the launch-prompt decision, per-tour completion, and the
 * live progress of whichever tour is running.
 *
 * Two tiers of state, split on purpose — and the split is now a real seam rather than a comment:
 *
 *  - PERSISTED (`decision`, `completedTourIds`, `nudgedTourIds`) — the standing record of what this
 *    PERSON has done, owned by `createTutorialRecord` (`stores/tutorial.record.ts`) along with the
 *    server-reconciliation rules that go with it. `null` (never asked) is a real state distinct from
 *    `declined`: only an explicit answer stops the launch prompt returning, while closing it without
 *    answering merely defers it to the next launch.
 *  - SESSION-ONLY (`promptOpen`, `catalogueOpen`, `activeTourId`, `stepIndex`, `pendingNudgeId`) —
 *    owned here. A tour is anchored to live DOM, so replaying progress across a reload would point
 *    step N at a board that hasn't reached that state; a reloaded tour restarts from its beginning.
 *
 * The persisted half is a per-person fact rather than a per-browser one, so it is MIRRORED to the
 * signed-in user's server row when the deployment has accounts (`useTutorialSync`), with this store
 * staying the local cache the SPA reads. Persisting it here as well is not redundancy: it is what a
 * deployment with auth disabled, and every load before the snapshot lands, runs on.
 *
 * The store deliberately knows nothing about WHICH tours exist: the catalog lives in the
 * `tutorialTours` slot (see `modular/tutorial-tours.ts`), so tours ship and evolve — first-party and
 * consumer-contributed alike — without this store changing. It tracks ids and a step cursor; the
 * overlay resolves definitions and drives the cursor.
 */
export const useTutorialStore = defineStore(
  'tutorial',
  () => {
    const record = createTutorialRecord()
    // The launch offer's own four-exit state machine (`stores/launchPrompt.ts`, shared with the
    // role question), which needs to know only WHETHER an answer exists.
    const prompt = createLaunchPrompt({ hasDecision: () => record.decision.value !== null })
    const { promptOpen } = prompt
    /**
     * The tutorial catalogue (every tour this deployment ships, startable at any time) is
     * open. Always user-driven — nothing auto-opens it — which is why it carries none of the
     * prompt's decision machinery: browsing the catalogue answers no question, so it neither
     * writes a decision nor consumes the launch offer.
     */
    const catalogueOpen = ref(false)
    const activeTourId = ref<string | null>(null)
    const stepIndex = ref(0)
    /**
     * Where a tour the user broke off was left, so the prompt can offer to RESUME it rather
     * than only to start it again from step one.
     *
     * Session-only for the same reason the cursor is: a tour is anchored to live DOM, and a
     * position replayed across a reload would point step N at a board that has not reached
     * that state. Within one session the board is still exactly where the tour left it, so the
     * position is good — which matters because breaking off is easy and cheap (Esc, or Skip to
     * get the overlay out of the way for a moment) while the cost of it was the whole
     * walkthrough.
     */
    const interrupted = ref<{ tourId: string; stepIndex: number } | null>(null)

    /**
     * The tour the contextual offer is currently holding out, or null.
     *
     * Session state, and separate from `nudgedTourIds` on purpose: the id is marked as SPENT the
     * moment the offer is made, while what is on SCREEN survives being suppressed. The two most
     * valuable moments to offer a tour (a run parked, a run failed) routinely arrive while a
     * tutorial window or another tour is up, and dropping the offer there would lose the one chance
     * this mechanism gets. Holding it means it appears as soon as the way is clear.
     *
     * The trade is deliberate: a reload before it is ever shown burns the offer. That beats the
     * alternative of re-arming it, which turns one missed moment into a prompt that keeps coming
     * back on a board whose gates flip constantly.
     */
    const pendingNudgeId = ref<string | null>(null)

    /** A tour is currently running (the overlay mounts off this). */
    const touring = computed(() => activeTourId.value !== null)

    /**
     * A window this feature owns — the launch prompt or the catalogue — is on screen.
     *
     * The coach-mark overlay STANDS DOWN while it is (see `TutorialOverlay.vue`). The marks
     * render at `z-[70]`, deliberately above the app's own modals, because a tour step
     * legitimately points INTO one; no step points into the tutorial's own windows, so there
     * the same rule floats a highlight ring and a tooltip over the modal the user just opened.
     * The catalogue reaches this state by design — it is openable mid-tour, which is what the
     * `continue` launch action exists for.
     *
     * A derived FACT rather than a `coachMarksHidden` flag, because the reason is the window,
     * not the overlay: a third tutorial-owned window inherits the behaviour by being named
     * here, and nothing has to remember to set a flag.
     */
    const ownWindowOpen = computed(() => promptOpen.value || catalogueOpen.value)

    /**
     * Open the catalogue. Closes the launch prompt WITHOUT answering it: browsing the full
     * list is not "no thanks" (it is the opposite), and the two are modals that would
     * otherwise stack — so the offer returns next launch if the user browses and starts
     * nothing.
     */
    function openCatalogue() {
      promptOpen.value = false
      catalogueOpen.value = true
    }

    function closeCatalogue() {
      catalogueOpen.value = false
    }

    /** The explicit "no thanks": saved, so the launch prompt never auto-opens again. */
    function decline() {
      record.declineOffer()
      promptOpen.value = false
    }

    /**
     * Begin a tour from its first step. Starting one IS accepting the tutorial (also when
     * launched later from the palette after a decline — the user changed their mind, and
     * leaving `declined` in place would misdescribe what happened).
     */
    function startTour(tourId: string) {
      record.acceptOffer()
      promptOpen.value = false
      catalogueOpen.value = false
      activeTourId.value = tourId
      stepIndex.value = 0
      // Starting from the top is an explicit choice to discard THIS tour's old position;
      // leaving the record in place would offer Resume again the moment this attempt is
      // broken off at step 0, pointing at a position the user already walked away from.
      //
      // A DIFFERENT tour's position is not this action's to discard. It is still exactly what
      // its own Resume offer needs, and it will lose the single slot soon enough — the moment
      // this tour is broken off past step 0. Clearing it here instead means glancing at
      // another tour and pressing Esc silently costs the position you were coming back to.
      if (interrupted.value?.tourId === tourId) interrupted.value = null
    }

    /**
     * Pick a broken-off tour back up where it stopped. Falls back to a plain start when the
     * saved position is for a DIFFERENT tour (or gone), so a caller never has to check first
     * and a stale offer degrades to the ordinary behaviour instead of resuming the wrong tour.
     *
     * The index is not validated here: the store deliberately knows nothing about which tours
     * exist or how many steps they have, so the overlay clamps it against the script it holds.
     */
    function resumeTour(tourId: string) {
      const at = interrupted.value
      if (!at || at.tourId !== tourId) {
        startTour(tourId)
        return
      }
      record.acceptOffer()
      promptOpen.value = false
      catalogueOpen.value = false
      activeTourId.value = tourId
      stepIndex.value = at.stepIndex
      interrupted.value = null
    }

    /** Move the step cursor; the overlay owns bounds/skip logic and never goes below 0. */
    function setStepIndex(index: number) {
      stepIndex.value = Math.max(0, index)
    }

    /** Clear the live cursor. Shared by the two ways a tour ends, which differ only in what
     * they leave behind (a resume point vs. a completion). */
    function clearCursor() {
      activeTourId.value = null
      stepIndex.value = 0
    }

    /**
     * Abandon the running tour without marking it complete: Skip, Esc, or a runtime that
     * could not resolve the tour at all.
     *
     * Records where it stopped so the prompt can offer to resume — except from the very first
     * step, where resuming and starting are the same thing and an offer to "resume" would be
     * noise. `resumable: false` is for the runtime's own bail-outs, which stop BECAUSE the
     * position is unusable and must not hand it back.
     */
    function stopTour(options?: { resumable?: boolean }) {
      const id = activeTourId.value
      if (id !== null && stepIndex.value > 0 && options?.resumable !== false) {
        interrupted.value = { tourId: id, stepIndex: stepIndex.value }
      }
      clearCursor()
    }

    /** Finish the running tour: record completion (idempotent) and clear the cursor. */
    function completeTour() {
      const id = activeTourId.value
      if (id) record.markCompleted(id)
      // A finished tour has no position left to resume, and an offer to resume the walkthrough
      // the user just completed would sit beside its own Completed badge.
      if (id !== null && interrupted.value?.tourId === id) interrupted.value = null
      clearCursor()
    }

    /** Where this tour was broken off, if it was; null otherwise (the Resume affordance). */
    function interruptedAt(tourId: string): number | null {
      return interrupted.value?.tourId === tourId ? interrupted.value.stepIndex : null
    }

    /**
     * Hold out the contextual offer for a tour that just became takeable.
     *
     * Spending the id and raising the offer are ONE action, so an offer can never be made twice
     * however many times the gates flip: the guard is the persisted list, not the visible state.
     * Idempotent, so a caller re-evaluating the catalogue needs no check of its own.
     */
    function offerNudge(tourId: string) {
      if (record.wasNudged(tourId)) return
      record.markNudged(tourId)
      pendingNudgeId.value = tourId
    }

    /** Take the offer off screen. It is already spent, so it does not come back. */
    function dismissNudge() {
      pendingNudgeId.value = null
    }

    /**
     * Forget everything this browser remembers about the tutorial (see `record.reset`), plus the
     * offer currently on screen.
     *
     * It does NOT re-open the prompt in this session: `promptAutoOpened` is session state and stays
     * spent, so the offer returns at the next launch rather than appearing on top of the catalogue
     * the user is still reading. A running tour is left alone: this clears a record, it does not
     * interrupt a walkthrough the user is in the middle of (which would end it, unrecorded, on a
     * click about history).
     */
    function resetProgress() {
      record.reset()
      interrupted.value = null
      pendingNudgeId.value = null
    }

    return {
      ...record,
      ...prompt,
      catalogueOpen,
      activeTourId,
      stepIndex,
      interrupted,
      pendingNudgeId,
      touring,
      ownWindowOpen,
      openCatalogue,
      closeCatalogue,
      resetProgress,
      decline,
      startTour,
      resumeTour,
      setStepIndex,
      stopTour,
      completeTour,
      interruptedAt,
      offerNudge,
      dismissNudge,
    }
  },
  { persist: { pick: ['decision', 'completedTourIds', 'nudgedTourIds'] } },
)
