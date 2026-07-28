import { describe, it, expect } from 'vitest'
import { interviewGatePhase } from './interviewGate'

// `interviewGatePhase` is what stops continue/proceed reading as no-ops in BOTH interview windows
// (initiative planning, document interview): the resume is asynchronous — the HTTP call only wakes
// the durable driver, so it returns the PRE-resume entity — and these pin that the RUN status is
// what distinguishes "parked, waiting on you" from "a pass is running", a distinction the entity
// alone cannot make.

describe('interviewGatePhase', () => {
  it('is awaiting while the run is parked on the human', () => {
    expect(interviewGatePhase('awaiting', 'blocked')).toBe('awaiting')
  })

  it('is working once the resumed run is running again, even though the entity still says awaiting', () => {
    // The exact regression: continue/proceed leave the entity's status untouched until the pass
    // finishes, so an entity-only reading renders the same questions and looks like a dead button.
    expect(interviewGatePhase('awaiting', 'running')).toBe('working')
  })

  it('is working for the FIRST pass, before any question exists', () => {
    expect(interviewGatePhase(undefined, 'running')).toBe('working')
  })

  it('is failed when the run stopped before the interview settled', () => {
    // Must not stay `working`: a pass that dies would otherwise spin forever.
    expect(interviewGatePhase('awaiting', 'failed')).toBe('failed')
    expect(interviewGatePhase(undefined, 'failed')).toBe('failed')
  })

  it('is converged once the interview settled, whatever the run went on to do', () => {
    // `converged` outranks `failed`: a later step's failure belongs to that step, not the
    // interview, and the block's own failure surface reports it.
    expect(interviewGatePhase('done', 'running')).toBe('converged')
    expect(interviewGatePhase('done', 'failed')).toBe('converged')
    expect(interviewGatePhase('done', undefined)).toBe('converged')
  })

  it('is idle when the interview never ran', () => {
    expect(interviewGatePhase(undefined, undefined)).toBe('idle')
  })

  it('degrades to the entity-only reading when the run is not cached', () => {
    // A window opened before the execution snapshot lands must show the questions, never a spinner.
    expect(interviewGatePhase('awaiting', undefined)).toBe('awaiting')
  })

  it('keeps a paused run answerable', () => {
    expect(interviewGatePhase('awaiting', 'paused')).toBe('awaiting')
  })
})
