import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '@cat-factory/agents'
import { CompanionController } from './CompanionController.js'

// The REWORK CAP: what a companion does when its automatic budget is spent and the producer is
// still below the bar. There are exactly two answers and the run's risk policy picks between them,
// so both are asserted here against the same setup, one flag apart.
//
// It is worth a test of its own because the failure it guards is silent in both directions. An
// unattended policy that still parks leaves an API-started run waiting on a person who is not
// coming (the bug this behaviour was added for, found by the headless acceptance suite). An
// attended policy that stopped parking would advance a board run past a bar its own operator set,
// and the run would look exactly like one that passed.
//
// `resolveContainerVerdict` is the entry point rather than `evaluate` because it takes the verdict
// as data: the cap decision does not depend on how the verdict was produced, and driving the
// inline path would mean faking a model call to assert something the model has no part in.

const WS = 'ws1'

/**
 * A registry holding ONE rework pair, registered through the public seam.
 *
 * `defaultAgentKindRegistry()` is empty by design (the built-ins install themselves through the
 * same seam a deployment uses), and the cap branch is reached only when the companion resolves a
 * PRODUCER to grade — with none, an unparseable verdict is irrelevant and the step passes. Naming
 * the pair here rather than pulling in the built-in catalog also states what the rule is about:
 * the cap belongs to the companion MACHINE, so a deployment's own pair hits it identically.
 */
function pairRegistry(): AgentKindRegistry {
  const registry = defaultAgentKindRegistry()
  registry.register({ kind: 'architect', systemPrompt: 'You design.' })
  registry.register({ kind: 'architect-companion', systemPrompt: 'You grade designs.' })
  registry.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
    surface: 'container-explore',
  })
  return registry
}

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'architect-companion',
    state: 'working',
    progress: 0,
    decision: null,
    requiresApproval: false,
    approval: null,
    // Budget SPENT: one automatic rework performed out of one allowed, which is the state the
    // cap branch reads. `verdicts` is left empty because nothing under test reads it.
    companion: { threshold: 0.8, maxAttempts: 1, attempts: 1, verdicts: [] },
    ...over,
  } as PipelineStep
}

function instance(): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Standard build',
    steps: [
      { agentKind: 'architect', state: 'done', progress: 1, decision: null, output: 'the design' },
      step(),
    ],
    currentStep: 1,
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
  } as ExecutionInstance
}

const BLOCK = { id: 'blk_1', title: 'A task' } as Block

/**
 * A controller wired with the collaborators the cap branch touches and nothing else.
 *
 * The two the assertions read are returned alongside it: `park` records whether the run stopped
 * for a person, and `settle` whether it advanced. Exactly one of them fires in each case, which is
 * what makes "did the policy decide" observable rather than inferred from the returned shape.
 */
function harness(autonomy: 'attended' | 'unattended') {
  const registry = pairRegistry()
  const park = vi.fn(async () => ({ kind: 'awaiting_decision' as const, decisionId: 'appr_1' }))
  const settle = vi.fn(async () => ({ kind: 'continue' as const }))
  const controller = new CompanionController({
    contextBuilder: {} as never,
    agentKindRegistry: registry,
    spend: {} as never,
    idGenerator: { next: (p: string) => `${p}_1` } as never,
    previewStepModel: async () => undefined,
    previewStepToolServers: async () => undefined,
    runAgent: async () => ({ output: '' }),
    stateMachine: {
      casPersist: async () => {},
      persistAndEmit: async () => {},
      raiseDecisionRequired: async () => {},
      parkStepOnDecision: park,
      settleStepAndAdvance: settle,
    } as never,
    stepGraph: {
      finishStep: () => {},
      loopCompanionProducer: () => {},
      pauseStepForInput: (s: PipelineStep) => {
        s.state = 'waiting_decision'
      },
    } as never,
    resolveRiskPolicy: async () => ({ autonomy }),
  })
  return { controller, park, settle }
}

/** A verdict BELOW the step's 0.8 threshold, so the cap branch is the one reached. */
const BELOW = { output: '', custom: { rating: 0.4, summary: 'the design is still vague' } }

describe('a companion at its rework cap', () => {
  it('parks for a person under an attended policy', async () => {
    const { controller, park, settle } = harness('attended')
    const inst = instance()
    const result = await controller.resolveContainerVerdict(
      WS,
      inst,
      inst.steps[1]!,
      BLOCK,
      false,
      {
        ...BELOW,
      },
    )

    expect(park).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
    expect(result.kind).toBe('awaiting_decision')
    // `exceeded` is what makes the park answerable as an iteration cap (the SPA renders the three
    // choices off it, and `dedicatedParkSurface` routes it to `companion-cap`).
    expect(inst.steps[1]!.companion?.exceeded).toBe(true)
    expect(inst.steps[1]!.companion?.capSettledByPolicy).toBeUndefined()
  })

  it('advances under an unattended policy, stamping WHY it got past the bar', async () => {
    const { controller, park, settle } = harness('unattended')
    const inst = instance()
    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(park).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledOnce()
    // NOT `exceeded`: nothing is waiting on a human, and a step flagged both ways would offer the
    // three cap choices for a decision already taken.
    expect(inst.steps[1]!.companion?.exceeded).toBeUndefined()
    // The stamp is the whole honesty of this branch. The last verdict says the producer was below
    // the bar; without it, a step that advanced anyway is indistinguishable from one whose
    // companion simply stopped grading.
    expect(inst.steps[1]!.companion?.capSettledByPolicy).toBe(true)
  })

  it('does NOT fire the stall flag when the budget simply ran out', async () => {
    // The two reach the same gate, so the flags are the only thing telling a reviewer which
    // happened. This is the setup with rounds genuinely spent and no standstill to report.
    const { controller } = harness('attended')
    const inst = instance()
    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(inst.steps[1]!.companion?.exceeded).toBe(true)
    expect(inst.steps[1]!.companion?.stalled).toBeUndefined()
  })

  it('still raises the pipeline OWN approval gate on a gated companion step', async () => {
    // The line the whole feature is drawn on: an unattended policy answers the parks the ENGINE
    // raises when its automation gives up, and never one the pipeline asked for. A step somebody
    // marked `requiresApproval` holds the run either way.
    const { controller, park, settle } = harness('unattended')
    const inst = instance()
    inst.steps[1] = step({ requiresApproval: true })
    const result = await controller.resolveContainerVerdict(
      WS,
      inst,
      inst.steps[1]!,
      BLOCK,
      false,
      {
        ...BELOW,
      },
    )

    expect(settle).not.toHaveBeenCalled()
    expect(result.kind).toBe('awaiting_decision')
    // The approval gate, not the cap gate: it carries a fresh approval id and no `exceeded`, so
    // the human is offered approve / request-changes rather than the three cap choices.
    expect(inst.steps[1]!.approval?.status).toBe('pending')
    expect(inst.steps[1]!.companion?.exceeded).toBeUndefined()
    expect(park).not.toHaveBeenCalled()
  })
})

/**
 * A companion loop that has stopped getting anywhere takes the SAME exit as one that ran out of
 * budget, with rounds still on the clock. Asserted through the controller rather than only over
 * the pure rule because the thing worth pinning is that it lands on the iteration-cap gate: an
 * early stop that invented its own park would need its own resolutions in the SPA, in
 * `IterationCapController` and in the risk policy, none of which exist.
 */
describe('a companion loop that has stopped making progress', () => {
  /** Budget deliberately UNSPENT (0 of 3), so only the stall can reach the cap branch. */
  function stalledInstance(): ExecutionInstance {
    const inst = instance()
    inst.steps[0] = {
      agentKind: 'architect',
      state: 'done',
      progress: 1,
      decision: null,
      output: 'the design',
      // What it was handed to revise, byte-identical to what it returned.
      rework: { previousProposal: 'the design', feedback: 'still vague' },
    } as PipelineStep
    inst.steps[1] = step({
      companion: {
        threshold: 0.8,
        maxAttempts: 3,
        attempts: 1,
        // The previous round's rating; this cycle's 0.4 verdict is appended before the check.
        verdicts: [{ rating: 0.4, threshold: 0.8, passed: false, feedback: 'still vague' }],
      },
    })
    return inst
  }

  it('parks on the iteration-cap gate with rounds still unspent, flagged as a stall', async () => {
    const { controller, park, settle } = harness('attended')
    const inst = stalledInstance()
    const result = await controller.resolveContainerVerdict(
      WS,
      inst,
      inst.steps[1]!,
      BLOCK,
      false,
      { ...BELOW },
    )

    expect(park).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
    expect(result.kind).toBe('awaiting_decision')
    const companion = inst.steps[1]!.companion
    // `exceeded` too, because that is what makes the park ANSWERABLE (`resolveCompanionExceeded`
    // refuses a step without it, and `dedicatedParkSurface` routes on it). `stalled` is what says
    // the budget was abandoned rather than spent.
    expect(companion?.exceeded).toBe(true)
    expect(companion?.stalled).toBe(true)
    expect(companion?.attempts).toBeLessThan(companion!.maxAttempts)
  })

  it('settles by policy on an unattended run rather than waiting for nobody', async () => {
    const { controller, park, settle } = harness('unattended')
    const inst = stalledInstance()
    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(park).not.toHaveBeenCalled()
    expect(settle).toHaveBeenCalledOnce()
    // Both stamps: the loop was abandoned as unproductive AND policy answered the resulting gate.
    // They are different facts and a reviewer of the pull request needs each.
    expect(inst.steps[1]!.companion?.stalled).toBe(true)
    expect(inst.steps[1]!.companion?.capSettledByPolicy).toBe(true)
    expect(inst.steps[1]!.companion?.exceeded).toBeUndefined()
  })

  it('keeps looping when the producer changed the work, even at an unmoved rating', async () => {
    const { controller, park, settle } = harness('attended')
    const inst = stalledInstance()
    ;(inst.steps[0] as PipelineStep).output = 'the design, now with a queue'

    const result = await controller.resolveContainerVerdict(
      WS,
      inst,
      inst.steps[1]!,
      BLOCK,
      false,
      { ...BELOW },
    )

    expect(result.kind).toBe('continue')
    expect(park).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(inst.steps[1]!.companion?.stalled).toBeUndefined()
  })
})
