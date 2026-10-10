import { launchActionFor } from '~/utils/tutorial'
import type {
  TutorialAvailability,
  TutorialCatalogueEntry,
  TutorialLaunchAction,
  TutorialRequirement,
  TutorialTour,
  TutorialTourState,
} from '~/utils/tutorial'

/**
 * What the catalogue renders per tour, and the progress line above the list.
 *
 * Extracted from `TutorialCatalogue.vue` for the same reason the overlay's decisions are
 * (`TutorialOverlay.logic.ts`): the vitest setup has no SFC transform, so anything that
 * DECIDES has to live outside the component to be tested. Here that is the whole of what the
 * surface claims — which tours can be started, which are held back and by what, and how much
 * of the catalog this user has been through.
 */

/** One rendered row: an entry, plus everything derived from it and the user's progress. */
export interface TutorialCatalogueRow {
  tour: TutorialTour
  availability: TutorialAvailability
  /** What is standing in the way, when {@link availability} is `blocked`. */
  unmet: readonly TutorialRequirement[]
  state: TutorialTourState
  action: TutorialLaunchAction
  /**
   * How many steps a start would walk this board through — the RESOLVED count, not the
   * declared one, since branch steps that don't apply here are already gone.
   *
   * Null for a tour that cannot run: its resolved script is not what the user would get once
   * the missing requirement is met, and a number that quietly changes when they unblock it is
   * worse than no number.
   */
  stepCount: number | null
  /** Whether the row's button does anything (a blocked tour's is inert, not hidden). */
  startable: boolean
}

/** The list, in catalog order — the entries arrive sorted by `resolveTourCatalogue`. */
export function buildCatalogueRows(
  entries: readonly TutorialCatalogueEntry[],
  stateOf: (tourId: string) => TutorialTourState,
): TutorialCatalogueRow[] {
  return entries.map((entry) => {
    const ready = entry.availability === 'ready'
    const state = stateOf(entry.tour.id)
    return {
      tour: entry.tour,
      availability: entry.availability,
      unmet: entry.unmet,
      state,
      action: launchActionFor(state),
      stepCount: ready ? entry.tour.steps.length : null,
      startable: ready,
    }
  })
}

/** The headline count. */
export interface TutorialProgressSummary {
  completed: number
  /** Every tour this deployment ships, available or not — the honest denominator. */
  total: number
  /**
   * Whether there is anything for Reset to clear — which is everything `resetProgress` writes,
   * not only what this list shows. See {@link summarizeProgress}.
   */
  resettable: boolean
}

/**
 * Progress across the WHOLE catalog, not just the runnable part.
 *
 * Counting only what this board can offer today would move the denominator under the user
 * every time they linked a repo or finished a run — "2 of 2 completed" on a board with four
 * more walkthroughs waiting behind requirements reads as a finished tutorial, which is the
 * one thing this surface exists to disprove.
 *
 * `launchOfferAnswered` is the store's `decision`, and it is here rather than derived from the
 * rows because `resetProgress` clears it too — Reset restores the FIRST-LAUNCH experience, and
 * the saved answer to "would you like a tour?" is most of that. Keying the control on the rows
 * alone hid it from the one user who most needs it: someone who clicked "No thanks" and took no
 * tour has nothing completed and nothing paused, so the only route back to the offer was the
 * control that was not being drawn.
 */
export function summarizeProgress(
  rows: readonly TutorialCatalogueRow[],
  input: { launchOfferAnswered: boolean },
): TutorialProgressSummary {
  const completed = rows.filter((row) => row.state === 'completed').length
  return {
    completed,
    total: rows.length,
    // A paused tour is progress too: clearing it is exactly what someone handing this to a
    // colleague wants, and offering Reset only for completions would leave it behind.
    resettable:
      completed > 0 || rows.some((row) => row.state === 'paused') || input.launchOfferAnswered,
  }
}
