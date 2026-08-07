<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core'
import {
  computeCoachMarkLayout,
  DEFAULT_TARGET_WAIT_MS,
  needsReveal,
  nextTourAfter,
  TARGET_IDLE_INTERVAL_MS,
  TARGET_TRACK_INTERVAL_MS,
} from '~/utils/tutorial'
import type { CoachMarkLayout, TutorialRect, TutorialStep, TutorialTour } from '~/utils/tutorial'
import {
  boardNodeIdFor,
  isTargetClickAdvance,
  resolveSkip,
  shouldFocusCard,
  stepTargetSelectors,
  unexpectedlySkippedSteps,
  waitBudgetMs,
} from './TutorialOverlay.logic'
import type { TutorialAdvanceCause, TutorialDirection } from './TutorialOverlay.logic'

// The one shared tour runtime: resolves the running tour from the `tutorialTours` slot,
// anchors a highlight ring + tooltip to the current step's `data-testid`, and advances
// on Next or on a real click on the highlighted control. Mounted (from `pages/index.vue`)
// only while `tutorial.touring`, so all the DOM tracking below exists only mid-tour.
//
// Anchor tracking is not a one-shot query: board controls move (canvas pan/zoom, panels
// opening) and appear asynchronously (a step can point INTO the modal the previous step's
// click opens). So the runtime HUNTS for a not-yet-mounted anchor on a fast poll bounded by
// the step's wait budget, and then TRACKS the one it found off events (scroll, resize,
// element resize, board camera) with a slow backstop tick behind them. A target that never
// appears within the wait SKIPS the step — controls are RBAC/tier/deployment dependent, and
// a tour is a set of opportunities, not a fixed script.
//
// An anchor that is on the page but off SCREEN is revealed before it is pointed at, by
// whichever mechanism its container understands: the board is a transform-panned canvas
// (move the camera), everything else is an ordinary scroll container (`scrollIntoView`).
//
// Everything that DECIDES rather than measures lives in `TutorialOverlay.logic.ts`, and the
// geometry in `utils/tutorial.ts`; both are unit-tested, the SFC is not.
const { t } = useI18n()
const tutorial = useTutorialStore()
const { tours } = useTutorialTours()
const { launch } = useTutorialLaunch()
const { fitView, viewport } = useBoardFlow()
// Reduced motion is honoured in BOTH directions here: the CSS below drops the ring's transition
// and the searching spinner behind `motion-safe:`, and this drives the JS half — an instant
// scroll and an instant camera move, since a reveal is involuntary motion the user did not ask
// for and is exactly what the preference is about.
const reducedMotion = usePreferredReducedMotion()
const motionMs = computed(() => (reducedMotion.value === 'reduce' ? 0 : 250))

// ---------------------------------------------------------------------------------------
// PER-RUN state: everything below belongs to ONE pass through ONE script, so it is declared
// here, ahead of the script itself, and reset by the same watcher that re-resolves it. It
// used to be declared further down and rebuilt by the component UNMOUNTING between tours,
// which the finish card's handoff broke: that completes one tour and starts the next within a
// single tick, so `touring` never goes false for a render and nothing unmounts.
// ---------------------------------------------------------------------------------------
/** Which way `skipMissingStep` travels — see `resolveSkip`. */
const direction = ref<TutorialDirection>('forward')
/** Steps this run gave up on, so the final card can be honest about an abridged tour. */
const skippedStepIds = ref<Set<string>>(new Set())
/**
 * The step index whose anchor has already been brought into view. A reveal is attempted at
 * most ONCE per step: `fitView` and `scrollIntoView` are animations that take longer than a
 * tracking tick, so re-deciding each tick would re-issue the move against a viewport still
 * mid-flight and fight the user the moment they panned away deliberately.
 */
const revealedForStep = ref<number | null>(null)

/**
 * The running tour's script, resolved ONCE from the slot when the tour starts and then HELD
 * for its duration. Gates decide what is OFFERED; they do not get to rewrite a walkthrough
 * that is already under way.
 *
 * Re-reading the gated slot on every flip was fine while the gates were slow-moving facts
 * (a permission, a connection). Gates over live RUN state flip as a DIRECT RESULT of
 * following the tour: `answer-park` is offered while something is waiting for a human, so
 * the moment the user answered — the very thing the tour teaches — its `when` went false,
 * the slot dropped the tour, and the watch below tore the overlay down one step short of its
 * own finish card, with no completion recorded. Holding the script also freezes the branch
 * `resolveTours` picked, so a step can't be swapped underneath a stationary cursor when a
 * board that had both a decision and an approval loses one of them mid-tour.
 */
const tour = shallowRef<TutorialTour | null>(null)
watch(
  () => tutorial.activeTourId,
  (id) => {
    // Read untracked (a watch callback registers no dependencies), which is what pins the
    // script: only starting a DIFFERENT tour re-resolves it.
    tour.value = id ? (tours.value.find((x) => x.id === id) ?? null) : null
    // Per-RUN state belongs to the script, so it resets with it. This used to be safe by
    // accident: the overlay is mounted only while `tutorial.touring`, so it unmounted between
    // tours and every ref below was rebuilt. The finish card's handoff completes one tour and
    // starts the next in ONE tick, so `touring` never goes false for a render and nothing
    // unmounts — leaving the finished tour's skips to be counted against the new one, which
    // would open a fresh walkthrough already claiming the user had missed part of it.
    skippedStepIds.value = new Set()
    revealedForStep.value = null
    direction.value = 'forward'
  },
  { immediate: true },
)

const step = computed<TutorialStep | null>(() => tour.value?.steps[tutorial.stepIndex] ?? null)
const total = computed(() => tour.value?.steps.length ?? 0)
const isLast = computed(() => tour.value !== null && tutorial.stepIndex >= total.value - 1)

// The tour could not be resolved when it started (a stale persisted id, or a tour this board is
// not offered at all): end it instead of rendering a dead overlay, and do NOT leave a resume
// point behind — it is a position in a script that could not be loaded, so offering it again
// would put the user straight back here. Since the script is held, this can no longer fire
// because a gate flipped mid-tour.
//
// A resolvable tour whose CURSOR is out of range is a different fact with a different fix: it
// means a resume landed past the end of a script the gates have thinned since. Rewind to the
// start rather than ending, or breaking off a tour would cost the user the tour itself.
watch(
  () => [tour.value, step.value] as const,
  ([tr, st]) => {
    if (!tutorial.touring) return
    if (!tr) tutorial.stopTour({ resumable: false })
    else if (!st) tutorial.setStepIndex(0)
  },
  { immediate: true },
)

const targetRect = ref<TutorialRect | null>(null)
/**
 * The resolved anchor, held between ticks. Event-driven re-measures (scroll, resize, canvas
 * pan) reuse it rather than re-running the selector, and the slow backstop tick re-resolves —
 * so a step still re-anchors when its control is replaced underneath it, without paying for a
 * document query several times a second for the whole length of the tour.
 */
const anchorEl = ref<HTMLElement | null>(null)
const cardEl = ref<HTMLElement | null>(null)
const layout = ref<CoachMarkLayout>({ top: -9999, left: -9999, placement: 'center' })

/**
 * Wall-clock deadline for the current step's anchor search. A deadline rather than a
 * per-tick counter: `measure()` also runs on resize and on every step change, so counting
 * invocations let a resize drag burn a "4000 ms" budget in a fraction of that time.
 */
const searchDeadline = ref(0)

/** A targeted step whose anchor hasn't been found yet (renders the waiting note). */
const searching = computed(() => step.value?.target !== undefined && targetRect.value === null)
/** The skips the final card must own up to — a branch-gated step's absence is not one. */
const unexpectedSkips = computed(() =>
  unexpectedlySkippedSteps(skippedStepIds.value, tour.value?.steps ?? []),
)
const abridged = computed(() => unexpectedSkips.value.length > 0)

/**
 * The walkthrough to hand off to on the finish card, or null when there is nothing left.
 *
 * Read LIVE from the gated slot, which is the deliberate exception to the held-script rule
 * above: the delivery loop is a chain in which each tour produces the state the next one
 * requires, so the completion the user is about to record is itself what makes the next tour
 * takeable. A candidate resolved when the tour STARTED would be empty exactly when this
 * matters. Nothing about the running script is read from it, so the hazard the hold exists to
 * prevent (a step swapped underneath a stationary cursor) cannot arise here.
 *
 * `justFinishedId` is the tour's OWN id rather than `tutorial.activeTourId`, so that the
 * suggestion is stable across the completion that clears the cursor.
 */
const nextTour = computed<TutorialTour | null>(() =>
  tour.value
    ? nextTourAfter(tours.value, {
        justFinishedId: tour.value.id,
        isCompleted: (id) => tutorial.isCompleted(id),
      })
    : null,
)

/**
 * Finish this tour and go straight into the one offered beside Done.
 *
 * Two calls rather than `launch()` alone: the completion has to be recorded first, or the tour
 * the user just finished keeps its "not started" badge in the catalogue. `launch` (not
 * `startTour`) so a suggested tour the user had broken off earlier RESUMES, exactly as it would
 * from the catalogue — the precedence lives in one place for every surface that offers a tour.
 */
function takeNextTour(tourId: string) {
  tutorial.completeTour()
  launch(tourId)
}

/**
 * The browser viewport. Named apart from Vue Flow's `viewport` (the board CAMERA) above —
 * and not `screen`, which would shadow the DOM global of that name for the whole component.
 */
const screenSize = () => ({ width: window.innerWidth, height: window.innerHeight })
/** The tooltip's own size, or a sensible guess before it has rendered once. */
const cardSize = () => ({
  width: cardEl.value?.offsetWidth ?? 320,
  height: cardEl.value?.offsetHeight ?? 180,
})

/** Is this element still in the document and still rendering a box? */
function isUsable(el: HTMLElement | null): el is HTMLElement {
  // `getClientRects().length` distinguishes a mounted-but-hidden control (display:none
  // drawer item) from a visible one; pointing at an invisible control helps nobody.
  return el !== null && el.isConnected && el.getClientRects().length > 0
}

function queryTarget(s: TutorialStep): HTMLElement | null {
  for (const selector of stepTargetSelectors(s)) {
    const el = document.querySelector<HTMLElement>(selector)
    if (isUsable(el)) return el
  }
  return null
}

/**
 * The anchor for this step. Reuses the held element unless `requery` is set or it has gone
 * stale (unmounted, or hidden) — the two cases where it no longer describes anything on screen.
 */
function resolveAnchor(s: TutorialStep, requery: boolean): HTMLElement | null {
  if (!requery && isUsable(anchorEl.value)) return anchorEl.value
  anchorEl.value = queryTarget(s)
  return anchorEl.value
}

/**
 * Bring an off-screen anchor into view, by whichever mechanism its container understands.
 *
 * The board is a transform-panned Vue Flow canvas, so a card that is off screen is not
 * SCROLLED away and `scrollIntoView` on it does nothing at all; the camera has to move
 * instead. Everything else — a panel's scroll container, a long modal body, the sidebar —
 * is an ordinary scroll and `scrollIntoView` is exactly right.
 *
 * The camera move is clamped to the CURRENT zoom (`fitView` would otherwise zoom to fit a
 * single small node, throwing away the user's own view of their board to point at a button).
 */
function revealAnchor(el: HTMLElement) {
  const nodeId = boardNodeIdFor(el)
  if (nodeId !== null) {
    const zoom = viewport.value.zoom
    fitView({
      nodes: [nodeId],
      padding: 0.3,
      minZoom: zoom,
      maxZoom: zoom,
      duration: motionMs.value,
    })
    return
  }
  el.scrollIntoView({
    behavior: motionMs.value === 0 ? 'auto' : 'smooth',
    block: 'center',
    inline: 'center',
  })
}

/** Give up on a step whose anchor never appeared, continuing the user's own direction. */
function skipMissingStep(s: TutorialStep) {
  skippedStepIds.value = new Set(skippedStepIds.value).add(s.id)
  const outcome = resolveSkip(tutorial.stepIndex, direction.value, total.value)
  if (outcome.kind === 'complete') tutorial.completeTour()
  else tutorial.setStepIndex(outcome.index)
}

function measure(options?: { requery?: boolean }) {
  const s = step.value
  if (!s) return
  if (!s.target) {
    targetRect.value = null
  } else {
    const el = resolveAnchor(s, options?.requery === true)
    if (!el) {
      targetRect.value = null
      // Centered while searching: the card must not sit at the PREVIOUS step's anchor —
      // nor at its off-screen initial position — pointing at nothing.
      layout.value = computeCoachMarkLayout(null, cardSize(), screenSize())
      if (performance.now() >= searchDeadline.value) skipMissingStep(s)
      return
    }
    const r = el.getBoundingClientRect()
    const rect = { top: r.top, left: r.left, width: r.width, height: r.height }
    // Reveal BEFORE publishing the rect, so the ring and tooltip are placed from the
    // post-move position on the next tick rather than flashing at the off-screen one.
    if (revealedForStep.value !== tutorial.stepIndex && needsReveal(rect, screenSize())) {
      revealedForStep.value = tutorial.stepIndex
      revealAnchor(el)
      // Centre the card for the same reason the searching branch above does, and it is the
      // same failure: returning without touching `layout` would render THIS step's copy at
      // the PREVIOUS step's coordinates, pointing at a control the user has already left.
      // Usually one frame, since the move emits scroll/camera events that re-enter here —
      // but a reveal that moves nothing (a `fitView` over a node the canvas has dropped)
      // emits none at all, and then it is the whole backstop tick.
      layout.value = computeCoachMarkLayout(null, cardSize(), screenSize())
      return
    }
    revealedForStep.value = tutorial.stepIndex
    targetRect.value = rect
  }
  layout.value = computeCoachMarkLayout(
    s.target ? targetRect.value : null,
    cardSize(),
    screenSize(),
    s.placement,
  )
}

// Re-arm per step: fresh wait budget, drop the stale anchor immediately (the ring must not
// linger on the previous control while the next anchor is located), and re-measure once
// the card has re-rendered its new copy (its size feeds the layout).
watch(step, async (s) => {
  searchDeadline.value = performance.now() + (s ? waitBudgetMs(s) : DEFAULT_TARGET_WAIT_MS)
  targetRect.value = null
  anchorEl.value = null
  revealedForStep.value = null
  await nextTick()
  measure({ requery: true })
})

/**
 * Put focus on the tooltip so the tour's own controls are one Tab away. WHETHER to do that is
 * `shouldFocusCard`'s call, in the logic module, so it is pinned by a test — this function is
 * only the DOM half. `preventScroll` because the card is already placed.
 */
async function focusCard(cause: TutorialAdvanceCause) {
  if (!shouldFocusCard(cause)) return
  await nextTick()
  cardEl.value?.focus({ preventScroll: true })
}

/**
 * A press on the card must not move focus to it, or tooltip text stops being selectable
 * exactly on the steps that point INTO an open modal.
 *
 * The card is click-focusable (`tabindex="-1"`, for {@link focusCard}), so pressing its text
 * would focus it. While a modal is open that focus move leaves the modal's focus trap, the
 * trap yanks focus straight back, and Chromium abandons the selection the press was starting
 * (`selectstart` never fires): the one text a user reliably tries to copy, the sample repo
 * slug in the add-service tour, could not be selected. `preventDefault` on the press is not
 * a fix, because cancelling pointerdown or mousedown cancels the selection itself. Instead
 * the card stops being focusable for just the duration of the gesture: focus then never
 * moves, the trap stays silent, and selection proceeds. Restored on the next tick, so
 * `focusCard` (tour start, Next/Back) still lands. The card's own buttons are unaffected:
 * they are focusable in their own right.
 */
function onCardPointerDown() {
  const el = cardEl.value
  if (!el) return
  el.removeAttribute('tabindex')
  window.setTimeout(() => el.setAttribute('tabindex', '-1'), 0)
}

/**
 * Move the cursor forward. The cause is REQUIRED rather than defaulted: it decides whether
 * focus moves, and a new call site inheriting a default silently is exactly how a
 * `target-click` advance came to steal focus from the modal it had just opened.
 */
function advance(cause: TutorialAdvanceCause) {
  direction.value = 'forward'
  if (isLast.value) {
    tutorial.completeTour()
    return
  }
  tutorial.setStepIndex(tutorial.stepIndex + 1)
  void focusCard(cause)
}

function back() {
  direction.value = 'back'
  tutorial.setStepIndex(tutorial.stepIndex - 1)
  void focusCard('nav-control')
}

// "Now click this" steps: watch real clicks (capture phase, so a stopPropagation inside a
// control can't hide them) and follow along AFTER the app has reacted — the deferral lets
// the real handler open its modal/submit its form before the tour moves its anchor.
function onDocumentClick(event: MouseEvent) {
  if (isTargetClickAdvance(step.value, event.target)) {
    window.setTimeout(() => advance('target-click'), 0)
  }
}

/**
 * Esc ends the tour, matching every other dismissible surface in the app — and, like Skip,
 * leaves a resume point, because it is by far the easiest key to hit by accident and the
 * position it discards is the entire walkthrough.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') tutorial.stopTour()
}

/**
 * What a screen reader should be told about the current step.
 *
 * A dedicated `role="status"` region rather than `aria-live` on the card itself: the card is a
 * `dialog` whose entire contents are replaced per step, and assistive tech does not reliably
 * announce a wholesale subtree replacement inside a dialog. One key with placeholders, not
 * concatenated fragments, per the i18n rules.
 *
 * This is also the SOLE announcement of the step — the card carries no `aria-describedby`,
 * which would have the body read a second time on every focus move.
 */
const announcementText = computed(() =>
  step.value
    ? t('tutorial.overlay.announcement', {
        current: tutorial.stepIndex + 1,
        total: total.value,
        title: t(step.value.titleKey),
        body: t(step.value.bodyKey, step.value.bodyParams ?? {}),
      })
    : '',
)

/**
 * What the live region actually holds, lagging {@link announcementText} by a tick.
 *
 * Assistive tech announces a CHANGE to a live region, and routinely says nothing at all about
 * one that was INSERTED already populated — the same unreliability that moved this out of the
 * card in the first place. The overlay mounts with a step already resolved, so a region bound
 * straight to the text above would arrive full and go unread, silently costing the first step
 * of every tour. Publishing a tick later guarantees the empty region is in the DOM first, so
 * the text is always a change to an existing node.
 */
const announcement = ref('')
watch(
  announcementText,
  async (text) => {
    await nextTick()
    announcement.value = text
  },
  { immediate: true },
)

// Anchor tracking is EVENT-DRIVEN once an anchor is held, with a slow backstop tick behind it;
// only the hunt for a not-yet-mounted anchor polls fast, and that is bounded by the step's own
// wait budget. The events below are the ways a control that is already on screen can move:
// something scrolled (capture phase, so it catches every scroll container, not just the
// window), the window resized, the control itself resized, or the board camera panned/zoomed.
/**
 * Re-measure from the held anchor — the cheap path every motion event takes — coalesced to at
 * most once per frame.
 *
 * `measure()` READS layout (`getBoundingClientRect`, the card's offset size) and then WRITES
 * it (the ring and tooltip styles), so running it per event thrashes layout. Capture-phase
 * scroll is the one that makes this bite: it fires for every scroll container on the page and
 * many times a frame under a momentum scroll, where the poll it replaced ran every 150 ms. A
 * frame is also the most the user can see, so nothing is lost by waiting for one.
 */
let frameHandle = 0
function remeasure() {
  if (typeof requestAnimationFrame === 'undefined') {
    measure()
    return
  }
  if (frameHandle !== 0) return
  frameHandle = requestAnimationFrame(() => {
    frameHandle = 0
    measure()
  })
}

let trackTimer: ReturnType<typeof setTimeout> | undefined
/** Re-resolve the selector on a cadence set by whether we currently HAVE an anchor. */
function scheduleTrack() {
  const delay = targetRect.value ? TARGET_IDLE_INTERVAL_MS : TARGET_TRACK_INTERVAL_MS
  trackTimer = setTimeout(() => {
    measure({ requery: true })
    scheduleTrack()
  }, delay)
}

/** Follows the held anchor's own size changes (a card growing as its run progresses). */
const anchorResize =
  typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => remeasure())
watch(anchorEl, (el) => {
  anchorResize?.disconnect()
  if (el) anchorResize?.observe(el)
})

// The board camera: a pan or zoom moves every canvas anchor without any scroll event at all.
watch(() => [viewport.value.x, viewport.value.y, viewport.value.zoom], remeasure)

onMounted(() => {
  const s = step.value
  searchDeadline.value = performance.now() + (s ? waitBudgetMs(s) : DEFAULT_TARGET_WAIT_MS)
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('scroll', remeasure, { capture: true, passive: true })
  window.addEventListener('resize', remeasure)
  scheduleTrack()
  measure({ requery: true })
  void focusCard('tour-start')
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('scroll', remeasure, true)
  window.removeEventListener('resize', remeasure)
  anchorResize?.disconnect()
  if (trackTimer !== undefined) clearTimeout(trackTimer)
  if (frameHandle !== 0) cancelAnimationFrame(frameHandle)
})
</script>

<template>
  <!-- Teleported so board/panel stacking contexts can't clip the marks; z-[70] sits above
       the app's modals (z-50s), since steps legitimately point INTO an open modal — with the
       one exception of the tutorial's OWN windows (`ownWindowOpen`), which no step points into
       and over which the same z-index would float a ring and a tooltip the user cannot use. -->
  <Teleport to="body">
    <!-- The step-change announcement. Visually hidden, and outside BOTH the dialog and the
         `v-if` below, so the live region is a stable node whose TEXT changes for the whole
         life of the overlay — never a subtree replaced wholesale, and never one inserted with
         its content already in place. Assistive tech announces neither of those reliably. The
         text itself also lands a tick after the node does; see `announcement`. -->
    <div class="sr-only" role="status" aria-live="polite" data-testid="tutorial-announcement">
      {{ announcement }}
    </div>
    <!-- SUPPRESSED, not unmounted, while a tutorial-owned window is open: this component holds
         the running tour's resolved script (see `tour` above), and a remount would re-resolve it
         against gates that may have flipped since the tour started — which is the very failure
         that holding it fixed. The cursor, the tracking and the script all survive; only the
         marks go, and they come back the moment the window closes. -->
    <div v-if="step && !tutorial.ownWindowOpen" data-testid="tutorial-overlay">
      <!-- `motion-safe:` on the ring's transition: it slides between controls on every step,
           which is exactly the involuntary movement `prefers-reduced-motion` is about. -->
      <div
        v-if="targetRect"
        class="ring-primary-400 outline-primary-400/25 pointer-events-none fixed z-[70] rounded-lg outline-4 ring-2 motion-safe:transition-all motion-safe:duration-150"
        :style="{
          top: `${targetRect.top - 4}px`,
          left: `${targetRect.left - 4}px`,
          width: `${targetRect.width + 8}px`,
          height: `${targetRect.height + 8}px`,
        }"
        data-testid="tutorial-highlight"
      />
      <!-- `pointer-events-auto` AND the swallowed `pointerdown` are both required for the
           steps that point INSIDE an open modal: Nuxt UI's modal is a reka-ui dismissable
           layer, which sets `body { pointer-events: none }` (leaving this card inert) and
           dismisses on a document-level pointerdown outside its own content (so a press on
           this card would close the user's half-filled form instead of pressing a button). -->
      <!-- `tabindex="-1"` so `focusCard()` can put focus here when the tour starts and on every
           Next/Back — without it a keyboard user has to tab the whole page to reach Next, since
           this is teleported to the end of `body`. (A pointer press lifts the attribute for the
           duration of the gesture, see `onCardPointerDown`, or pressing the text would focus
           the card and an open modal's focus trap would cancel the selection being started.)
           No `aria-modal`: a coach mark is NOT modal, and half the catalog asks the user to
           operate the real control behind it. No `aria-describedby` on the body either: the
           live region above already reads the body as part of a complete announcement, and
           pointing at it here would have every focus move read it a second time. -->
      <div
        ref="cardEl"
        role="dialog"
        tabindex="-1"
        :aria-label="t('tutorial.overlay.ariaLabel')"
        class="pointer-events-auto fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        :style="{ top: `${layout.top}px`, left: `${layout.left}px` }"
        data-testid="tutorial-tooltip"
        @pointerdown.stop="onCardPointerDown"
      >
        <div class="mb-1 flex items-start justify-between gap-3">
          <h3 class="text-sm font-semibold text-slate-100">{{ t(step.titleKey) }}</h3>
          <span class="shrink-0 text-xs text-slate-500">
            {{ t('tutorial.overlay.progress', { current: tutorial.stepIndex + 1, total }) }}
          </span>
        </div>
        <!-- `bodyParams` carries the fixed proper nouns a step names (a repository slug),
             which live in the catalog's `{named}` placeholders rather than in nine
             translations of the same literal. Absent for most steps. -->
        <p class="text-sm text-slate-300">
          {{ t(step.bodyKey, step.bodyParams ?? {}) }}
        </p>
        <p
          v-if="searching"
          class="mt-2 flex items-center gap-1.5 text-xs text-slate-400"
          data-testid="tutorial-searching"
        >
          <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 motion-safe:animate-spin" />
          {{ t('tutorial.overlay.searching') }}
        </p>
        <p
          v-else-if="step.advanceOn === 'target-click'"
          class="text-primary-300 mt-2 text-xs"
          data-testid="tutorial-click-hint"
        >
          {{ t('tutorial.overlay.clickHint') }}
        </p>
        <!-- Reaching the end having skipped steps is NOT the same as having been shown the
             whole tour: say so rather than congratulating the user either way. -->
        <p
          v-if="isLast && abridged"
          class="mt-2 text-xs text-amber-300/90"
          data-testid="tutorial-abridged"
        >
          {{
            t(
              'tutorial.overlay.abridged',
              { count: unexpectedSkips.length },
              unexpectedSkips.length,
            )
          }}
        </p>
        <!-- The handoff. The catalog is a chain — each delivery-loop tour produces the state
             the next one needs — and this is the last moment the product can say so: starting
             any tour saves `decision: 'accepted'`, which stops the launch prompt returning, so
             without this the walkthrough the user's own last action just unlocked is reachable
             only by going and finding the catalogue. One tour, not a list; absent when there is
             nothing ready, where the plain Done below is the honest ending. -->
        <div
          v-if="isLast && nextTour"
          class="mt-3 rounded-lg border border-slate-700/70 bg-slate-800/40 p-2.5"
          data-testid="tutorial-next-tour"
        >
          <p class="text-[11px] tracking-wide text-slate-400 uppercase">
            {{ t('tutorial.overlay.nextUp') }}
          </p>
          <p class="mt-0.5 text-sm font-medium text-slate-100">{{ t(nextTour.titleKey) }}</p>
          <p class="mt-0.5 text-xs text-slate-400">{{ t(nextTour.descriptionKey) }}</p>
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            class="mt-2"
            data-testid="tutorial-next-tour-start"
            @click="takeNextTour(nextTour.id)"
          >
            {{ t('tutorial.overlay.takeNext') }}
          </UButton>
        </div>
        <div class="mt-3 flex items-center justify-between gap-2">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            data-testid="tutorial-skip"
            @click="tutorial.stopTour()"
          >
            {{ t('tutorial.overlay.skip') }}
          </UButton>
          <div class="flex items-center gap-2">
            <UButton
              v-if="tutorial.stepIndex > 0"
              size="xs"
              variant="soft"
              color="neutral"
              data-testid="tutorial-back"
              @click="back()"
            >
              {{ t('tutorial.overlay.back') }}
            </UButton>
            <!-- A click-to-advance step hides Next so the real control is the only way
                 forward (its Done form stays on a last step, which must be finishable). -->
            <UButton
              v-if="step.advanceOn !== 'target-click' || isLast"
              size="xs"
              color="primary"
              data-testid="tutorial-next"
              @click="advance('nav-control')"
            >
              {{ isLast ? t('tutorial.overlay.done') : t('tutorial.overlay.next') }}
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
