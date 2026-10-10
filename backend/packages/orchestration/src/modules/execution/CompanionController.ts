import type {
  AgentRunContext,
  AgentRunResult,
  Block,
  CompanionDispositionInput,
  CompanionDispositionResult,
  CompanionParkReason,
  ExecutionInstance,
  IdGenerator,
  Logger,
  PipelineStep,
} from '@cat-factory/kernel'
import {
  companionParkReasonFor,
  DEFAULT_RISK_POLICY,
  disposeCompanionVerdict,
  sumAgentTokenUsage,
} from '@cat-factory/kernel'
import {
  type CompanionAssessment,
  type DispatchToolServers,
  parseCompanionAssessment,
} from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { companionFor, companionTargets, deliverableIsReply } from '@cat-factory/agents'
import type { SpendService } from '@cat-factory/spend'
import { extractJson } from '../requirements/requirements.logic.js'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import { companionLoopStalled } from './companionProgress.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { resolvesOwnCaps, type ResolvedRunRiskPolicy, type RunPolicyScope } from './policy-types.js'
import { buildStepApproval } from './stepApproval.js'
import { recordInlineToolServers } from './step-fold.logic.js'
import type { StepGraph } from './StepGraph.js'

/** Parse a companion's JSON verdict from a model reply, or `undefined` if it won't parse. */
function parseCompanionOrUndefined(output: string | undefined): CompanionAssessment | undefined {
  try {
    return parseCompanionAssessment(extractJson(output ?? ''))
  } catch {
    return undefined
  }
}

/**
 * Parse the verdict of a CONTAINER-backed companion. A structured explore returns the verdict
 * as `result.custom` (already a parsed object), so validate that first; fall back to the reply
 * text for a model that emitted the JSON inline instead. `undefined` when neither parses — the
 * caller then surfaces it for a human rather than treating it as a pass.
 */
function parseContainerVerdict(result: AgentRunResult): CompanionAssessment | undefined {
  if (result.custom !== undefined) {
    try {
      return parseCompanionAssessment(result.custom)
    } catch {
      // Fall back to the reply text below.
    }
  }
  return parseCompanionOrUndefined(result.output)
}

/**
 * The slice of the run's resolved risk policy this loop reads: the automatic rework budget, and
 * whether policy answers the park that spending it raises. A `Pick` rather than a restated shape, so
 * a field renamed on the resolved policy fails to compile here.
 */
type CompanionRiskPolicy = Pick<ResolvedRunRiskPolicy, 'companionMaxReworks' | 'autonomy'>

/**
 * The engine flow-control operations the companion loop drives. These stay on
 * `ExecutionService` (they are the shared state-machine primitives, reused by the human
 * "request changes" path and the iteration-cap resolution) and are injected here so the
 * companion evaluation can live in its own unit without duplicating them.
 */
export interface CompanionControllerDeps {
  contextBuilder: AgentContextBuilder
  /**
   * The app-owned agent-kind registry, so a DEPLOYMENT-registered companion is driven by this
   * loop on the same terms as a built-in: its targets found by the same producer search, its
   * default threshold read from its own registration.
   */
  agentKindRegistry: AgentKindRegistry
  spend: SpendService
  idGenerator: IdGenerator
  previewStepModel: (context: AgentRunContext) => Promise<string | undefined>
  previewStepToolServers: (context: AgentRunContext) => Promise<DispatchToolServers | undefined>
  runAgent: (context: AgentRunContext, options: AdvanceOptions) => Promise<AgentRunResult>
  /** The async instance/block spine (persist/emit/park/finalize/progress/notify/stop). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/park a step + the companion rework loop). */
  stepGraph: StepGraph
  /**
   * The run's risk policy, read for ONE decision here: whether exhausting the automatic rework
   * budget parks for a person or is answered by policy
   * ({@link CompanionController.settlesCapUnattended}). The BUDGET itself is not read here — it is
   * resolved at run start, because the first grading's own prompt states how much of it is left.
   * Structurally typed to the fields it reads, so this collaborator stays independent of the merge
   * module.
   */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<CompanionRiskPolicy>
  /** Facade logger; absent in tests, where the cap decision is asserted off the step instead. */
  logger?: Logger
  /**
   * Infer + persist the block's `technical` label from the spec phase when the
   * spec-companion converges. Both signals are read off the persisted steps — the
   * spec-writer's `noBusinessSpecs` on the producer step and the companion's
   * `technicalCorroborated` on `companionStep` (recorded by this controller before the
   * call) — so the SAME inference also runs on a human "proceed" past the iteration cap,
   * where only the steps survive. A no-op for non-spec companions and when a human has
   * already set the label. Optional — unwired in tests / facades that don't pass it, so the
   * companion loop is unchanged.
   */
  inferTechnicalLabel?: (
    workspaceId: string,
    block: Block,
    producerStep: PipelineStep,
    companionStep: PipelineStep,
  ) => Promise<void>
}

/**
 * Drives a companion (reviewer / spec-companion / architect-companion) step: it runs the
 * companion as a normal inline LLM step, parses its verdict JSON (with one repair retry), and acts
 * on it. WHAT the verdict means is kernel's `disposeCompanionVerdict`; this owns the effects —
 *   - `pass` → finish; a gated companion raises the human approval gate on the producer's
 *     output, else the run advances.
 *   - `rework` → loop the producer back with the feedback folded in (the automatic analogue of
 *     "request changes"). Driven by an open `blocker` finding, by the first batch of findings, or
 *     by a rating below the bar.
 *   - `park` → the iteration-cap gate for a human (one more round / proceed / stop & reset), NOT
 *     a failure. An unattended risk policy answers that park when the loop merely ran out of
 *     rounds, never while a `blocker` is open.
 * A `rework` the loop has stopped getting anywhere with (`companionLoopStalled`) takes that same
 * park EARLY, on the rounds it abandoned, and is decided by the same rule so an open `blocker`
 * still parks as one.
 * An unparseable verdict (even after the repair retry) fails the run (`companion_rejected`)
 * rather than silently passing. Extracted out of `ExecutionService`; the shared step-graph
 * primitives it calls (`loopCompanionProducer`, the parking gate, the block/instance writes)
 * stay on the engine and are injected via {@link CompanionControllerDeps}.
 */
export class CompanionController {
  constructor(private readonly deps: CompanionControllerDeps) {}

  /**
   * Drive an INLINE companion (architect-companion / spec-companion): run it as a one-shot
   * LLM step that grades the producer's reported output text, then act on the verdict. A
   * container-backed companion (reviewer / doc-reviewer) does NOT take this path — it is
   * dispatched through the engine's async container path and resolved by
   * {@link resolveContainerVerdict}.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    options: AdvanceOptions,
  ): Promise<AdvanceResult> {
    const producerIndex = this.producerIndexFor(instance, step)

    // Run the companion as a normal inline LLM step: its prompt asks for the rating
    // JSON and `priorOutputs` already carries the producer's output for it to grade.
    const context = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    const previewModel = await this.deps.previewStepModel(context)
    if (previewModel && previewModel !== step.model) step.model = previewModel
    // The same dispatch-time fold the generic agent step applies: an inline companion is
    // consensus-eligible too, so a diverted one has a withheld tool-server list to record. Ahead of
    // the call rather than after it, because the repair retry re-runs the SAME context and would
    // report the identical resolution twice, and because a companion that throws must still leave a
    // step saying what it could not reach. Persisted here for that second reason: a throw
    // propagates past this method and the failure path re-reads the instance from storage, so an
    // unpersisted mutation is a record that exists only on the runs that did not need it.
    const ceiling = await this.deps.previewStepToolServers(context)
    if (ceiling) {
      recordInlineToolServers(step, ceiling, context.agentKind)
      await this.deps.stateMachine.persistAndEmit(workspaceId, instance)
    }
    // Run the companion, parsing its JSON verdict with ONE repair retry when the first
    // reply doesn't parse (truncated / wrapped in prose). Only retried when there is a
    // producer to grade. `result` carries the LAST call's output + the summed usage.
    const { assessment, result } = await this.runWithRepair(context, options, producerIndex >= 0)
    if (result.usage) {
      const billing = result.usageBilling ?? 'metered'
      await this.deps.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
        // Forwarded exactly as the generic step's `recordJobFacts` forwards it. Dropping the
        // two here filed every inline companion as metered spend, including the ones that ran
        // on the same subscription credential as the producer they were grading: one run's
        // `architect` counted as subscription usage and its `architect-companion`, one call
        // later on the same credential, as money.
        billing,
        vendor: result.usageVendor ?? null,
      })
      // And on the step, beside the metrics whose `costEstimate` it qualifies (see
      // `recordJobFacts`, which stamps the same fact for a generic agent step).
      step.usageBilling = billing
    }
    if (result.model) step.model = result.model

    return this.applyAssessment(workspaceId, instance, step, block, isFinalStep, {
      producerIndex,
      assessment,
      result,
    })
  }

  /**
   * Resolve a CONTAINER-backed companion (reviewer / doc-reviewer) whose read-only explore
   * job has just completed: it cloned the producer's PR branch, read the real repository, and
   * returned its verdict as structured JSON (`result.custom`, falling back to the reply text).
   * The threshold / rework-loop / human-gate handling is then identical to an inline companion
   * — the SAME {@link applyAssessment}. Spend is metered by `recordStepResult` (its single
   * funnel for every completed job), so this does not re-record it. Called from
   * `ExecutionService.recordStepResult` when a container companion's job finishes.
   */
  async resolveContainerVerdict(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<AdvanceResult> {
    const producerIndex = this.producerIndexFor(instance, step)
    if (result.model) step.model = result.model
    const assessment = parseContainerVerdict(result)
    return this.applyAssessment(workspaceId, instance, step, block, isFinalStep, {
      producerIndex,
      assessment,
      result,
    })
  }

  /** The nearest earlier step whose kind this companion reviews (the producer), or -1. */
  private producerIndexFor(instance: ExecutionInstance, step: PipelineStep): number {
    const targets = companionTargets(step.agentKind, this.deps.agentKindRegistry)
    for (let i = instance.currentStep - 1; i >= 0; i--) {
      if (targets.includes(instance.steps[i]!.agentKind)) return i
    }
    return -1
  }

  /**
   * Act on a companion's parsed verdict — shared by the inline ({@link evaluate}) and
   * container ({@link resolveContainerVerdict}) paths so both behave identically:
   *   - `pass` → finish; a gated companion raises the human approval gate, else the run advances;
   *   - `rework` → loop the producer back with the feedback folded in;
   *   - `park` → the iteration-cap gate, which an unattended policy answers only when the reason
   *     is a spent budget;
   *   - producer present but verdict unparseable → surface for a human (NOT a silent pass).
   *
   * Every instance write here goes through {@link RunStateMachine.casPersist}, not a blind
   * upsert: this runs on the DURABLE-DRIVER path (the `inline-companion` handler / the
   * `companion-verdict` completion interceptor), after a slow companion LLM call, so a
   * concurrent human action (a `stopRun`/`cancel`, an iteration-cap resolve) can move or
   * delete the row in the window. A lost race throws `RunContendedError`, caught by the
   * driver's `advanceInstance` / `redriveOnContention` envelope and re-driven on fresh state
   * — never clobbering the human write or resurrecting a cancelled run (race-audit 2.2 controller-half).
   */
  private async applyAssessment(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    grading: {
      producerIndex: number
      assessment: CompanionAssessment | undefined
      result: AgentRunResult
    },
  ): Promise<AdvanceResult> {
    const { producerIndex, assessment, result } = grading
    const companion = step.companion ?? {
      threshold: companionFor(step.agentKind, this.deps.agentKindRegistry)?.defaultThreshold ?? 0.8,
      // Never consulted: a step with a producer adopts the policy's budget below before any branch
      // reads it, and one with no producer passes without a rework decision. Present because the
      // shape requires a number, and it is the catalog's own so the two seeds cannot drift.
      maxAttempts: DEFAULT_RISK_POLICY.companionMaxReworks,
      attempts: 0,
      verdicts: [],
    }
    const feedback = assessment?.summary ?? ''

    // There IS a producer to grade but the companion's own verdict never parsed (even
    // after the repair retry): do NOT silently treat that as a perfect pass. That is the
    // bug where a truncated reviewer reply surfaced as "100% ≥ 80%" and dropped a real
    // review. Surface it for a human instead, recording the raw reply as the detail.
    //
    // Answered BEFORE the budget read below, because this path spends no round: resolving the
    // task's policy to fill in a number the failure record never reads is work for nothing.
    if (producerIndex >= 0 && !assessment) {
      step.output = result.output || ''
      step.companion = companion
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      // Hand the precise classification + the raw reply (the whole point of the failure,
      // for triage) to the driver's single `failRun` funnel. Do NOT fail the run here as
      // well: a second `failRun` from the driver would clobber this rich record with a
      // generic `job_failed` ("the implementation container reported a failure", no
      // detail), which is exactly the misleading surface this path is meant to avoid.
      return {
        kind: 'job_failed',
        failureKind: 'companion_rejected',
        error:
          `Companion "${step.agentKind}" did not return a parseable assessment (its reply ` +
          `was truncated or malformed) after a repair retry.`,
        detail: (result.output ?? '').slice(0, 2000) || undefined,
      }
    }

    // `companion.maxAttempts` is READ here, never written: the rework budget is resolved from the
    // task's risk policy once, at run start (`RunLifecycleController`), and is final from then on.
    // It used to be adopted here instead, on the first grading — which is one dispatch too late,
    // because the prompt for that very grading already states how much rope is left, and stated
    // the catalog default. One resolution point is also what keeps the number a prompt shows and
    // the number the cap enforces the same number.

    // The score to judge: the parsed rating when there is a producer to grade, else a perfect
    // score (no producer of this companion's target kind precedes it, so there is genuinely
    // nothing to grade).
    const rating = assessment && producerIndex >= 0 ? assessment.rating : 1
    // What this round means for the run, decided in ONE place (kernel's `disposeCompanionVerdict`,
    // the judge's sibling): a `blocker` finding holds the step whatever the rating, the first
    // batch of findings is worth a round, and only then does the rating meet the bar or not.
    //
    // The input is NAMED because a stalled loop below asks the same rule the same question with
    // one field changed, and re-listing it there would be two copies of what this round was.
    const dispositionInput: CompanionDispositionInput = {
      rating,
      threshold: companion.threshold,
      comments: assessment?.comments,
      attempts: companion.attempts,
      maxAttempts: companion.maxAttempts,
      hasProducer: producerIndex >= 0,
    }
    const decision = disposeCompanionVerdict(dispositionInput)

    // Fold this cycle's verdict (+ the reviewer/spec-companion side-signals) into the step —
    // see {@link recordCompanionVerdict}.
    this.recordCompanionVerdict({
      step,
      companion,
      assessment,
      rating,
      passed: decision.disposition === 'pass',
      result,
      feedback,
    })

    // PASS: the producer cleared the bar with nothing blocking (and was not force-looped on its
    // first batch).
    if (decision.disposition === 'pass') {
      return this.resolvePassedCompanion({
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        producerIndex,
        assessment,
      })
    }

    // NOT PASSED: the exit this round takes, which is the cap's own once the loop has stopped
    // getting anywhere (see {@link parkForUnproductiveLoop}, which also records that on the step).
    //
    // A stalled loop can only ever PARK, never advance: the rounds it is giving up are rounds the
    // budget still holds, so nothing here re-decides whether the work was good enough.
    const stalledPark = this.parkForUnproductiveLoop({
      workspaceId,
      instance,
      block,
      step,
      companion,
      producerIndex,
      decision,
      dispositionInput,
    })
    const exit: CompanionDispositionResult = stalledPark
      ? { disposition: 'park', parkReason: stalledPark }
      : decision

    // NOT PASSED with the automatic budget spent (or abandoned as above) → DON'T get stuck. Park on
    // a human decision (one more round / proceed anyway / stop & reset) — the same iteration-cap
    // surface the requirements reviewer uses at its cap. Only AUTOMATIC reworks count against the
    // budget (`attempts`); human "request changes" cycles on a gated companion re-run the producer
    // without consuming it. `step.output` already holds the companion's latest feedback; the
    // `exceeded` flag + the parked approval gate let the SPA render the three choices (via
    // `resolveCompanionExceeded`).
    if (exit.disposition === 'park') {
      step.companion = companion
      // …unless the run's policy says nobody is coming AND the automation is merely reporting that
      // it gave up. `proceed` is one of the three choices the gate offers a person, and it is the
      // only one an unattended policy may take on their behalf: `extra-round` spends model calls on
      // a loop that has already failed to converge, and `stop-reset` throws away the run.
      // Deliberately routed through the PASS branch, which is what "accept the producer's current
      // output" means everywhere else — so a companion step the pipeline ALSO gated still raises
      // its human approval gate here, exactly as it does when the companion clears the bar.
      //
      // Narrowed to `budget_spent`, which is the whole safety property of the other reason: a
      // reviewer that named a `blocker` said this work must not go further, and overruling that is
      // a JUDGEMENT rather than a decision to stop retrying. No policy takes it (kernel's
      // `CompanionParkReason`), so a blocked step waits for a person under either posture — whether
      // the budget ran out under that blocker or the loop abandoned the rest of it.
      if (
        exit.parkReason === 'budget_spent' &&
        (await this.settlesCapUnattended({ workspaceId, instance, block, step, companion }))
      ) {
        return this.resolvePassedCompanion({
          workspaceId,
          instance,
          step,
          block,
          isFinalStep,
          producerIndex,
          assessment,
        })
      }
      companion.exceeded = true
      await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
      return this.deps.stateMachine.parkStepOnDecision(
        workspaceId,
        instance,
        step,
        step.output ?? '',
      )
    }

    // REWORK: loop the producer back with the feedback folded in (the automatic analogue of a
    // human "request changes"). Reached on an open blocker, a forced first-batch loop, or a rating
    // below the bar, always with a round left to spend. `producerIndex` is guaranteed >= 0 here:
    // every one of those requires a parsed verdict against a real producer (with none, the
    // disposition is `pass`).
    const producer = instance.steps[producerIndex]!
    this.deps.stepGraph.loopCompanionProducer(instance, instance.currentStep, {
      previousProposal: producer.output ?? '',
      feedback: assessment?.summary ?? '',
      requestedBy: 'reviewer',
      ...(assessment?.comments?.length ? { comments: assessment.comments } : {}),
    })
    await this.deps.stateMachine.persistAndEmit(workspaceId, instance, {
      blockStatus: 'in_progress',
    })
    return { kind: 'continue' }
  }

  /**
   * The cap park a NOT-PASSED round takes INSTEAD of its `rework` when the loop has stopped getting
   * anywhere, recording that on the step; `undefined` when the loop is still productive and the
   * caller's own disposition stands.
   *
   * NOT GETTING ANYWHERE means the producer handed back the very text it was asked to revise and
   * the rating did not move, so every round still on the budget would buy another copy of a verdict
   * already given (`companionLoopStalled` holds the rule and the run that motivated it). Stopping
   * EARLY takes the same exit as spending the budget, deliberately: the question a person is asked
   * at the cap (one more round / proceed / stop & reset) is exactly the question here, an unattended
   * policy already has an answer for it, and inventing a second exit would mean a second set of
   * resolutions for the SPA and the risk policy to know about.
   *
   * It answers a park REASON rather than a disposition, and that is the point of its shape: a
   * `blocker` still open when the loop gave up parks as `blocking_findings`, the one reason no
   * policy may answer, instead of as the spent budget it merely resembles — while a loop that
   * stalled can never come back as "advance". Asking the disposition rule to re-decide against an
   * emptied budget did exactly that: with the first-batch branch suppressed for want of budget, a
   * rating at or above the bar answered `pass`, and the caller (which only ever branches on `park`)
   * read it as the rework it had just declared unproductive. The reason comes from kernel's
   * `companionParkReasonFor`, the same total rule `disposeCompanionVerdict` parks through, so the
   * two cannot drift.
   *
   * `companion.stalled` is recorded beside `exceeded` rather than in place of it: the two reach the
   * same gate for opposite reasons, and only this one says the run had rounds left and abandoned
   * them.
   */
  private parkForUnproductiveLoop(args: {
    workspaceId: string
    instance: ExecutionInstance
    block: Block
    step: PipelineStep
    companion: NonNullable<PipelineStep['companion']>
    producerIndex: number
    decision: CompanionDispositionResult
    dispositionInput: CompanionDispositionInput
  }): CompanionParkReason | undefined {
    const { workspaceId, instance, block, step, companion, producerIndex, decision } = args
    const producer = producerIndex >= 0 ? instance.steps[producerIndex] : undefined
    // Only a `rework` is converted: a `pass` was not a loop failing to converge, and a `park` has
    // already named its own reason.
    if (decision.disposition !== 'rework' || !producer) return undefined
    const stalled = companionLoopStalled({
      producer,
      verdicts: companion.verdicts,
      // Answered from the REGISTRY, so a deployment's own producer kind is judged by its own
      // declaration: only a kind whose deliverable is its reply can be found standing still by
      // comparing that reply. See `deliverableIsReply`.
      producerDeliverableIsReply: deliverableIsReply(
        producer.agentKind,
        this.deps.agentKindRegistry,
      ),
    })
    if (!stalled) return undefined
    companion.stalled = true
    this.deps.logger?.warn('companion rework loop stopped early: no progress', {
      workspaceId,
      runId: instance.id,
      blockId: block.id,
      agentKind: step.agentKind,
      attempts: companion.attempts,
      maxAttempts: companion.maxAttempts,
      rating: companion.verdicts[companion.verdicts.length - 1]?.rating,
    })
    return companionParkReasonFor(args.dispositionInput.comments)
  }

  /**
   * Fold one companion grading cycle into the step: append the standardized verdict, record the
   * spec-companion corroboration + the reviewer's per-fragment adherence, and set `step.output`.
   * Pure step bookkeeping split out of {@link applyAssessment} to keep it under the complexity
   * ceiling; the pass/fail decision it records was made by `disposeCompanionVerdict`.
   */
  private recordCompanionVerdict(args: {
    step: PipelineStep
    companion: NonNullable<PipelineStep['companion']>
    assessment: CompanionAssessment | undefined
    rating: number
    passed: boolean
    result: AgentRunResult
    feedback: string
  }): void {
    const { step, companion, assessment, rating, passed, result, feedback } = args
    // Append this cycle's standardized verdict (the same shape the requirements-rework
    // gate stores) so the whole correction sequence is visible, not just the latest.
    //
    // The anchored COMMENTS ride along, and that is what makes the list usable as MEMORY rather
    // than only as a display record: the next round shows this back to the companion, and "was
    // what I asked for done" is unanswerable against a summary that named none of the asks (see
    // `companion-review-context.ts`). Empty is left absent rather than stored as `[]`.
    companion.verdicts.push({
      rating,
      threshold: companion.threshold,
      passed,
      feedback,
      ...(assessment?.comments?.length ? { comments: assessment.comments } : {}),
    })
    step.companion = companion
    step.output = feedback || result.output || ''
    // Record the spec-companion's business-vs-technical corroboration on the step (even
    // below threshold) so the engine can infer the block's `technical` label both on the
    // PASS branch below AND on a later human "proceed" past the cap, where only the
    // persisted step survives. `undefined` ⇒ the companion gave no opinion.
    if (step.agentKind === 'spec-companion' && assessment) {
      step.technicalCorroborated = assessment.technicalCorroborated
    }
    // Record the code reviewer's per-best-practice-standard adherence report on the step
    // (surfaced in run details), on both the pass and rework branches, whenever it produced one.
    if (step.agentKind === 'reviewer') {
      step.fragmentAdherence = assessment?.fragmentAdherence?.length
        ? assessment.fragmentAdherence
        : undefined
    }
  }

  /**
   * Whether the run's policy answers this companion's rework cap for itself.
   *
   * Reads the policy at the moment the cap is REACHED rather than at run start, matching every
   * other policy read in the engine: an operator who moves a task onto an attended policy while it
   * is working gets the park, and one who moves it the other way stops waiting on it. It is the
   * ONLY policy read left on this path: the rework budget is resolved at run start, so a grading
   * that never reaches its cap now resolves no policy at all.
   *
   * It STAMPS `capSettledByPolicy` rather than only logging, because the alternative is a run that
   * looks like it passed a bar it never met. The last `verdicts` entry already says the producer
   * was below the bar; without the stamp, a step that advanced anyway is indistinguishable from
   * one whose companion simply stopped grading, and the step is where whoever reviews the
   * resulting pull request looks. Which is also why only a verdict that FAILED reaches here: the
   * stamp on a producer that met its bar would be the same false claim in the other direction.
   *
   * The caller has already narrowed to `parkReason === 'budget_spent'`. That narrowing is the
   * other half of the same honesty: an open `blocker` is not the automation giving up, so no
   * stamp on this step could make advancing past one a decision policy was entitled to take.
   */
  private async settlesCapUnattended(args: {
    workspaceId: string
    instance: ExecutionInstance
    block: Block
    step: PipelineStep
    companion: NonNullable<PipelineStep['companion']>
  }): Promise<boolean> {
    const { workspaceId, instance, block, step, companion } = args
    const policy = await this.deps.resolveRiskPolicy(workspaceId, block, instance)
    if (!resolvesOwnCaps(policy)) return false
    companion.capSettledByPolicy = true
    this.deps.logger?.info('companion rework cap settled by policy', {
      workspaceId,
      runId: instance.id,
      blockId: block.id,
      agentKind: step.agentKind,
      attempts: companion.attempts,
      threshold: companion.threshold,
    })
    return true
  }

  /**
   * The PASS branch of {@link applyAssessment}: the producer cleared the bar (and was not
   * force-looped on its first batch). Finish the step, infer the spec-companion's `technical`
   * label, raise the HUMAN approval gate for a gated companion, then either finalize the run (final
   * step) or advance to the next step. Split out to keep `applyAssessment` under the statement ceiling.
   */
  private async resolvePassedCompanion(args: {
    workspaceId: string
    instance: ExecutionInstance
    step: PipelineStep
    block: Block
    isFinalStep: boolean
    producerIndex: number
    assessment: CompanionAssessment | undefined
  }): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block, isFinalStep, producerIndex, assessment } = args
    this.deps.stepGraph.finishStep(step)
    step.progress = 1
    // The spec-companion just corroborated the spec-writer's business-vs-technical
    // determination: infer the block's `technical` label from the writer's
    // `noBusinessSpecs` (recorded on the producer step) + this verdict's
    // `technicalCorroborated`. Honours human authority (never overrides a set value).
    // `assessment` is guaranteed present here when there is a producer to grade (an
    // unparseable verdict against a real producer already returned above).
    if (step.agentKind === 'spec-companion' && producerIndex >= 0 && assessment) {
      await this.deps.inferTechnicalLabel?.(
        workspaceId,
        block,
        instance.steps[producerIndex]!,
        step,
      )
    }
    // A gated companion now raises the HUMAN approval gate on the producer's output
    // (the human reviews what the companion just cleared). Never on the final step.
    //
    // Through the SHARED builder, so the companion's gate carries the approver policy and quorum
    // the companion STEP configured, exactly as the ordinary settle path does. Hand-rolling the
    // literal here is what silently dropped both (see `stepApproval.ts`).
    if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
      const producer = producerIndex >= 0 ? instance.steps[producerIndex] : undefined
      step.approval = buildStepApproval(
        step,
        this.deps.idGenerator.next('appr'),
        producer?.output ?? step.output ?? '',
      )
      this.deps.stepGraph.pauseStepForInput(step)
      instance.status = 'blocked'
      await this.deps.stateMachine.persistAndEmit(workspaceId, instance, { blockStatus: 'blocked' })
      return { kind: 'awaiting_decision', decisionId: step.approval.id }
    }
    return this.deps.stateMachine.settleStepAndAdvance(workspaceId, instance, isFinalStep)
  }

  /**
   * Run a companion step and parse its JSON verdict, with ONE repair retry when the
   * first reply doesn't parse (truncated, or wrapped in prose `extractJson` can't
   * recover). The retry runs only when there is a producer to grade (`gradable`) — with
   * none there is nothing to assess, so a malformed reply is irrelevant. Returns the
   * parsed assessment (or `undefined` if even the repair failed) and the LAST call's
   * result, with usage summed across both calls so the caller's single `spend.record`
   * prices the whole thing. A still-unparseable verdict is handled by the caller (it
   * surfaces to a human rather than passing), so this never wedges the run.
   */
  private async runWithRepair(
    context: AgentRunContext,
    options: AdvanceOptions,
    gradable: boolean,
  ): Promise<{ assessment: CompanionAssessment | undefined; result: AgentRunResult }> {
    const first = await this.deps.runAgent(context, options)
    const parsed = parseCompanionOrUndefined(first.output)
    if (parsed || !gradable) return { assessment: parsed, result: first }
    // The first reply didn't parse. Re-run the same grading step once more; with the
    // companion's raised output budget this almost always clears a one-off truncation.
    const second = await this.deps.runAgent(context, options)
    const repaired = parseCompanionOrUndefined(second.output)
    return {
      assessment: repaired,
      result: { ...second, usage: sumAgentTokenUsage(first.usage, second.usage) },
    }
  }
}
