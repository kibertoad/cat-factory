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

describe('useTutorialStore catalogue', () => {
  it('opens over the launch prompt without answering it', () => {
    // Browsing the full list is not "no thanks" — it is the opposite — so the offer must
    // return next launch if the user browses and starts nothing. And the two are modals:
    // leaving the prompt open would stack them.
    const tutorial = useTutorialStore()
    tutorial.maybeOfferOnLaunch()
    tutorial.openCatalogue()
    expect(tutorial.catalogueOpen).toBe(true)
    expect(tutorial.promptOpen).toBe(false)
    expect(tutorial.decision).toBeNull()
  })

  it('closes when a tour starts or resumes from it', () => {
    const tutorial = useTutorialStore()
    tutorial.openCatalogue()
    tutorial.startTour('board-basics')
    expect(tutorial.catalogueOpen).toBe(false)

    tutorial.setStepIndex(2)
    tutorial.stopTour()
    tutorial.openCatalogue()
    tutorial.resumeTour('board-basics')
    expect(tutorial.catalogueOpen).toBe(false)
  })

  it('reports its own window as open, so the coach marks stand down', () => {
    // The overlay renders at z-[70] to sit ABOVE the app's modals, since a step legitimately
    // points into one. The catalogue is openable mid-tour (that is what the `continue` action
    // is for), and there the same z-index would float a ring and a tooltip over the window the
    // user just opened. The tour itself is untouched — only the marks go.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    expect(tutorial.ownWindowOpen).toBe(false)

    tutorial.openCatalogue()
    expect(tutorial.ownWindowOpen).toBe(true)
    expect(tutorial.activeTourId).toBe('board-basics')

    tutorial.closeCatalogue()
    expect(tutorial.ownWindowOpen).toBe(false)

    tutorial.openPrompt()
    expect(tutorial.ownWindowOpen).toBe(true)
  })

  it('resets every record of progress, including the answered offer', () => {
    // What someone handing the app to a colleague is asking for: the first-launch experience
    // back. Clearing only the completion list would leave the offer answered, so the prompt
    // they are trying to demo would never appear.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    tutorial.startTour('run-task')
    tutorial.setStepIndex(2)
    tutorial.stopTour()

    tutorial.offerNudge('answer-park')
    tutorial.resetProgress()
    expect(tutorial.completedTourIds).toEqual([])
    expect(tutorial.interruptedAt('run-task')).toBeNull()
    expect(tutorial.decision).toBeNull()
    // The spent contextual offers go too, or a board that has already run something would
    // never make them again to the colleague the app was just handed to.
    expect(tutorial.nudgedTourIds).toEqual([])
    expect(tutorial.pendingNudgeId).toBeNull()
    expect(tutorial.wasNudged('answer-park')).toBe(false)
  })

  it('leaves a running tour alone when progress is reset', () => {
    // A click about history must not end the walkthrough the user is in the middle of —
    // which would also leave it unrecorded, since nothing marks a stopped tour complete.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(2)
    tutorial.resetProgress()
    expect(tutorial.activeTourId).toBe('board-basics')
    expect(tutorial.stepIndex).toBe(2)
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

  it('keeps another tour’s resume point when a different tour is started from the top', () => {
    // Starting a tour discards ITS own stale position, not somebody else's. Glancing at
    // another tour and pressing Esc at step 0 must not cost the position you were coming
    // back to — that one loses the single slot only when this tour is broken off past step 0.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.setStepIndex(3)
    tutorial.stopTour()

    tutorial.startTour('run-task')
    tutorial.stopTour()
    expect(tutorial.interruptedAt('board-basics')).toBe(3)

    // ...and it does lose it the moment the other tour is broken off past its first step.
    tutorial.startTour('run-task')
    tutorial.setStepIndex(1)
    tutorial.stopTour()
    expect(tutorial.interruptedAt('board-basics')).toBeNull()
    expect(tutorial.interruptedAt('run-task')).toBe(1)
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

describe('useTutorialStore contextual offer', () => {
  it('raises the offer and spends the id in one act', () => {
    // The guard against re-offering is the PERSISTED list, not the visible state, so an offer
    // cannot be made twice however many times the live gates flip.
    const tutorial = useTutorialStore()
    tutorial.offerNudge('answer-park')
    expect(tutorial.pendingNudgeId).toBe('answer-park')
    expect(tutorial.wasNudged('answer-park')).toBe(true)
  })

  it('never re-raises an offer already spent, even once dismissed', () => {
    const tutorial = useTutorialStore()
    tutorial.offerNudge('answer-park')
    tutorial.dismissNudge()
    expect(tutorial.pendingNudgeId).toBeNull()
    tutorial.offerNudge('answer-park')
    expect(tutorial.pendingNudgeId).toBeNull()
    expect(tutorial.nudgedTourIds).toEqual(['answer-park'])
  })

  it('holds one offer at a time, keeping the newer arrival', () => {
    const tutorial = useTutorialStore()
    tutorial.offerNudge('answer-park')
    tutorial.offerNudge('diagnose-failure')
    expect(tutorial.pendingNudgeId).toBe('diagnose-failure')
    expect(tutorial.nudgedTourIds).toEqual(['answer-park', 'diagnose-failure'])
  })
})

describe('useTutorialStore server reconciliation', () => {
  it('unions the server copy into the local one, keeping what only this browser knew', () => {
    // Both lists are grow-only sets of things that HAPPENED, so neither side may un-say one. A
    // replace here loses a tour finished while the mirror write was failing.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    const pushNeeded = tutorial.mergeServerProgress({
      decision: 'accepted',
      completedTourIds: ['first-task'],
      nudgedTourIds: [],
    })
    expect(tutorial.completedTourIds).toEqual(['first-task', 'board-basics'])
    // This browser held something the server did not, so the mirror owes it a write.
    expect(pushNeeded).toBe(true)
    expect(tutorial.serverPushNeeded).toBe(true)
  })

  it('asks for no push when the server copy is already a superset', () => {
    // The ordinary reload. Writing anyway would mean every board load posted a mirror nobody reads.
    const tutorial = useTutorialStore()
    expect(
      tutorial.mergeServerProgress({
        decision: 'accepted',
        completedTourIds: ['board-basics'],
        nudgedTourIds: ['answer-park'],
      }),
    ).toBe(false)
    expect(tutorial.completedTourIds).toEqual(['board-basics'])
    expect(tutorial.serverPushNeeded).toBe(false)
  })

  it('never duplicates an id both sides already hold', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    tutorial.mergeServerProgress({
      decision: null,
      completedTourIds: ['board-basics'],
      nudgedTourIds: [],
    })
    expect(tutorial.completedTourIds).toEqual(['board-basics'])
  })

  it('takes the server decision, but never clears a local one with an absent row', () => {
    // The decision is a preference someone re-answers, so the shared record wins when it has an
    // answer. A server row with no answer is not evidence that the local answer never happened.
    const tutorial = useTutorialStore()
    tutorial.decline()
    tutorial.markServerPushed()
    tutorial.mergeServerProgress({
      decision: null,
      completedTourIds: [],
      nudgedTourIds: [],
    })
    expect(tutorial.decision).toBe('declined')
    expect(tutorial.serverPushNeeded).toBe(true)

    tutorial.markServerPushed()
    tutorial.mergeServerProgress({
      decision: 'accepted',
      completedTourIds: [],
      nudgedTourIds: [],
    })
    expect(tutorial.decision).toBe('accepted')
  })

  it('holds an UN-MIRRORED local answer against the server, so a failed push cannot undo it', () => {
    // The mirror is best-effort, so a decline can be sitting in this browser and nowhere else. If
    // the snapshot re-adopted the older server answer, "No thanks" would silently come back as
    // "accepted" and every contextual offer the user just declined would re-arm.
    const tutorial = useTutorialStore()
    tutorial.decline()
    expect(
      tutorial.mergeServerProgress({
        decision: 'accepted',
        completedTourIds: [],
        nudgedTourIds: [],
      }),
    ).toBe(true)
    expect(tutorial.decision).toBe('declined')

    // Once the answer HAS been mirrored, the shared record is authoritative again: another machine
    // re-answering is a real change, and this browser has nothing newer to defend.
    tutorial.markServerPushed()
    tutorial.mergeServerProgress({ decision: 'accepted', completedTourIds: [], nudgedTourIds: [] })
    expect(tutorial.decision).toBe('accepted')
  })

  it('treats an absent server copy as nothing to reconcile, not as an empty one', () => {
    // No accounts, no store wired, or a degraded read. Pushing here would write a mirror on a
    // deployment that has nowhere to put it; clearing would be worse.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    expect(tutorial.mergeServerProgress(null)).toBe(false)
    expect(tutorial.completedTourIds).toEqual(['board-basics'])
    expect(tutorial.serverPushNeeded).toBe(false)
  })

  it('clears the push request once the mirror has caught up', () => {
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    tutorial.mergeServerProgress({ decision: null, completedTourIds: [], nudgedTourIds: [] })
    expect(tutorial.serverPushNeeded).toBe(true)
    tutorial.markServerPushed()
    expect(tutorial.serverPushNeeded).toBe(false)
  })

  it('re-arms the push when a merge RESPONSE comes back missing something local', () => {
    // What makes the server's un-guarded merge safe. Two concurrent merges can lose one writer's
    // ids, and the loser finds out because the response it gets back is a row without them. The
    // ordering is the load-bearing part: the push is marked done FIRST, so re-arming flips the flag
    // and re-triggers the mirror rather than being swallowed by a later clear.
    const tutorial = useTutorialStore()
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    tutorial.markServerPushed()
    expect(tutorial.serverPushNeeded).toBe(false)
    tutorial.mergeServerProgress({
      decision: 'accepted',
      completedTourIds: ['first-task'],
      nudgedTourIds: [],
    })
    expect(tutorial.serverPushNeeded).toBe(true)
  })
})

describe('useTutorialStore local revision (what the mirror watches)', () => {
  it('counts only what the USER did, never what the server told us', () => {
    // The mirror watches this instead of the state, because adopting the server's own ids is a
    // state change too: watching the state posts the server's row straight back at it on every
    // fresh-browser board load.
    const tutorial = useTutorialStore()
    const before = tutorial.localRev
    tutorial.mergeServerProgress({
      decision: 'accepted',
      completedTourIds: ['board-basics', 'first-task'],
      nudgedTourIds: ['answer-park'],
    })
    expect(tutorial.completedTourIds).toEqual(['board-basics', 'first-task'])
    expect(tutorial.localRev).toBe(before)

    tutorial.startTour('run-task')
    tutorial.completeTour()
    expect(tutorial.localRev).toBeGreaterThan(before)
  })

  it('does not bump on a re-recorded completion, an unchanged answer, or a reset', () => {
    const tutorial = useTutorialStore()
    // Two real changes: the accept `startTour` writes, and the completion.
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    const settled = tutorial.localRev
    expect(settled).toBe(2)

    // Repeating the same tour changes nothing that is persisted: the answer is already 'accepted'
    // and the completion is already recorded, so there is nothing for the mirror to carry.
    tutorial.startTour('board-basics')
    tutorial.completeTour()
    expect(tutorial.localRev).toBe(settled)

    // A reset's server side is a DELETE. A push of the freshly-emptied state racing it would
    // re-create the row the DELETE removed, leaving "reset it" distinguishable from "never touched
    // the tutorial" — the one thing the reset has to get right.
    tutorial.resetProgress()
    expect(tutorial.localRev).toBe(settled)
    expect(tutorial.serverPushNeeded).toBe(false)
  })
})
