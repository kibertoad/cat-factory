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
function pairRegistry(
  producerSurface: 'container-explore' | 'container-coding',
): AgentKindRegistry {
  const registry = defaultAgentKindRegistry()
  // The producer's SURFACE is load-bearing for the stall rule and nothing else here: it is what
  // says whether the step's `output` is the work (an explore returns its plan) or merely a summary
  // of work that went into a branch (`container-coding`). Declared rather than defaulted so a case
  // asserting one behaviour can never be reading the other by accident.
  registry.register({
    kind: 'architect',
    systemPrompt: 'You design.',
    agent: { surface: producerSurface },
  })
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
    // Budget SPENT: one automatic rework performed out of one allowed, which is the state the cap
    // branch reads. The verdict that drove that rework is recorded, because a step cannot have spent
    // a round without having graded, and the budget is adopted off exactly that list.
    companion: {
      threshold: 0.8,
      maxAttempts: 1,
      attempts: 1,
      verdicts: [{ rating: 0.4, threshold: 0.8, passed: false, feedback: 'too vague' }],
    },
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
function harness(
  autonomy: 'attended' | 'unattended',
  companionMaxReworks = 1,
  producerSurface: 'container-explore' | 'container-coding' = 'container-explore',
) {
  const registry = pairRegistry(producerSurface)
  const park = vi.fn(async () => ({ kind: 'awaiting_decision' as const, decisionId: 'appr_1' }))
  const settle = vi.fn(async () => ({ kind: 'continue' as const }))
  const loop = vi.fn()
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
      loopCompanionProducer: loop,
      pauseStepForInput: (s: PipelineStep) => {
        s.state = 'waiting_decision'
      },
    } as never,
    resolveRiskPolicy: async () => ({ companionMaxReworks, autonomy }),
  })
  return { controller, park, settle, loop }
}

/** A verdict BELOW the step's 0.8 threshold, so the cap branch is the one reached. */
const BELOW = { output: '', custom: { rating: 0.4, summary: 'the design is still vague' } }

/**
 * A verdict ABOVE the threshold that still raised a point, which is what a real review almost
 * always looks like: a grade the producer cleared plus something to fix next time.
 */
const ABOVE_WITH_COMMENTS = {
  output: '',
  custom: {
    rating: 0.95,
    summary: 'the design holds up; one gap worth closing',
    comments: [{ anchorId: 'architect-companion-1', body: 'name the failure mode here' }],
  },
}

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
      // What it was handed to revise, byte-identical to what it returned. `reviewer` because this
      // loop asked for it: a human-requested re-run consumes no budget and is not this rule's
      // business (see `companionProgress.logic.ts`).
      rework: { previousProposal: 'the design', feedback: 'still vague', requestedBy: 'reviewer' },
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

  it('keeps looping when the producer delivers a COMMIT rather than its reply', async () => {
    // The shipped `reviewer`/`coder` pair. Byte-identical summaries across two rounds at an unmoved
    // rating is the exact evidence this rule fires on, and for a `container-coding` producer it is
    // no evidence at all: the work went to the branch, which is why its reviewer clones the repo.
    // Cutting that loop short would abandon rework rounds on a coder that had pushed real changes.
    const { controller, park, settle } = harness('attended', 1, 'container-coding')
    const inst = stalledInstance()

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

  it('keeps looping when a HUMAN asked for the re-run', async () => {
    // `requestChanges` on the companion's gate re-runs the producer with a person's own feedback and
    // spends none of the automatic budget, so a standstill read off it would abandon rounds that
    // were never used — and it is the one rework where somebody is genuinely waiting for an answer.
    const { controller, park, settle } = harness('attended')
    const inst = stalledInstance()
    ;(inst.steps[0] as PipelineStep).rework = {
      previousProposal: 'the design',
      feedback: 'make it simpler',
      requestedBy: 'human',
    }

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
    expect(inst.steps[1]!.companion?.stalled).toBeUndefined()
    expect(settle).not.toHaveBeenCalled()
  })
})

// WHERE the budget comes from. The step is seeded with the catalog default at run start, before any
// policy is resolved, so a policy that states a different ceiling has to be adopted somewhere, and
// the guard on that read is the whole subtlety: adopt it once, or a later read reports a ceiling the
// step no longer has. Both ways a step can grade twice on an unspent budget are covered here,
// because "once" off the wrong field holds for only one of them.

/** A companion step that has graded nothing yet, carrying the run-start default. */
function fresh(): ExecutionInstance {
  const inst = instance()
  inst.steps[1] = step({
    companion: { threshold: 0.8, maxAttempts: 3, attempts: 0, verdicts: [] },
  })
  return inst
}

describe('the rework budget', () => {
  it('is adopted from the risk policy on the first grading', async () => {
    const { controller, loop } = harness('attended', 5)
    const inst = fresh()

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(inst.steps[1]!.companion?.maxAttempts).toBe(5)
    expect(loop).toHaveBeenCalledOnce()
  })

  it('parks on the first verdict when the policy allows no automatic rework', async () => {
    const { controller, park, loop } = harness('attended', 0)
    const inst = fresh()

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

    // `0` is a posture, not a disabled loop: the verdict still landed, it just goes to the person
    // this policy says decides instead of being spent on a round.
    expect(loop).not.toHaveBeenCalled()
    expect(park).toHaveBeenCalledOnce()
    expect(result.kind).toBe('awaiting_decision')
    expect(inst.steps[1]!.companion?.exceeded).toBe(true)
  })

  /** A verdict this step already recorded, so the next grading is not its first. */
  function graded(rating: number, passed = false) {
    return { rating, threshold: 0.8, passed, feedback: 'the design is still vague' }
  }

  it('does not revoke the extra round a person granted at the cap', async () => {
    // The state `resolveCompanionExceeded` really leaves behind. It raises THIS step's budget to 4
    // and, through `loopCompanionProducer`, charges the round it just granted, so a granted step is
    // always spent to its new ceiling rather than one below it. Re-reading the policy on this
    // grading would put the ceiling back to 3 and record a step that "reached its rework limit of
    // 3 attempts" after somebody had paid for a 4th.
    const { controller, park, loop } = harness('attended', 3)
    const inst = instance()
    inst.steps[1] = step({
      companion: {
        threshold: 0.8,
        maxAttempts: 4,
        attempts: 4,
        verdicts: [graded(0.4), graded(0.4), graded(0.4), graded(0.4)],
      },
    })

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(inst.steps[1]!.companion?.maxAttempts).toBe(4)
    // The granted round was charged when it was granted, so this grading is the one that reports
    // back: no further automatic round, and the person who granted it is asked again.
    expect(loop).not.toHaveBeenCalled()
    expect(park).toHaveBeenCalledOnce()
  })

  it('is not re-read on a re-grade a human drove, which charges no round', async () => {
    // The OTHER way a step grades twice with `attempts` still 0: its first verdict passed, the
    // pipeline's own gate raised, and the human answered "request changes". `requestStepChanges`
    // re-runs the producer without charging the automatic budget on purpose (a person's iteration is
    // unbounded), so the re-grade arrives on an unspent budget. Read off `attempts` alone, the
    // policy would be resolved again here and this step would silently move to whatever ceiling the
    // policy states NOW.
    const { controller, loop } = harness('attended', 5)
    const inst = instance()
    inst.steps[1] = step({
      companion: { threshold: 0.8, maxAttempts: 3, attempts: 0, verdicts: [graded(0.9, true)] },
    })

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, { ...BELOW })

    expect(inst.steps[1]!.companion?.maxAttempts).toBe(3)
    expect(loop).toHaveBeenCalledOnce()
  })
})

// The FIRST-BATCH rule against the budget that pays for it. Any comments on a first review loop the
// producer back whatever it scored, because that first batch of findings is worth a round. The
// question this section settles is what happens when the policy has already said it buys none.

describe('a first batch of comments', () => {
  it('loops the producer even above the bar while a round is left to spend', async () => {
    const { controller, loop, park, settle } = harness('attended', 3)
    const inst = fresh()

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, {
      ...ABOVE_WITH_COMMENTS,
    })

    expect(loop).toHaveBeenCalledOnce()
    expect(park).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(inst.steps[1]!.companion?.verdicts.at(-1)?.passed).toBe(false)
  })

  it('advances on a rating that cleared the bar when the policy buys no round', async () => {
    // The whole point of `companionMaxReworks: 0`: the first verdict below the bar goes straight to
    // the person who decides. A verdict ABOVE the bar is not that verdict, and forcing the loop
    // anyway parked every companion step this policy governs, since a review that raises no point
    // at all is the rare one.
    const { controller, loop, park, settle } = harness('attended', 0)
    const inst = fresh()

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, {
      ...ABOVE_WITH_COMMENTS,
    })

    expect(settle).toHaveBeenCalledOnce()
    expect(loop).not.toHaveBeenCalled()
    expect(park).not.toHaveBeenCalled()
    expect(inst.steps[1]!.companion?.verdicts.at(-1)?.passed).toBe(true)
    expect(inst.steps[1]!.companion?.exceeded).toBeUndefined()
  })

  it('does not stamp a policy settlement on work that met its bar', async () => {
    // Same setup, unattended. `capSettledByPolicy` says a bar went unmet and policy waived it, and
    // it is read by whoever reviews the resulting pull request: stamping it on a 95% verdict is the
    // false claim the stamp exists to prevent, in the other direction.
    const { controller, settle } = harness('unattended', 0)
    const inst = fresh()

    await controller.resolveContainerVerdict(WS, inst, inst.steps[1]!, BLOCK, false, {
      ...ABOVE_WITH_COMMENTS,
    })

    expect(settle).toHaveBeenCalledOnce()
    expect(inst.steps[1]!.companion?.capSettledByPolicy).toBeUndefined()
  })
})
