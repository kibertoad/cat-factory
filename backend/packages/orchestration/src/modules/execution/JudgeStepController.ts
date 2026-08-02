import type {
  AgentRunResult,
  Block,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  JudgeAssessor,
  JudgeContext,
  JudgeDefinition,
  JudgeRegistry,
  JudgeStepState,
  JudgeVerdict,
  PipelineStep,
  ResolveJudgeInput,
  RaiseNotificationInput,
  RiskPolicy,
  RunCredentialScope,
  RunInitiatorScope,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, disposeJudgeVerdict, renderJudgeRework } from '@cat-factory/kernel'
import { parseJudgeVerdict } from '@cat-factory/contracts'
import type { AdvanceResult } from './advance.js'
import type { FragmentBodyResolver } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

// ---------------------------------------------------------------------------
// The GENERIC judge driver — the `evaluateGate` analogue for the fourth step-taxonomy
// bucket. ONE state machine serves every registered judge; a {@link JudgeDefinition}
// supplies only its rubric, threshold, bounce budget and `onFail` disposition.
//
// The flow, all of it here so a registration never re-implements it:
//   1. no assessor wired (or the judge's own `wired()` is false) → PASS-THROUGH: record
//      `status: 'skipped'` and advance, so every existing pipeline behaves exactly as it did
//      before judges existed;
//   2. first entry → resolve the task's merge preset (threshold + bounce budget) and the
//      rubric in force (the registration default, or a workspace fragment override resolved
//      through the SAME `fragmentResolver` the prompt library uses);
//   3. run the assessment under the run initiator's ambient scope and parse it with the
//      registration's parser — an unreadable assessment is a FAILING verdict, never a silent
//      advance;
//   4. dispose via the pure kernel `disposeJudgeVerdict`: pass → advance; bounce → re-arm the
//      nearest preceding producing step with the findings as rework and re-run through the
//      judge; park → `parkStepOnDecision` + a `judge_review` card; fail → fail the run.
//
// All live state rides `step.judge`, so this is runtime-symmetric by construction with no side
// table (the `forkDecision` precedent). See `docs/initiatives/judge-registry.md`.
// ---------------------------------------------------------------------------

/** What the judge driver needs beyond the shared run state-machine spine. */
export interface JudgeStepControllerDeps {
  /** The app-owned registry the composition root injected (deployment-registered judges). */
  judgeRegistry: JudgeRegistry
  /**
   * The verdict producer. Absent / `enabled === false` ⇒ every judge step is a pass-through.
   * The engine's default is the inline `JudgeService`; conformance injects a deterministic fake.
   */
  judgeAssessor?: JudgeAssessor
  executionRepository: ExecutionRepository
  /** The async instance/block spine (park/advance/persist/emit/notify/fail). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/reset/rewind a step). */
  stepGraph: StepGraph
  workRunner: WorkRunner
  clock: Clock
  runInitiatorScope: RunInitiatorScope
  /** Raise a human-actionable card (the `judge_review` park notification). */
  raiseNotification: (workspaceId: string, input: RaiseNotificationInput) => Promise<void>
  /** The task's resolved merge preset — the source of the threshold + bounce budget. */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
  ) => Promise<Pick<RiskPolicy, 'judgeMinScore' | 'judgeMaxBounces'>>
  /**
   * The prompt-fragment library, used for ONE thing: resolving a rubric's per-workspace
   * override body. Absent (no library configured) ⇒ the registration's default rubric, which
   * is exactly the behaviour a stock deployment gets.
   */
  fragmentResolver?: FragmentBodyResolver
  /** The engine's completion spine, so a passing judge finishes + advances like any step. */
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  /** The judge context handed to each registered factory at registry-build time. */
  makeJudgeContext: () => JudgeContext
}

export class JudgeStepController {
  private registryCache?: Map<string, JudgeDefinition>

  constructor(private readonly deps: JudgeStepControllerDeps) {}

  /**
   * The registered judge for an agent kind, or undefined when the kind is not a judge. Built
   * lazily (the factories close over the engine seams) and cached per instance — so, like the
   * gate registry, a judge registered AFTER the first build is invisible to this instance:
   * register at startup, before serving.
   */
  judgeFor(agentKind: string): JudgeDefinition | undefined {
    if (!this.registryCache) {
      const map = new Map<string, JudgeDefinition>()
      const ctx = this.deps.makeJudgeContext()
      for (const { kind, factory } of this.deps.judgeRegistry.factories()) {
        map.set(kind, factory(ctx))
      }
      this.registryCache = map
    }
    return this.registryCache.get(agentKind)
  }

  /** Every registered judge, for the workspace-snapshot palette projection. */
  all(): JudgeDefinition[] {
    return this.deps.judgeRegistry.factories().map(({ kind }) => this.judgeFor(kind)!)
  }

  /**
   * The run's "active" judge state: prefer the step the run is currently on, else the latest
   * step that carries judge state (a pipeline may place more than one judge). Mirrors
   * `ForkDecisionController.getActive`; null when the run carries none.
   */
  async getActive(workspaceId: string, executionId: string): Promise<JudgeStepState | null> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) return null
    const current = instance.steps[instance.currentStep]
    if (current?.judge) return current.judge
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const judge = instance.steps[i]?.judge
      if (judge) return judge
    }
    return null
  }

  /**
   * The PASS-THROUGH branch: no assessor wired (tests / no model configured) or the judge's own
   * prerequisite is unwired. Recorded as `skipped` WITH a note — a judge that quietly did nothing
   * must not read like one that passed — then finished like any other step.
   */
  private passThrough(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    judge: JudgeDefinition,
    noAssessor: boolean,
  ): Promise<AdvanceResult> {
    const note = noAssessor
      ? `The "${judge.rubric.name}" review was skipped (no assessment model is configured).`
      : (judge.unwiredOutput ??
        `The "${judge.rubric.name}" review was skipped (its provider is not configured).`)
    step.judge = {
      ...step.judge,
      status: 'skipped',
      rubricId: judge.rubric.id,
      rubricName: judge.rubric.name,
      rubricOverridden: step.judge?.rubricOverridden ?? false,
      bounces: step.judge?.bounces ?? 0,
      maxBounces: step.judge?.maxBounces ?? 0,
      rounds: step.judge?.rounds ?? [],
      note,
    }
    return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, { output: note })
  }

  /**
   * Initialise `step.judge` on first entry. The threshold + bounce budget come from the task's
   * merge preset ONCE and stay stable across bounce rounds — a preset edited mid-run must not
   * move the bar the earlier rounds were judged against.
   */
  private async initState(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
    judge: JudgeDefinition,
  ): Promise<JudgeStepState> {
    if (step.judge) {
      step.judge = { ...step.judge, status: 'evaluating' }
      return step.judge
    }
    const preset = await this.deps.resolveRiskPolicy(workspaceId, block)
    step.judge = {
      status: 'evaluating',
      rubricId: judge.rubric.id,
      rubricName: judge.rubric.name,
      rubricOverridden: false,
      threshold: judge.threshold ? judge.threshold(preset) : preset.judgeMinScore,
      bounces: 0,
      maxBounces: judge.attemptBudget ? judge.attemptBudget(preset) : preset.judgeMaxBounces,
      rounds: [],
    }
    return step.judge
  }

  /**
   * Evaluate a judge step once: assess, dispose, and act. Shared by the fresh advance and the
   * re-entry after a bounce (the producer re-ran and the work is ready to be re-judged).
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    judge: JudgeDefinition,
  ): Promise<AdvanceResult> {
    const assessor = this.deps.judgeAssessor
    if (!assessor?.enabled || judge.wired?.() === false) {
      return this.passThrough(workspaceId, instance, step, isFinalStep, judge, !assessor?.enabled)
    }
    // The live state, kept as a local so the rest of the method reads it without re-narrowing
    // `step.judge` (which stays the persisted source of truth and is re-assigned below).
    let judgeState = await this.initState(workspaceId, step, block, judge)

    const { body: rubric, overridden } = await this.resolveRubric(workspaceId, judge)
    judgeState.rubricOverridden = overridden
    await this.deps.stateMachine.emitInstance(workspaceId, instance)

    const stepIndex = instance.steps.indexOf(step)
    const { verdict, model } = await this.assess(
      assessor,
      {
        workspaceId,
        block,
        step,
        rubric,
        rubricName: judge.rubric.name,
        priorOutputs: priorOutputsFor(instance, stepIndex),
        previousFindings: judgeState.verdict ?? null,
      },
      judge,
      { workspaceId, initiatedBy: instance.initiatedBy },
    )

    const producerIndex = this.bounceTargetIndex(instance, stepIndex, judge)
    const decision = disposeJudgeVerdict({
      verdict,
      threshold: judgeState.threshold ?? 0,
      onFail: judge.onFail,
      bounces: judgeState.bounces ?? 0,
      maxBounces: judgeState.maxBounces ?? 0,
      hasBounceTarget: producerIndex >= 0,
    })

    judgeState = {
      ...judgeState,
      verdict,
      model,
      disposition: decision.disposition,
      note: decision.note ?? null,
      rounds: [
        ...(judgeState.rounds ?? []),
        {
          round: (judgeState.rounds?.length ?? 0) + 1,
          at: this.deps.clock.now(),
          verdict,
          disposition: decision.disposition,
          model,
        },
      ],
    }
    step.judge = judgeState

    switch (decision.disposition) {
      case 'pass':
        judgeState.status = 'passed'
        return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
          output: renderPassOutput(judge, verdict, judgeState.threshold ?? 0),
        })
      case 'fail':
        judgeState.status = 'failed'
        await this.deps.stateMachine.casPersist(workspaceId, instance)
        await this.deps.stateMachine.emitInstance(workspaceId, instance)
        return {
          kind: 'job_failed',
          error:
            `The "${judge.rubric.name}" review failed this work (${verdict.score.toFixed(2)} < ${(judgeState.threshold ?? 0).toFixed(2)}). ${verdict.summary}`.trim(),
        }
      case 'bounce':
        return this.bounce(workspaceId, instance, {
          step,
          judge,
          verdict,
          producerIndex,
          stepIndex,
        })
      default:
        return this.park(workspaceId, instance, step, block, judge, verdict)
    }
  }

  /**
   * Run the assessment and parse it with the registration's parser. A THROWN assessment (an
   * unresolved model, a provider outage, an unparseable reply) becomes a score-0 verdict rather
   * than an exception: the judge's whole job is to gate, so "I could not tell" must land on the
   * cautious side of the threshold and reach a human, not abort the run with a stack trace or —
   * worse — let the work through.
   */
  private async assess(
    assessor: JudgeAssessor,
    subject: Parameters<JudgeAssessor['assess']>[0],
    judge: JudgeDefinition,
    scope: RunCredentialScope,
  ): Promise<{ verdict: JudgeVerdict; model: string | null }> {
    const parse = judge.parseVerdict ?? parseJudgeVerdict
    try {
      const raw = await this.deps.runInitiatorScope(scope, () => assessor.assess(subject))
      return { verdict: parse(raw.verdict), model: raw.model }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return {
        verdict: {
          score: 0,
          summary: `The "${judge.rubric.name}" assessment could not be completed: ${reason}`,
          findings: [
            {
              title: 'The rubric assessment did not produce a readable verdict',
              detail: reason,
              severity: 'high',
            },
          ],
        },
        model: null,
      }
    }
  }

  /**
   * Re-arm the producing step with the verdict's findings as rework feedback and re-run it
   * through this judge. Uses `rerunProducerThrough` rather than a hand-rolled cursor rewind
   * because that is what clears the stale container job handles on the intermediate steps (a
   * re-dispatch would otherwise re-attach to an evicted job).
   */
  private async bounce(
    workspaceId: string,
    instance: ExecutionInstance,
    args: {
      step: PipelineStep
      judge: JudgeDefinition
      verdict: JudgeVerdict
      producerIndex: number
      stepIndex: number
      extraFeedback?: string | null
    },
  ): Promise<AdvanceResult> {
    const { step, judge, verdict, producerIndex, stepIndex, extraFeedback } = args
    const judgeState: JudgeStepState = {
      ...step.judge!,
      status: 'bouncing',
      bounces: (step.judge?.bounces ?? 0) + 1,
    }
    this.deps.stepGraph.rerunProducerThrough(instance, producerIndex, stepIndex, {
      previousProposal: instance.steps[producerIndex]?.output ?? '',
      feedback: renderJudgeRework(verdict, judge.rubric.name, extraFeedback),
    })
    // `rerunProducerThrough` resets the judge step too; `judge` survives `resetStepForRerun`
    // by design, but re-assign explicitly so the incremented bounce count is what persists.
    step.judge = judgeState
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /** Park on a human decision and raise the `judge_review` card that makes it discoverable. */
  private async park(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    judge: JudgeDefinition,
    verdict: JudgeVerdict,
  ): Promise<AdvanceResult> {
    step.judge = { ...step.judge!, status: 'awaiting_decision' }
    const threshold = step.judge.threshold ?? 0
    await this.deps.raiseNotification(workspaceId, {
      type: 'judge_review',
      blockId: block.id,
      executionId: instance.id,
      title: `"${judge.rubric.name}" review needs a decision for "${block.title}"`,
      body:
        `The review scored this work ${verdict.score.toFixed(2)} against a threshold of ` +
        `${threshold.toFixed(2)}. ${verdict.summary} ` +
        `Proceed anyway, send it back for rework, or stop the run.`.trim(),
      payload: {
        pipelineName: instance.pipelineName,
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
      },
    })
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Resolve a parked judge — the SINGLE entry point behind both the SPA controller and the
   * public API's decisions surface, so the park's CAS/approval-id arbitration and the task's
   * preset knobs apply identically whichever surface answers first.
   *
   *  - `proceed` — advance past the judge despite the verdict (the human overrules the rubric);
   *  - `bounce`  — spend a rework round on the producing step, even past the preset budget
   *                (the human is explicitly buying it);
   *  - `stop`    — fail the run with the verdict.
   */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    input: ResolveJudgeInput,
  ): Promise<JudgeStepState> {
    const feedback = input.feedback?.trim() || undefined
    let approvalId = ''
    let stepIndex = -1
    let bounceTo = -1
    let state: JudgeStepState | undefined
    let failure: string | undefined

    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const index = inst.steps.findIndex(
          (s) =>
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending' &&
            s.judge?.status === 'awaiting_decision',
        )
        const step = index >= 0 ? inst.steps[index]! : undefined
        if (!step?.approval || !step.judge) {
          throw new ConflictError('The run is no longer awaiting a review decision')
        }
        const judge = this.judgeFor(step.agentKind)
        if (!judge) {
          throw new ConflictError(`No judge is registered for step kind '${step.agentKind}'`)
        }
        approvalId = step.approval.id
        stepIndex = index
        const resolution = {
          choice: input.choice,
          at: this.deps.clock.now(),
          ...(feedback ? { feedback } : {}),
        }

        if (input.choice === 'bounce') {
          bounceTo = this.bounceTargetIndex(inst, index, judge)
          if (bounceTo < 0) {
            throw new ConflictError('There is no preceding step to send this work back to')
          }
          // Recorded here so the re-armed run carries the human's intent; the actual rewind
          // happens on the winning snapshot below (it mutates several steps).
          step.judge = { ...step.judge, resolution, disposition: 'bounce' }
          return
        }
        if (input.choice === 'stop') {
          step.judge = { ...step.judge, status: 'failed', resolution, disposition: 'fail' }
          failure =
            `The "${judge.rubric.name}" review was stopped by a human. ${step.judge.verdict?.summary ?? ''}`.trim()
          state = step.judge
          return
        }
        // `proceed`: the human overrules the rubric — stamp the judge passed and advance the
        // run past it in the SAME mutation, exactly like an approved gate.
        step.judge = {
          ...step.judge,
          status: 'passed',
          resolution,
          disposition: 'pass',
          note: 'A human chose to proceed despite the verdict.',
        }
        step.output = `The "${judge.rubric.name}" review was overruled by a human; the run proceeded.`
        state = step.judge
        this.deps.stateMachine.advanceRunPastGate(inst, index)
      },
    )

    if (input.choice === 'proceed') {
      await this.deps.stateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
      return state!
    }
    if (input.choice === 'stop') {
      await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
      await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'rejected')
      await this.deps.stateMachine.failRun(workspaceId, instance.id, failure!, 'agent')
      return state!
    }

    // `bounce`: re-arm the producer with the verdict + the human's extra guidance, then wake
    // the driver. A human-bought round is NOT charged against the preset budget — they already
    // decided; charging it would let the next automatic round be silently refused.
    const step = instance.steps[stepIndex]!
    const judge = this.judgeFor(step.agentKind)!
    const verdict = step.judge?.verdict ?? { score: 0, summary: '', findings: [] }
    this.deps.stepGraph.rerunProducerThrough(instance, bounceTo, stepIndex, {
      previousProposal: instance.steps[bounceTo]?.output ?? '',
      feedback: renderJudgeRework(verdict, judge.rubric.name, feedback),
    })
    step.judge = { ...step.judge!, status: 'bouncing' }
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    return step.judge
  }

  /**
   * The index of the step a bounce re-arms: the nearest preceding step whose kind the judge
   * declares it grades, else the immediately preceding step. `-1` when the judge is the first
   * step — which degrades a `bounce` to a `park` rather than advancing silently.
   */
  private bounceTargetIndex(
    instance: ExecutionInstance,
    stepIndex: number,
    judge: JudgeDefinition,
  ): number {
    const targets = judge.bounceTargets
    if (targets?.length) {
      return this.deps.stepGraph.nearestStepIndexBefore(instance.steps, stepIndex, (s) =>
        targets.includes(s.agentKind),
      )
    }
    return stepIndex - 1
  }

  /**
   * The rubric body in force: a workspace's prompt-library fragment override when one resolves
   * for {@link JudgeRubric.fragmentId}, else the registration's default. Best-effort — a
   * library outage must not turn a rubric gate into a hard failure, so it degrades to the
   * default (which is a real rubric, not an empty one).
   */
  private async resolveRubric(
    workspaceId: string,
    judge: JudgeDefinition,
  ): Promise<{ body: string; overridden: boolean }> {
    const fragmentId = judge.rubric.fragmentId
    if (!fragmentId || !this.deps.fragmentResolver)
      return { body: judge.rubric.body, overridden: false }
    try {
      const resolved = await this.deps.fragmentResolver.resolveBodiesForRun(workspaceId, [
        fragmentId,
      ])
      const body = resolved.find((f) => f.id === fragmentId)?.body?.trim()
      if (body) return { body, overridden: true }
    } catch {
      // Fall through to the default rubric.
    }
    return { body: judge.rubric.body, overridden: false }
  }
}

/** The step outputs the judge reviews: every preceding step that produced one, oldest first. */
function priorOutputsFor(
  instance: ExecutionInstance,
  stepIndex: number,
): { agentKind: string; output: string }[] {
  return instance.steps
    .slice(0, Math.max(stepIndex, 0))
    .filter((s) => !!s.output?.trim())
    .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
}

/** The step output a PASSING judge records (what it scored, and what it still noted). */
function renderPassOutput(
  judge: JudgeDefinition,
  verdict: JudgeVerdict,
  threshold: number,
): string {
  const nits = verdict.findings?.length ?? 0
  const suffix = nits > 0 ? ` ${nits} non-blocking finding(s) recorded.` : ''
  return `The "${judge.rubric.name}" review passed (${verdict.score.toFixed(2)} ≥ ${threshold.toFixed(2)}).${suffix}`
}
