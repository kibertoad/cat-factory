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
