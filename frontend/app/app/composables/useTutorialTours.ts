import { computed } from 'vue'
import { useReactiveSlots } from '@modular-vue/runtime'
import { createSharedComposables } from '@modular-vue/vue'
import { isLaunchOffer, resolveTourCatalogue } from '~/utils/tutorial'
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
 * Three views over one resolution, and the differences between them are the point:
 *
 *  - `tours` — what can be started right now. The overlay resolves a running tour from these,
 *    exactly as when this gating lived in `navSlotFilter`.
 *  - `offered` — the subset the launch prompt asks about: startable AND part of the first-run
 *    arc (see `TutorialTour.offeredAtLaunch`). The prompt is one answerable question, so it
 *    stays the delivery loop even as the catalog grows to cover the platform surfaces.
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
  const offered = computed<TutorialTour[]>(() => tours.value.filter(isLaunchOffer))
  return { tours, offered, catalogue }
}
