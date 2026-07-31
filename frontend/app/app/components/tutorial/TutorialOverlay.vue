<script setup lang="ts">
import {
  computeCoachMarkLayout,
  DEFAULT_TARGET_WAIT_MS,
  TARGET_TRACK_INTERVAL_MS,
} from '~/utils/tutorial'
import type { CoachMarkLayout, TutorialRect, TutorialStep } from '~/utils/tutorial'
import {
  isTargetClickAdvance,
  resolveSkip,
  stepTargetSelectors,
  tourWasAbridged,
  waitBudgetMs,
} from './TutorialOverlay.logic'
import type { TutorialDirection } from './TutorialOverlay.logic'

// The one shared tour runtime: resolves the running tour from the `tutorialTours` slot,
// anchors a highlight ring + tooltip to the current step's `data-testid`, and advances
// on Next or on a real click on the highlighted control. Mounted (from `pages/index.vue`)
// only while `tutorial.touring`, so all the DOM tracking below exists only mid-tour.
//
// Anchor tracking is a poll, not a one-shot query: board controls move (canvas pan/zoom,
// panels opening) and appear asynchronously (a step can point INTO the modal the previous
// step's click opens), so every tick re-queries and re-measures. A target that never
// appears within the step's wait SKIPS the step — controls are RBAC/tier/deployment
// dependent, and a tour is a set of opportunities, not a fixed script. Everything that
// DECIDES rather than measures lives in `TutorialOverlay.logic.ts`, which is unit-tested.
const { t } = useI18n()
const tutorial = useTutorialStore()
const { tours } = useTutorialTours()

const tour = computed(() => tours.value.find((x) => x.id === tutorial.activeTourId) ?? null)
const step = computed<TutorialStep | null>(() => tour.value?.steps[tutorial.stepIndex] ?? null)
const total = computed(() => tour.value?.steps.length ?? 0)
const isLast = computed(() => tour.value !== null && tutorial.stepIndex >= total.value - 1)

// The running tour vanished from the slot (a gate flipped, a consumer module withdrew it)
// or the cursor ran past the end: end the tour instead of rendering a dead overlay.
watch(
  () => [tour.value, step.value] as const,
  ([tr, st]) => {
    if (tutorial.touring && (!tr || !st)) tutorial.stopTour()
  },
  { immediate: true },
)

const targetEl = ref<HTMLElement | null>(null)
const targetRect = ref<TutorialRect | null>(null)
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
const abridged = computed(() => tourWasAbridged(skippedStepIds.value))

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
/** The tooltip's own size, or a sensible guess before it has rendered once. */
const cardSize = () => ({
  width: cardEl.value?.offsetWidth ?? 320,
  height: cardEl.value?.offsetHeight ?? 180,
})

function queryTarget(s: TutorialStep): HTMLElement | null {
  for (const selector of stepTargetSelectors(s)) {
    const el = document.querySelector<HTMLElement>(selector)
    // `getClientRects().length` distinguishes a mounted-but-hidden control (display:none
    // drawer item) from a visible one; pointing at an invisible control helps nobody.
    if (el && el.getClientRects().length > 0) return el
  }
  return null
}

/** Give up on a step whose anchor never appeared, continuing the user's own direction. */
function skipMissingStep(s: TutorialStep) {
  skippedStepIds.value = new Set(skippedStepIds.value).add(s.id)
  const outcome = resolveSkip(tutorial.stepIndex, direction.value, total.value)
  if (outcome.kind === 'complete') tutorial.completeTour()
  else tutorial.setStepIndex(outcome.index)
}

function measure() {
  const s = step.value
  if (!s) return
  if (!s.target) {
    targetEl.value = null
    targetRect.value = null
  } else {
    const el = queryTarget(s)
    targetEl.value = el
    if (!el) {
      targetRect.value = null
      // Centered while searching: the card must not sit at the PREVIOUS step's anchor —
      // nor at its off-screen initial position — pointing at nothing.
      layout.value = computeCoachMarkLayout(null, cardSize(), viewport())
      if (performance.now() >= searchDeadline.value) skipMissingStep(s)
      return
    }
    const r = el.getBoundingClientRect()
    targetRect.value = { top: r.top, left: r.left, width: r.width, height: r.height }
  }
  layout.value = computeCoachMarkLayout(
    s.target ? targetRect.value : null,
    cardSize(),
    viewport(),
    s.placement,
  )
}

// Re-arm per step: fresh wait budget, drop the stale anchor immediately (the ring must not
// linger on the previous control while the next anchor is located), and re-measure once
// the card has re-rendered its new copy (its size feeds the layout).
watch(step, async (s) => {
  searchDeadline.value = performance.now() + (s ? waitBudgetMs(s) : DEFAULT_TARGET_WAIT_MS)
  targetEl.value = null
  targetRect.value = null
  await nextTick()
  measure()
})

function advance() {
  direction.value = 'forward'
  if (isLast.value) tutorial.completeTour()
  else tutorial.setStepIndex(tutorial.stepIndex + 1)
}

function back() {
  direction.value = 'back'
  tutorial.setStepIndex(tutorial.stepIndex - 1)
}

// "Now click this" steps: watch real clicks (capture phase, so a stopPropagation inside a
// control can't hide them) and follow along AFTER the app has reacted — the deferral lets
// the real handler open its modal/submit its form before the tour moves its anchor.
function onDocumentClick(event: MouseEvent) {
  if (isTargetClickAdvance(step.value, targetEl.value, event.target)) {
    window.setTimeout(advance, 0)
  }
}

/** Esc ends the tour, matching every other dismissible surface in the app. */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') tutorial.stopTour()
}

let trackTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  const s = step.value
  searchDeadline.value = performance.now() + (s ? waitBudgetMs(s) : DEFAULT_TARGET_WAIT_MS)
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', measure)
  trackTimer = setInterval(measure, TARGET_TRACK_INTERVAL_MS)
  measure()
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', measure)
  if (trackTimer !== undefined) clearInterval(trackTimer)
})
</script>

<template>
  <!-- Teleported so board/panel stacking contexts can't clip the marks; z-[70] sits above
       the app's modals (z-50s), since steps legitimately point INTO an open modal. -->
  <Teleport to="body">
    <div v-if="step" data-testid="tutorial-overlay">
      <div
        v-if="targetRect"
        class="ring-primary-400 outline-primary-400/25 pointer-events-none fixed z-[70] rounded-lg outline-4 ring-2 transition-all duration-150"
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
      <div
        ref="cardEl"
        role="dialog"
        aria-live="polite"
        :aria-label="t('tutorial.overlay.ariaLabel')"
        class="pointer-events-auto fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl"
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
        <p class="text-sm text-slate-300">{{ t(step.bodyKey) }}</p>
        <p
          v-if="searching"
          class="mt-2 flex items-center gap-1.5 text-xs text-slate-400"
          data-testid="tutorial-searching"
        >
          <UIcon name="i-lucide-loader" class="h-3.5 w-3.5 animate-spin" />
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
          {{ t('tutorial.overlay.abridged', { count: skippedStepIds.size }, skippedStepIds.size) }}
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
