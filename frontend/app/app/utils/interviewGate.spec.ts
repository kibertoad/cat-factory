import { describe, it, expect } from 'vitest'
import {
  DOC_INTERVIEWER_KIND,
  INITIATIVE_INTERVIEWER_KIND,
  interviewGatePhase,
  interviewStepReached,
} from './interviewGate'
import type { ExecutionInstance } from '~/types/domain'

// `interviewGatePhase` is what stops continue/proceed reading as no-ops in BOTH interview windows
// (initiative planning, document interview): the resume is asynchronous — the HTTP call only wakes
// the durable driver, so it returns the PRE-resume entity — and these pin that the RUN status is
// what distinguishes "parked, waiting on you" from "a pass is running", a distinction the entity
// alone cannot make.

/** The interview step has been reached — the default for every case not about the split below. */
const REACHED = true

describe('interviewGatePhase', () => {
  it('is awaiting while the run is parked on the human', () => {
    expect(interviewGatePhase('awaiting', 'blocked', REACHED)).toBe('awaiting')
  })

  it('is working once the resumed run is running again, even though the entity still says awaiting', () => {
    // The exact regression: continue/proceed leave the entity's status untouched until the pass
    // finishes, so an entity-only reading renders the same questions and looks like a dead button.
    expect(interviewGatePhase('awaiting', 'running', REACHED)).toBe('working')
  })

  it('is working for the FIRST pass, before any question exists', () => {
    expect(interviewGatePhase(undefined, 'running', REACHED)).toBe('working')
  })

  it('is failed when the run stopped before the interview settled', () => {
    // Must not stay `working`: a pass that dies would otherwise spin forever.
    expect(interviewGatePhase('awaiting', 'failed', REACHED)).toBe('failed')
    expect(interviewGatePhase(undefined, 'failed', REACHED)).toBe('failed')
  })

  it('is converged once the interview settled, whatever the run went on to do', () => {
    // `converged` outranks `failed`: a later step's failure belongs to that step, not the
    // interview, and the block's own failure surface reports it.
    expect(interviewGatePhase('done', 'running', REACHED)).toBe('converged')
    expect(interviewGatePhase('done', 'failed', REACHED)).toBe('converged')
    expect(interviewGatePhase('done', undefined, REACHED)).toBe('converged')
  })

  it('is idle when the interview never ran', () => {
    expect(interviewGatePhase(undefined, undefined, REACHED)).toBe('idle')
  })

  it('degrades to the entity-only reading when the run is not cached', () => {
    // A window opened before the execution snapshot lands must show the questions, never a spinner.
    expect(interviewGatePhase('awaiting', undefined, REACHED)).toBe('awaiting')
  })

  it('keeps a paused run answerable', () => {
    expect(interviewGatePhase('awaiting', 'paused', REACHED)).toBe('awaiting')
  })
})

// Neither interview leads its pipeline — initiative planning explores the codebase first, the
// document pipeline researches and outlines first — and that lead-in is minutes of container work.
// Reported as `working` it claims an interviewer is chewing on answers the human was never asked
// for; these pin the split.
describe('interviewGatePhase — before the interview step is reached', () => {
  it('is preparing while an EARLIER step is running', () => {
    expect(interviewGatePhase(undefined, 'running', false)).toBe('preparing')
  })

  it('does not offer a stale previous round to answer during the lead-in', () => {
    // On a re-plan the entity still carries the last run's questions until the gate's
    // `resetForFreshRun` fires, which is now AFTER the lead-in. Reading those as `awaiting` would
    // invite the human to answer a round about to be discarded.
    expect(interviewGatePhase('awaiting', 'running', false)).toBe('preparing')
  })

  it('still reports a settled or failed run over the lead-in', () => {
    expect(interviewGatePhase('done', 'running', false)).toBe('converged')
    expect(interviewGatePhase(undefined, 'failed', false)).toBe('failed')
  })

  it('is unchanged when the run is not running at all', () => {
    expect(interviewGatePhase('awaiting', 'blocked', false)).toBe('awaiting')
    expect(interviewGatePhase(undefined, undefined, false)).toBe('idle')
  })
})

const run = (kinds: string[], currentStep: number) =>
  ({ steps: kinds.map((agentKind) => ({ agentKind })), currentStep }) as Pick<
    ExecutionInstance,
    'steps' | 'currentStep'
  >

describe('interviewStepReached', () => {
  const PLANNING = ['initiative-analyst', INITIATIVE_INTERVIEWER_KIND, 'initiative-planner']

  it('is false while an earlier step is current', () => {
    expect(interviewStepReached(run(PLANNING, 0), INITIATIVE_INTERVIEWER_KIND)).toBe(false)
  })

  it('is true from the interview step onward', () => {
    expect(interviewStepReached(run(PLANNING, 1), INITIATIVE_INTERVIEWER_KIND)).toBe(true)
    expect(interviewStepReached(run(PLANNING, 2), INITIATIVE_INTERVIEWER_KIND)).toBe(true)
  })

  it('degrades to true when the run is not cached yet', () => {
    // Over-reporting "still preparing" would leave a genuinely parked interview looking dormant,
    // which is worse than generic copy — so an unknown run keeps the pre-existing reading.
    // Both spellings of "no run": `useResultViewRunMeta` resolves to null, a store lookup to
    // undefined, and the two windows use one each.
    expect(interviewStepReached(undefined, INITIATIVE_INTERVIEWER_KIND)).toBe(true)
    expect(interviewStepReached(null, INITIATIVE_INTERVIEWER_KIND)).toBe(true)
  })

  it('degrades to true for a chain carrying no such step', () => {
    expect(
      interviewStepReached(run(['doc-researcher', 'doc-writer'], 0), DOC_INTERVIEWER_KIND),
    ).toBe(true)
  })

  it('locates the document interviewer behind its own lead-in', () => {
    const authoring = run(['doc-researcher', 'doc-outliner', DOC_INTERVIEWER_KIND], 1)
    expect(interviewStepReached(authoring, DOC_INTERVIEWER_KIND)).toBe(false)
  })
})
