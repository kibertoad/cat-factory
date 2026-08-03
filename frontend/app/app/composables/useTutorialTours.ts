import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { createSharedComposables } from '@modular-vue/vue'
import { resolveTourCatalogue } from '~/utils/tutorial'
import type { TutorialCatalogueEntry, TutorialTour } from '~/utils/tutorial'
import type { AppDeps } from '~/modular/registry'
import type { AppSlots } from '~/modular/nav-contributions'

/**
 * The registered `gates` service — the SAME reactive object `navSlotFilter` reads, resolved
 * from the modular app's shared dependencies rather than rebuilt here, so the tutorial
 * surfaces and the nav can never disagree about what this board offers. Reading its getters
 * inside a `computed` tracks the underlying stores, so availability re-resolves the instant a
 * permission flips or a task lands on the board.
 *
 * `useOptional` (not `useService`) covers the bare-install case the nav filter also allows: a
 * host that registered no gates withholds nothing rather than throwing.
 */
const { useOptional } = createSharedComposables<AppDeps>()

/**
 * The tutorial catalog as this board sees it, resolved ONCE for every surface that reads it.
 *
 * Two views over one resolution, and the difference between them is the point:
 *
 *  - `tours` — what can be started right now. The launch prompt offers these, and the overlay
 *    resolves a running tour from them, exactly as when this gating lived in `navSlotFilter`.
 *  - `catalogue` — EVERY tour this deployment ships, each carrying why it is or isn't
 *    available. The catalogue surface needs the unavailable ones: a list that quietly omits
 *    four of six tours is indistinguishable from a deployment that ships two, and the user it
 *    fails is the one who came looking for the walkthrough they were told about.
 *
 * Gating cannot live in the slot filter for that reason — a `SlotFilter` maps slots to slots,
 * so it can only drop, never annotate. `resolveTourCatalogue` is pure and does both.
 */
export function useTutorialTours() {
  const slots = useReactiveSlots<AppSlots>()
  const gates = useOptional('gates')
  const catalogue = computed<TutorialCatalogueEntry[]>(() =>
    resolveTourCatalogue(slots.value.tutorialTours ?? [], gates.value),
  )
  const tours = computed<TutorialTour[]>(() =>
    catalogue.value.filter((entry) => entry.availability === 'ready').map((entry) => entry.tour),
  )
  return { tours, catalogue }
}
