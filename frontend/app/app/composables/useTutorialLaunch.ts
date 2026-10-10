import { launchActionFor, tourState } from '~/utils/tutorial'
import type { TutorialLaunchAction, TutorialTourState } from '~/utils/tutorial'

/**
 * Starting a tour, from whichever surface offers it.
 *
 * Both the launch prompt and the catalogue answer the same question per tour — start it,
 * resume where it was broken off, take it again, or step back into the one already running —
 * and getting that precedence subtly different between the two surfaces would show up as the
 * same button doing different things on two screens. So the decision is made once here, over
 * the pure {@link tourState} / {@link launchActionFor} pair, and each surface renders it.
 */
export function useTutorialLaunch() {
  const tutorial = useTutorialStore()

  /** Where this tour stands for this user right now. */
  function stateOf(tourId: string): TutorialTourState {
    return tourState({
      active: tutorial.activeTourId === tourId,
      resumable: tutorial.interruptedAt(tourId) !== null,
      completed: tutorial.isCompleted(tourId),
    })
  }

  /** What this tour's button will do — also what labels it. */
  function actionFor(tourId: string): TutorialLaunchAction {
    return launchActionFor(stateOf(tourId))
  }

  /**
   * Act on that. `continue` only steps out of the way: the overlay for that tour is already
   * on screen, so restarting it from step one — which is what a plain `startTour` would do —
   * would throw away the position of the walkthrough the user was pointing at.
   */
  function launch(tourId: string): void {
    switch (actionFor(tourId)) {
      case 'continue':
        tutorial.closeCatalogue()
        tutorial.closePrompt()
        return
      case 'resume':
        tutorial.resumeTour(tourId)
        return
      default:
        tutorial.startTour(tourId)
    }
  }

  return { stateOf, actionFor, launch }
}
