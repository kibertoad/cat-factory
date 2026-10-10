import {
  getTutorialProgressContract,
  recordTutorialEventContract,
  resetTutorialProgressContract,
  updateTutorialProgressContract,
} from '@cat-factory/contracts'
import type { RecordTutorialEventInput, UpdateTutorialProgressInput } from '~/types/domain'
import type { ApiContext } from './context'

/**
 * The in-app tutorial's server surface, scoped to the signed-in user: progress that follows the
 * PERSON across browsers, plus the funnel events (which store nothing and answer only whether the
 * tutorial is being found and finished).
 */
export function tutorialApi({ send }: ApiContext) {
  return {
    getTutorialProgress: () => send(getTutorialProgressContract, {}),
    /** MERGES: the two id sets are grow-only, so this never removes what another device recorded. */
    updateTutorialProgress: (body: UpdateTutorialProgressInput) =>
      send(updateTutorialProgressContract, { body }),
    resetTutorialProgress: () => send(resetTutorialProgressContract, {}),
    recordTutorialEvent: (body: RecordTutorialEventInput) =>
      send(recordTutorialEventContract, { body }),
  }
}
