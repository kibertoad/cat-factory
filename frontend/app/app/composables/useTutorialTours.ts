import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { sortTours } from '~/utils/tutorial'
import type { TutorialTour } from '~/utils/tutorial'
import type { AppSlots } from '~/modular/nav-contributions'

/**
 * The tours the current user may take: the merged `tutorialTours` slot (first-party +
 * consumer-contributed), already gated per tour by `navSlotFilter` (each tour's `when`
 * runs over the reactive gates service, so a permission flip shows/hides tours live),
 * in deterministic catalog order. The single source both the launch prompt and the
 * coach-mark overlay resolve tours from.
 */
export function useTutorialTours() {
  const slots = useReactiveSlots<AppSlots>()
  const tours = computed<TutorialTour[]>(() => sortTours(slots.value.tutorialTours ?? []))
  return { tours }
}
