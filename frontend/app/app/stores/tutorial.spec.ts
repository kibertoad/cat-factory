import { describe, expect, it } from 'vitest'
import { useTutorialStore } from '~/stores/tutorial'

describe('useTutorialStore launch prompt', () => {
  it('offers the tutorial on launch while no decision was ever saved', () => {
    const tutorial = useTutorialStore()
    expect(tutorial.decision).toBeNull()
    tutorial.maybeOfferOnLaunch()
    expect(tutorial.promptOpen).toBe(true)
  })

  it('auto-opens at most once per session', () => {
    const tutorial = useTutorialStore()
    tutorial.maybeOfferOnLaunch()
    tutorial.closePrompt()
    // The advisory watcher re-fires whenever another modal closes; the guard must hold.
    tutorial.maybeOfferOnLaunch()
    expect(tutorial.promptOpen).toBe(false)
  })

  it('closing without answering saves nothing, so the next launch asks again', () => {
    const tutorial = useTutorialStore()
    tutorial.maybeOfferOnLaunch()
    tutorial.closePrompt()
    expect(tutorial.decision).toBeNull()
  })

  it('declining is saved and stops the launch offer for good', () => {
    const tutorial = useTutorialStore()
    tutorial.maybeOfferOnLaunch()
    tutorial.decline()
    expect(tutorial.decision).toBe('declined')
    expect(tutorial.promptOpen).toBe(false)
    // A fresh session (new auto-open guard) still must not offer: decision wins.
    tutorial.promptAutoOpened = false
    tutorial.maybeOfferOnLaunch()
    expect(tutorial.promptOpen).toBe(false)
  })

  it('defers an offer an advisory landed on top of, and re-offers when it clears', () => {
    const tutorial = useTutorialStore()
    tutorial.maybeOfferOnLaunch()
    // A startup advisory opened after the prompt: withdraw rather than stack.
    tutorial.deferPrompt()
    expect(tutorial.promptOpen).toBe(false)
    expect(tutorial.decision).toBeNull()
    // A deferral is not the user's answer, so it must not consume the session's offer.
    tutorial.maybeOfferOnLaunch()
    expect(tutorial.promptOpen).toBe(true)
  })

  it('never withdraws a prompt the user opened themselves', () => {
    const tutorial = useTutorialStore()
    tutorial.openPrompt()
    tutorial.deferPrompt()
    expect(tutorial.promptOpen).toBe(true)
  })

  it('a user-driven open works regardless of a saved decision', () => {
    const tutorial = useTutorialStore()
    tutorial.decline()
    tutorial.openPrompt()
    expect(tutorial.promptOpen).toBe(true)
  })
})

describe('useTutorialStore tours', () => {
  it('starting a tour records acceptance, closes the prompt, and resets the cursor', () => {
    const tutorial = useTutorialStore()
    tutorial.openPrompt()
    tutorial.startTour('board-basics')
    expect(tutorial.decision).toBe('accepted')
    expect(tutorial.promptOpen).toBe(false)
    expect(tutorial.activeTourId).toBe('board-basics')
    expect(tutorial.stepIndex).toBe(0)
    expect(tutorial.touring).toBe(true)
  })

  it('starting a tour after a decline flips the decision to accepted', () => {
    // The user changed their mind via the palette; leaving `declined` in place would
    // misdescribe what happened.
    const tutorial = useTutorialStore()
    tutorial.decline()
    tutorial.startTour('board-basics')
    expect(tutorial.decision).toBe('accepted')
  })

  it('the step cursor never goes below zero', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(-3)
    expect(tutorial.stepIndex).toBe(0)
    tutorial.setStepIndex(4)
    expect(tutorial.stepIndex).toBe(4)
  })

  it('skipping (stopTour) abandons the tour without marking it complete', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(2)
    tutorial.stopTour()
    expect(tutorial.touring).toBe(false)
    expect(tutorial.stepIndex).toBe(0)
    expect(tutorial.isCompleted('board-basics')).toBe(false)
  })

  it('completing records the tour id once, idempotently', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    expect(tutorial.isCompleted('board-basics')).toBe(true)
    expect(tutorial.touring).toBe(false)

    tutorial.startTour('board-basics')
    tutorial.completeTour()
    expect(tutorial.completedTourIds).toEqual(['board-basics'])
  })

  it('completing with no active tour records nothing', () => {
    const tutorial = useTutorialStore()
    tutorial.completeTour()
    expect(tutorial.completedTourIds).toEqual([])
  })

  it('tracks completion per tour id', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    tutorial.startTour('first-task')
    tutorial.completeTour()
    expect(tutorial.completedTourIds).toEqual(['board-basics', 'first-task'])
    expect(tutorial.isCompleted('first-task')).toBe(true)
    expect(tutorial.isCompleted('made-up')).toBe(false)
  })
})

describe('useTutorialStore resuming a broken-off tour', () => {
  it('offers to resume a tour abandoned part-way', () => {
    // Esc and Skip are both cheap to hit — one by accident, one to get the overlay out of the
    // way for a moment — and before this the position they discarded was the whole walkthrough.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(3)
    tutorial.stopTour()
    expect(tutorial.interruptedAt('board-basics')).toBe(3)

    tutorial.resumeTour('board-basics')
    expect(tutorial.activeTourId).toBe('board-basics')
    expect(tutorial.stepIndex).toBe(3)
    // Consumed: the tour is running again, so there is no longer a position to go back to.
    expect(tutorial.interruptedAt('board-basics')).toBeNull()
  })

  it('offers nothing for a tour abandoned on its very first step', () => {
    // Resuming and starting are the same thing there, so a Resume label would be noise.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.stopTour()
    expect(tutorial.interruptedAt('board-basics')).toBeNull()
  })

  it('keeps the resume point scoped to the tour it belongs to', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('run-task')
    tutorial.setStepIndex(2)
    tutorial.stopTour()
    expect(tutorial.interruptedAt('first-task')).toBeNull()
    // Resuming a DIFFERENT tour degrades to a plain start rather than resuming the wrong one.
    tutorial.resumeTour('first-task')
    expect(tutorial.activeTourId).toBe('first-task')
    expect(tutorial.stepIndex).toBe(0)
  })

  it('discards the resume point when the same tour is started from the top', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(3)
    tutorial.stopTour()
    tutorial.startTour('board-basics')
    expect(tutorial.stepIndex).toBe(0)
    expect(tutorial.interruptedAt('board-basics')).toBeNull()
  })

  it('leaves no resume point behind a completed tour', () => {
    // It would sit beside that tour's own Completed badge, offering to resume what just finished.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(3)
    tutorial.stopTour()
    tutorial.resumeTour('board-basics')
    tutorial.setStepIndex(4)
    tutorial.completeTour()
    expect(tutorial.interruptedAt('board-basics')).toBeNull()
    expect(tutorial.isCompleted('board-basics')).toBe(true)
  })

  it('leaves no resume point when the runtime bails out on an unusable position', () => {
    // The overlay could not resolve the tour at all; handing that position back would put the
    // user straight into the same dead overlay.
    const tutorial = useTutorialStore()
    tutorial.startTour('gone-away')
    tutorial.setStepIndex(2)
    tutorial.stopTour({ resumable: false })
    expect(tutorial.interruptedAt('gone-away')).toBeNull()
  })
})
