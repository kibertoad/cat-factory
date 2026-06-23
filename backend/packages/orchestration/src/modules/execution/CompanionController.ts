import type {
  AgentRunContext,
  AgentRunResult,
  AgentTokenUsage,
  Block,
  ExecutionInstance,
  IdGenerator,
  PipelineStep,
} from '@cat-factory/kernel'
import {
  type CompanionAssessment,
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  parseCompanionAssessment,
} from '@cat-factory/contracts'
import { companionFor, companionTargets } from '@cat-factory/agents'
import type { SpendService } from '@cat-factory/spend'
import { extractJson } from '../requirements/requirements.logic.js'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'

/** Parse a companion's JSON verdict from a model reply, or `undefined` if it won't parse. */
function parseCompanionOrUndefined(output: string | undefined): CompanionAssessment | undefined {
  try {
    return parseCompanionAssessment(extractJson(output ?? ''))
  } catch {
    return undefined
  }
}

/** Sum the token usage of two model calls (for the companion's repair retry). */
function sumUsage(
  a: AgentTokenUsage | undefined,
  b: AgentTokenUsage | undefined,
): AgentTokenUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/**
 * The engine flow-control operations the companion loop drives. These stay on
 * `ExecutionService` (they are the shared state-machine primitives, reused by the human
 * "request changes" path and the iteration-cap resolution) and are injected here so the
 * companion evaluation can live in its own unit without duplicating them.
 */
export interface CompanionControllerDeps {
  contextBuilder: AgentContextBuilder
  spend: SpendService
  idGenerator: IdGenerator
  previewStepModel: (context: AgentRunContext) => Promise<string | undefined>
  runAgent: (context: AgentRunContext, options: AdvanceOptions) => Promise<AgentRunResult>
  finishStep: (step: PipelineStep) => void
  startStep: (step: PipelineStep) => void
  updateBlockProgress: (
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ) => Promise<void>
  persistInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  emitInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  stopRunContainer: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  finalizeBlock: (
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ) => Promise<void>
  parkStepOnDecision: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal?: string,
  ) => Promise<AdvanceResult>
  loopCompanionProducer: (
    instance: ExecutionInstance,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ) => void
}

/**
 * Drives a companion (reviewer / spec-companion / architect-companion) step: it runs the
 * companion as a normal inline LLM step, parses its rating JSON (with one repair retry), and
 * acts on the verdict —
 *   - at/above threshold → finish; a gated companion raises the human approval gate on the
 *     producer's output, else the run advances.
 *   - below, budget left → loop the producer back with the feedback folded in (the automatic
 *     analogue of "request changes").
 *   - below, budget spent → park on the iteration-cap gate for a human (one more round /
 *     proceed / stop & reset), NOT a failure.
 * An unparseable verdict (even after the repair retry) fails the run (`companion_rejected`)
 * rather than silently passing. Extracted out of `ExecutionService`; the shared step-graph
 * primitives it calls (`loopCompanionProducer`, the parking gate, the block/instance writes)
 * stay on the engine and are injected via {@link CompanionControllerDeps}.
 */
export class CompanionController {
  constructor(private readonly deps: CompanionControllerDeps) {}

  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    options: AdvanceOptions,
  ): Promise<AdvanceResult> {
    const targets = companionTargets(step.agentKind)
    // The nearest earlier step whose kind this companion reviews (the producer).
    let producerIndex = -1
    for (let i = instance.currentStep - 1; i >= 0; i--) {
      if (targets.includes(instance.steps[i]!.agentKind)) {
        producerIndex = i
        break
      }
    }

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
    // Run the companion, parsing its JSON verdict with ONE repair retry when the first
    // reply doesn't parse (truncated / wrapped in prose). Only retried when there is a
    // producer to grade. `result` carries the LAST call's output + the summed usage.
    const { assessment, result } = await this.runWithRepair(context, options, producerIndex >= 0)
    if (result.usage) {
      await this.deps.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
      })
    }
    if (result.model) step.model = result.model

    const companion = step.companion ?? {
      threshold: companionFor(step.agentKind)?.defaultThreshold ?? 0.8,
      maxAttempts: DEFAULT_COMPANION_MAX_ATTEMPTS,
      attempts: 0,
      verdicts: [],
    }
    const feedback = assessment?.summary ?? ''

    // There IS a producer to grade but the companion's own verdict never parsed (even
    // after the repair retry): do NOT silently treat that as a perfect pass. That is the
    // bug where a truncated reviewer reply surfaced as "100% ≥ 80%" and dropped a real
    // review. Surface it for a human instead, recording the raw reply as the detail.
    if (producerIndex >= 0 && !assessment) {
      step.output = result.output || ''
      step.companion = companion
      await this.deps.persistInstance(workspaceId, instance)
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

    // The score to judge: the parsed rating when there is a producer to grade, else a
    // perfect score (no producer of this companion's target kind precedes it, so there
    // is genuinely nothing to grade and the run advances).
    const rating = assessment && producerIndex >= 0 ? assessment.rating : 1
    // The FIRST review batch ALWAYS loops the producer back when it raised any comments,
    // regardless of rating; the configured threshold only governs the SECOND pass onward.
    // `attempts` counts automatic reworks, so it is 0 on the first batch. Applies to every
    // companion (reviewer / spec-companion / architect-companion). Gated on a real producer
    // so the loop-back below always has a step to re-run.
    const firstBatch = companion.attempts === 0
    const hasComments = producerIndex >= 0 && (assessment?.comments?.length ?? 0) > 0
    const passed = firstBatch && hasComments ? false : rating >= companion.threshold
    // Append this cycle's standardized verdict (the same shape the requirements-rework
    // gate stores) so the whole correction sequence is visible, not just the latest.
    companion.verdicts.push({
      rating,
      threshold: companion.threshold,
      passed,
      feedback,
    })
    step.companion = companion
    step.output = feedback || result.output || ''

    // PASS: the producer cleared the bar (and was not force-looped on its first batch).
    if (passed) {
      this.deps.finishStep(step)
      step.progress = 1
      // A gated companion now raises the HUMAN approval gate on the producer's output
      // (the human reviews what the companion just cleared). Never on the final step.
      if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
        const producer = producerIndex >= 0 ? instance.steps[producerIndex] : undefined
        step.approval = {
          id: this.deps.idGenerator.next('appr'),
          status: 'pending',
          proposal: producer?.output ?? step.output,
        }
        step.state = 'waiting_decision'
        instance.status = 'blocked'
        await this.deps.updateBlockProgress(workspaceId, instance, 'blocked')
        await this.deps.persistInstance(workspaceId, instance)
        await this.deps.emitInstance(workspaceId, instance)
        return { kind: 'awaiting_decision', decisionId: step.approval.id }
      }
      if (isFinalStep) {
        instance.status = 'done'
        await this.deps.finalizeBlock(workspaceId, instance, undefined)
        await this.deps.persistInstance(workspaceId, instance)
        await this.deps.emitInstance(workspaceId, instance)
        await this.deps.stopRunContainer(workspaceId, instance)
        return { kind: 'done' }
      }
      instance.currentStep += 1
      const next = instance.steps[instance.currentStep]
      if (next) this.deps.startStep(next)
      await this.deps.updateBlockProgress(workspaceId, instance, 'in_progress')
      await this.deps.persistInstance(workspaceId, instance)
      await this.deps.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }

    // BELOW THRESHOLD, automatic budget spent → DON'T get stuck. Park on a human
    // decision (one more round / proceed anyway / stop & reset) — the same iteration-cap
    // surface the requirements reviewer uses at its cap. Only AUTOMATIC reworks count
    // against the budget (`attempts`); human "request changes" cycles on a gated
    // companion re-run the producer without consuming it. `step.output` already holds the
    // companion's latest feedback; the `exceeded` flag + the parked approval gate let the
    // SPA render the three choices (resolved via `resolveCompanionExceeded`).
    if (companion.attempts >= companion.maxAttempts) {
      companion.exceeded = true
      step.companion = companion
      return this.deps.parkStepOnDecision(workspaceId, instance, step, step.output ?? '')
    }

    // NOT PASSED, budget left → loop the producer back with the feedback folded in (the
    // automatic analogue of a human "request changes"). Reached either below threshold or
    // on the forced first-batch loop. `producerIndex` is guaranteed >= 0 here: a forced
    // loop requires comments on a real producer, and a below-threshold rating requires a
    // parsed verdict against a producer (otherwise rating defaulted to 1 and we passed).
    const producer = instance.steps[producerIndex]!
    this.deps.loopCompanionProducer(instance, instance.currentStep, {
      previousProposal: producer.output ?? '',
      feedback: assessment?.summary ?? '',
      ...(assessment?.comments?.length ? { comments: assessment.comments } : {}),
    })
    await this.deps.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
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
      result: { ...second, usage: sumUsage(first.usage, second.usage) },
    }
  }
}
