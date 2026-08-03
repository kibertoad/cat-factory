<script setup lang="ts">
import { usePreferredReducedMotion } from '@vueuse/core'
import {
  computeCoachMarkLayout,
  DEFAULT_TARGET_WAIT_MS,
  needsReveal,
  TARGET_IDLE_INTERVAL_MS,
  TARGET_TRACK_INTERVAL_MS,
} from '~/utils/tutorial'
import type { CoachMarkLayout, TutorialRect, TutorialStep, TutorialTour } from '~/utils/tutorial'
import {
  boardNodeIdFor,
  isTargetClickAdvance,
  resolveSkip,
  stepTargetSelectors,
  unexpectedlySkippedSteps,
  waitBudgetMs,
} from './TutorialOverlay.logic'
import type { TutorialDirection } from './TutorialOverlay.logic'

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
const { fitView, viewport } = useBoardFlow()
// Reduced motion is honoured in BOTH directions here: the CSS below drops the ring's transition
// and the searching spinner behind `motion-safe:`, and this drives the JS half — an instant
// scroll and an instant camera move, since a reveal is involuntary motion the user did not ask
// for and is exactly what the preference is about.
const reducedMotion = usePreferredReducedMotion()
const motionMs = computed(() => (reducedMotion.value === 'reduce' ? 0 : 250))

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
/**
 * The step index whose anchor has already been brought into view. A reveal is attempted at
 * most ONCE per step: `fitView` and `scrollIntoView` are animations that take longer than a
 * tracking tick, so re-deciding each tick would re-issue the move against a viewport still
 * mid-flight and fight the user the moment they panned away deliberately.
 */
const revealedForStep = ref<number | null>(null)
const cardEl = ref<HTMLElement | null>(null)
const layout = ref<CoachMarkLayout>({ top: -9999, left: -9999, placement: 'center' })

/**
 * Wall-clock deadline for the current step's anchor search. A deadline rather than a
 * per-tick counter: `measure()` also runs on resize and on every step change, so counting
 * invocations let a resize drag burn a "4000 ms" budget in a fraction of that time.
 */
const searchDeadline = ref(0)
/** Which way `skipMissingStep` travels — see `resolveSkip`. */
const direction = ref<TutorialDirection>('forward')
/** Steps this run gave up on, so the final card can be honest about an abridged tour. */
const skippedStepIds = ref<Set<string>>(new Set())

/** A targeted step whose anchor hasn't been found yet (renders the waiting note). */
const searching = computed(() => step.value?.target !== undefined && targetRect.value === null)
/** The skips the final card must own up to — a branch-gated step's absence is not one. */
const unexpectedSkips = computed(() =>
  unexpectedlySkippedSteps(skippedStepIds.value, tour.value?.steps ?? []),
)
const abridged = computed(() => unexpectedSkips.value.length > 0)

/** The browser viewport. Named apart from Vue Flow's `viewport` (the board CAMERA) above. */
const screen = () => ({ width: window.innerWidth, height: window.innerHeight })
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
      layout.value = computeCoachMarkLayout(null, cardSize(), screen())
      if (performance.now() >= searchDeadline.value) skipMissingStep(s)
      return
    }
    const r = el.getBoundingClientRect()
    const rect = { top: r.top, left: r.left, width: r.width, height: r.height }
    // Reveal BEFORE publishing the rect, so the ring and tooltip are placed from the
    // post-move position on the next tick rather than flashing at the off-screen one.
    if (revealedForStep.value !== tutorial.stepIndex && needsReveal(rect, screen())) {
      revealedForStep.value = tutorial.stepIndex
      revealAnchor(el)
      return
    }
    revealedForStep.value = tutorial.stepIndex
    targetRect.value = rect
  }
  layout.value = computeCoachMarkLayout(
    s.target ? targetRect.value : null,
    cardSize(),
    screen(),
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
 * Put focus on the tooltip so the tour's own controls are one Tab away.
 *
 * Called when the tour STARTS and when the user drives it with Next/Back — never on a
 * `target-click` advance, where the app is opening a modal that owns focus and rightly
 * autofocuses its first field. Stealing it back would leave the user's caret on our card
 * instead of the form the step just told them to fill in.
 *
 * Deliberately NOT a focus trap: half the catalog asks the user to operate a real control,
 * which a trap would put out of reach. `preventScroll` because the card is already placed.
 */
async function focusCard() {
  await nextTick()
  cardEl.value?.focus({ preventScroll: true })
}

function advance() {
  direction.value = 'forward'
  if (isLast.value) tutorial.completeTour()
  else {
    tutorial.setStepIndex(tutorial.stepIndex + 1)
    void focusCard()
  }
}

function back() {
  direction.value = 'back'
  tutorial.setStepIndex(tutorial.stepIndex - 1)
  void focusCard()
}

// "Now click this" steps: watch real clicks (capture phase, so a stopPropagation inside a
// control can't hide them) and follow along AFTER the app has reacted — the deferral lets
// the real handler open its modal/submit its form before the tour moves its anchor.
function onDocumentClick(event: MouseEvent) {
  if (isTargetClickAdvance(step.value, event.target)) {
    window.setTimeout(advance, 0)
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
 * What a screen reader is told when the step changes.
 *
 * A dedicated `role="status"` region rather than `aria-live` on the card itself: the card is a
 * `dialog` whose entire contents are replaced per step, and assistive tech does not reliably
 * announce a wholesale subtree replacement inside a dialog. One key with placeholders, not
 * concatenated fragments, per the i18n rules.
 */
const announcement = computed(() =>
  step.value
    ? t('tutorial.overlay.announcement', {
        current: tutorial.stepIndex + 1,
        total: total.value,
        title: t(step.value.titleKey),
        body: t(step.value.bodyKey, step.value.bodyParams ?? {}),
      })
    : '',
)

// Anchor tracking is EVENT-DRIVEN once an anchor is held, with a slow backstop tick behind it;
// only the hunt for a not-yet-mounted anchor polls fast, and that is bounded by the step's own
// wait budget. The events below are the ways a control that is already on screen can move:
// something scrolled (capture phase, so it catches every scroll container, not just the
// window), the window resized, the control itself resized, or the board camera panned/zoomed.
/** Re-measure from the held anchor — the cheap path every motion event takes. */
const remeasure = () => measure()

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
  void focusCard()
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('scroll', remeasure, true)
  window.removeEventListener('resize', remeasure)
  anchorResize?.disconnect()
  if (trackTimer !== undefined) clearTimeout(trackTimer)
})
</script>

<template>
  <!-- Teleported so board/panel stacking contexts can't clip the marks; z-[70] sits above
       the app's modals (z-50s), since steps legitimately point INTO an open modal. -->
  <Teleport to="body">
    <div v-if="step" data-testid="tutorial-overlay">
      <!-- The step-change announcement. Visually hidden, and OUTSIDE the dialog below so the
           live region is a stable node whose text changes, rather than a subtree that is
           replaced wholesale (which assistive tech announces unreliably, if at all). -->
      <div class="sr-only" role="status" aria-live="polite" data-testid="tutorial-announcement">
        {{ announcement }}
      </div>
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
           this is teleported to the end of `body`. No `aria-modal`: a coach mark is NOT modal,
           and half the catalog asks the user to operate the real control behind it. -->
      <div
        ref="cardEl"
        role="dialog"
        tabindex="-1"
        :aria-label="t('tutorial.overlay.ariaLabel')"
        aria-describedby="tutorial-step-body"
        class="pointer-events-auto fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        :style="{ top: `${layout.top}px`, left: `${layout.left}px` }"
        data-testid="tutorial-tooltip"
        @pointerdown.stop
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
        <p id="tutorial-step-body" class="text-sm text-slate-300">
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
              @click="advance()"
            >
              {{ isLast ? t('tutorial.overlay.done') : t('tutorial.overlay.next') }}
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
