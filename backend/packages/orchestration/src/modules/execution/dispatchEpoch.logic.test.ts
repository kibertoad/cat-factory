import { describe, expect, it } from 'vitest'
import type { AgentJobHandle, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { dispatchEpochFor, recordDispatchAttribution } from './step-fold.logic.js'
import { StepGraph } from './StepGraph.js'

// A re-dispatched job must get a FRESH harness job id, or a container-reusing transport (a warm
// local pool / a self-hosted runner pool) re-attaches to the earlier round's COMPLETED job and
// replays its result: no model call, no new work, and a loop that cannot converge.
//
// These drive the real writer (`recordDispatchAttribution`, the funnel every dispatch site calls)
// and the real reset (`StepGraph`), not hand-built counters. That is the point: the epoch's
// monotonicity is a property of that pair, and the scheme this replaced — a sum of six per-loop
// counters — was broken precisely where a reset moved one of them (`restartRalphState` zeroes
// `ralph.attempts`, so the sum could go DOWN onto an id the harness already held).

const handle = { jobId: 'job_1' } as AgentJobHandle

const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: 'architect', state: 'working', progress: 0, ...over }) as PipelineStep

const run = (...steps: PipelineStep[]): ExecutionInstance =>
  ({ id: 'exec_1', steps, currentStep: 0 }) as ExecutionInstance

/** The engine's own reset, so a test cannot disagree with it about what a loop-back preserves. */
const graph = (): StepGraph => new StepGraph({ now: (): number => 1_700_000_000_000 })

describe('dispatchEpochFor', () => {
  it('is 0 for the run’s FIRST job of a kind, so its id stays unsuffixed', () => {
    expect(dispatchEpochFor(run(step()), 'architect')).toBe(0)
  })

  it('counts the run’s prior dispatches of that kind, so every re-dispatch is a new job', () => {
    const s = step()
    const instance = run(s)
    expect(dispatchEpochFor(instance, 'architect')).toBe(0)
    recordDispatchAttribution(s, handle, 'architect')
    expect(dispatchEpochFor(instance, 'architect')).toBe(1)
    recordDispatchAttribution(s, handle, 'architect')
    expect(dispatchEpochFor(instance, 'architect')).toBe(2)
  })

  it('is per KIND, so a helper dispatched off the step never shifts the step’s own epoch', () => {
    // A gate escalating to its fixer, a Tester handing off, a two-phase coder proposing forks:
    // the helper's job id carries its own kind, so its rounds are counted separately.
    const s = step({ agentKind: 'ci' })
    const instance = run(s)
    recordDispatchAttribution(s, handle, 'ci-fixer')
    recordDispatchAttribution(s, handle, 'ci-fixer')
    expect(dispatchEpochFor(instance, 'ci-fixer')).toBe(2)
    expect(dispatchEpochFor(instance, 'ci')).toBe(0)
  })

  it('counts across every STEP, so one helper kind on two steps cannot mint one id twice', () => {
    // `fixer` is dispatched as a helper off the tester, the visual-confirmation gate, the
    // human-test gate and a PR review's `fix`. A per-step count would give the first fix round on
    // each of them epoch 0 — the same `<run>-fixer` id, so the second re-attaches to the first's
    // completed job and replays its output onto a different step.
    const visual = step({ agentKind: 'visual-confirmation' })
    const humanTest = step({ agentKind: 'human-test' })
    const instance = run(visual, humanTest)
    recordDispatchAttribution(visual, handle, 'fixer')
    expect(dispatchEpochFor(instance, 'fixer')).toBe(1)
    recordDispatchAttribution(humanTest, handle, 'fixer')
    expect(dispatchEpochFor(instance, 'fixer')).toBe(2)
  })

  it('survives the loop-back reset, so a COMPANION rework round re-runs its producer', () => {
    // The regression this exists for. A companion loops its PRODUCER back (architect under
    // architect-companion, coder under reviewer, doc-writer under doc-reviewer) through
    // `resetStepForRerun`, which clears the live job handle. The round count lives on the
    // COMPANION step's `companion.attempts` and is not readable from the producer at all, so under
    // the old per-loop sum the producer's epoch stayed 0 every round: the harness replayed its
    // first completed job, and on a real run four architect dispatches produced ONE container
    // session and four identical `token_usage` rows while the rating sat at 0.76.
    const producer = step()
    const instance = run(producer)
    recordDispatchAttribution(producer, handle, 'architect')
    graph().resetStepForRerun(producer)
    expect(producer.jobId).toBeUndefined()
    expect(dispatchEpochFor(instance, 'architect')).toBe(1)
  })

  it('advances for a RALPH producer, whose own loop counter the reset ZEROES', () => {
    // The trap in the scheme this replaced: `resetStepForRerun` re-seeds ralph state through
    // `restartRalphState`, which zeroes `ralph.attempts`. A summed epoch that included it went
    // DOWN on a loop-back — straight onto an id an earlier iteration had already completed under.
    const producer = step({
      agentKind: 'coder',
      ralph: {
        phase: 'iterating',
        attempts: 2,
        maxIterations: 6,
        validationCommand: 'pnpm test',
        attemptLog: [],
      } as PipelineStep['ralph'],
    })
    const instance = run(producer)
    for (let i = 0; i < 3; i++) recordDispatchAttribution(producer, handle, 'coder')
    graph().resetStepForRerun(producer)
    expect(producer.ralph?.attempts).toBe(0)
    expect(dispatchEpochFor(instance, 'coder')).toBe(3)
  })

  it('is unmoved by an INLINE step, which mints no job id to collide with', () => {
    // Only a container dispatch records an attribution, and only a container dispatch has an id.
    expect(dispatchEpochFor(run(step({ agentKind: 'task-estimator' })), 'task-estimator')).toBe(0)
  })
})
