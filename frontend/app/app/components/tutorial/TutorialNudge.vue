<script setup lang="ts">
import { computed } from 'vue'

// The contextual offer's surface: one walkthrough, offered beside the work that just made it
// relevant. Deliberately NOT a modal — the whole point is the moment, and a modal would
// interrupt whatever the user was doing to reach it (answering a parked run, reading a failure).
// A corner card they can ignore is the strongest thing that is still honest about being an aside.
//
// Which tour, and whether one is on offer at all, is decided upstream (`useTutorialNudge` over
// the pure `newlyAvailableTour`). This component owns only whether now is a moment it may be on
// screen, and that is the reason the offer is HELD rather than dropped: the gates that raise it
// are live run state, so it routinely arrives while a tour or a tutorial window is already up.
const { t } = useI18n()
const tutorial = useTutorialStore()
const { catalogue } = useTutorialTours()
const { launch } = useTutorialLaunch()

/**
 * The offered tour, resolved from the catalogue rather than held as an object.
 *
 * Resolving by id means a tour whose availability has since changed cannot be offered from a
 * stale copy: if the gates dropped it while the offer sat suppressed (a run un-parked itself),
 * the entry is no longer `ready` and the card goes away rather than starting a walkthrough whose
 * every step would now anchor-skip.
 */
const offered = computed(() => {
  const id = tutorial.pendingNudgeId
  if (id === null) return null
  const entry = catalogue.value.find((e) => e.tour.id === id)
  return entry?.availability === 'ready' ? entry.tour : null
})

/**
 * A tour in progress or a tutorial window on screen suppresses the card.
 *
 * `ownWindowOpen` covers the prompt and the catalogue for the same reason the coach marks stand
 * down for them: those are windows the user is answering, and an offer floating over the library
 * they opened to browse offers is noise. A running tour suppresses it because the card would
 * compete with the coach mark for the same attention, and because taking the offer mid-tour
 * would end the walkthrough the user is in the middle of.
 */
const suppressed = computed(() => tutorial.touring || tutorial.ownWindowOpen)

function take(tourId: string) {
  tutorial.dismissNudge()
  launch(tourId)
}
</script>

<template>
  <!-- `aria-live="polite"`: this appears without the user asking, so a screen-reader user is told
       about it when they are between things rather than mid-sentence. The card is not a dialog —
       nothing is trapped and nothing must be answered — so it takes no focus. -->
  <Transition
    enter-active-class="motion-safe:transition motion-safe:duration-200"
    enter-from-class="opacity-0 translate-y-2"
    leave-active-class="motion-safe:transition motion-safe:duration-150"
    leave-to-class="opacity-0 translate-y-2"
  >
    <!-- `end-4`, not `right-4`: the layer ships a RTL locale, so a physical side would pin this to
         the wrong corner in Hebrew. `bottom-20` rather than `bottom-4` because `UApp`'s toaster
         defaults to `bottom-right` and this card is PERSISTENT where a toast is transient, so the
         card yields the lane rather than sitting under it. A tall toast stack can still reach up
         this far, which is acceptable in a way the standing overlap was not: it clears itself. -->
    <div
      v-if="offered && !suppressed"
      class="fixed end-4 bottom-20 z-50 w-80 max-w-[calc(100vw-32px)] rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-2xl backdrop-blur"
      role="status"
      aria-live="polite"
      data-testid="tutorial-nudge"
    >
      <div class="flex items-start gap-2">
        <UIcon
          :name="offered.icon ?? 'i-lucide-graduation-cap'"
          class="text-primary-300 mt-0.5 h-4 w-4 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <p class="text-[11px] tracking-wide text-slate-400 uppercase">
            {{ t('tutorial.nudge.label') }}
          </p>
          <p class="mt-0.5 text-sm font-medium text-slate-100">{{ t(offered.titleKey) }}</p>
          <p class="mt-0.5 text-xs text-slate-400">{{ t(offered.descriptionKey) }}</p>
        </div>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-x"
          :aria-label="t('tutorial.nudge.dismiss')"
          data-testid="tutorial-nudge-dismiss"
          @click="tutorial.dismissNudge()"
        />
      </div>
      <div class="mt-2 flex justify-end">
        <UButton
          size="xs"
          color="primary"
          variant="soft"
          data-testid="tutorial-nudge-start"
          @click="take(offered.id)"
        >
          {{ t('tutorial.nudge.start') }}
        </UButton>
      </div>
    </div>
  </Transition>
</template>
