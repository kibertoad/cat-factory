import type {
  Block,
  BlockRepository,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  InputGateMode,
  Logger,
  PipelineStep,
  ResolveInputGateChoice,
  RunInputGate,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  describeError,
  describeInputGateIssues,
  evaluateInputGate,
  hasBlockingInputIssues,
  inputGateInputOf,
  noopLogger,
} from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'

/** What the gate needs beyond the shared run state-machine spine. */
export interface InputGateControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  /** The async instance/block spine (park / persist / emit / notify). */
  stateMachine: RunStateMachine
  /** The pure step mutators, used to resume the parked step in place. */
  stepGraph: StepGraph
  clock: Clock
  /**
   * Resolves the workspace's {@link InputGateMode}. ABSENT ⇒ the gate cannot know what this
   * workspace asked for, so it does not run and records `off`: the honest reading, and the
   * same pass-through every other optional engine seam takes. It is NOT defaulted to
   * `standard` here: a facade that forgot to wire settings would then start parking runs on a
   * policy nobody chose.
   */
  workspaceSettingsService?: WorkspaceSettingsService
  logger?: Logger
}

/**
 * The PRE-TOKEN INPUT GATE: the run's last chance to refuse work for free.
 *
 * Before a run's FIRST agent step is dispatched, this reduces the task's authored input
 * (kernel's pure {@link evaluateInputGate}) and parks the run when there is structurally
 * nothing to act on, an empty or placeholder-only description, a `bug` with no reproduction
 * context, a `review` task naming no pull request. The platform's cheapest refusal used to
 * cost a requirements-review call, which is a model spending tokens to report an absence a
 * string comparison already knew about.
 *
 * Three properties are load-bearing:
 *
 *  - **It runs at most once per run, at step 0.** The verdict on `instance.inputGate` is what
 *    makes it idempotent under a durable replay: a re-driven run reads its own settled verdict
 *    rather than re-judging a block a human has since edited. And confining it to step 0 is
 *    what keeps its promise honest, past the first dispatch the tokens are already spent, so
 *    parking there would cost a human interruption and save nothing.
 *  - **It records a verdict in EVERY disposition, including the ones where it did nothing.**
 *    `off` (mode off, or no settings seam) and `passed` are different facts, and an absent
 *    record means only "not evaluated yet". A gate that quietly wrote nothing when it was
 *    switched off would read downstream exactly like a clean bill of health.
 *  - **It parks; it never fails the run.** The input is a thing a human can go and fix, so the
 *    run waits for them to fix it (`recheck`, which re-evaluates rather than taking their word
 *    for it) or to overrule the gate (`proceed`). A refusal would throw away a run the human
 *    may be one edit away from wanting.
 */
export class InputGateController {
  private readonly log: Logger

  constructor(private readonly deps: InputGateControllerDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Evaluate the gate for a run about to dispatch its first step.
   *
   * Returns `null` when the run may proceed, every disposition except a fresh block: already
   * evaluated, past step 0, mode `off`, or evaluated clean. Returns an `awaiting_decision`
   * when blocking findings parked the run.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult | null> {
    // Already judged (including a human's `overridden`), or resumed past the point where a
    // park could still save anything. Both are ordinary pass-throughs, and neither re-writes
    // the record: the verdict names the input as it stood when it mattered.
    if (instance.inputGate || instance.currentStep !== 0) return null

    const mode = await this.resolveMode(workspaceId)
    const verdict = evaluateInputGate(inputGateInputOf(block), mode)
    const record: RunInputGate = {
      status: verdict.status,
      mode: verdict.mode,
      issues: verdict.issues,
      checkedAt: this.deps.clock.now(),
    }
    instance.inputGate = record

    if (record.status !== 'blocked') {
      // Persist the verdict before the step dispatches, so an `off`/`passed`/advisory record
      // is durable even if the dispatch that follows it fails. The emit rides the dispatch's
      // own writes rather than costing a second push.
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      if (record.issues.length > 0) {
        this.log.info('input gate: advisory findings, run continues', {
          workspaceId,
          runId: instance.id,
          blockId: block.id,
          mode: record.mode,
          issues: describeInputGateIssues(record.issues),
        })
      }
      return null
    }

    this.log.info('input gate: run parked before its first dispatch', {
      workspaceId,
      runId: instance.id,
      blockId: block.id,
      issues: describeInputGateIssues(record.issues),
    })
    // `parkStepOnDecision` persists the instance (verdict included) and emits it. The proposal
    // is a bare detail line: every surface renders the localized copy off `issues`, so the
    // prose here is never what a human is expected to read.
    const parked = await this.deps.stateMachine.parkStepOnDecision(
      workspaceId,
      instance,
      step,
      `The task's input is incomplete: ${describeInputGateIssues(record.issues)}.`,
    )
    // A park nobody is told about is a run that waits forever. The board already shows
    // `blocked`; this is what puts it in the inbox beside every other decision.
    await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
    return parked
  }

  /**
   * Resolve a run parked on the gate.
   *
   *  - `recheck` re-evaluates the task AS IT STANDS NOW. The park clears only if the blocking
   *    gaps are genuinely gone, the fix is verified rather than asserted, which is the whole
   *    difference between this and `proceed`. Still-blocked leaves the run parked on the SAME
   *    decision (the findings are refreshed, so a partial fix shows as progress) and the caller
   *    gets the updated verdict rather than an error: nothing went wrong, the task is just not
   *    fixed yet.
   *  - `proceed` waives the findings. They stay on the record, what was waived is part of the
   *    run's history, under an `overridden` status that no reader can mistake for `passed`.
   *
   * The mutation is CAS'd and the non-idempotent side effects (driver signal, emit) run once
   * after, on the winning snapshot: the same split every other human-action path here uses.
   */
  async resolve(
    workspaceId: string,
    executionId: string,
    choice: ResolveInputGateChoice,
    userId: string | null | undefined,
  ): Promise<RunInputGate> {
    const current = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (current.inputGate?.status !== 'blocked') {
      throw new ConflictError(
        'This run is not waiting on its input check.',
        'input_gate_not_parked',
      )
    }
    // Re-read the block OUTSIDE the CAS loop: `recheck`'s whole job is to judge the task as it
    // stands now, and re-reading it per attempt would let two retries judge two different
    // blocks and disagree about the same decision.
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, current.blockId),
      'Block',
      current.blockId,
    )
    const rechecked =
      choice === 'recheck'
        ? evaluateInputGate(inputGateInputOf(block), current.inputGate.mode)
        : null
    const stillBlocked = rechecked ? hasBlockingInputIssues(rechecked.issues) : false

    let approvalId = ''
    let settled: RunInputGate | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const gate = inst.inputGate
        const step = inst.steps[0]
        if (gate?.status !== 'blocked' || !step?.approval || step.approval.status !== 'pending') {
          throw new ConflictError(
            'This run is no longer waiting on its input check.',
            'input_gate_not_parked',
          )
        }
        approvalId = step.approval.id
        if (stillBlocked) {
          // Refresh the findings and stay parked. The decision id is deliberately UNCHANGED:
          // the durable driver is still waiting on it, and minting a fresh one would strand it.
          settled = { ...gate, issues: rechecked!.issues, checkedAt: this.deps.clock.now() }
          inst.inputGate = settled
          return
        }
        settled = rechecked
          ? {
              ...gate,
              status: 'passed',
              issues: rechecked.issues,
              checkedAt: this.deps.clock.now(),
            }
          : {
              ...gate,
              status: 'overridden',
              overriddenBy: userId ?? null,
              overriddenAt: this.deps.clock.now(),
            }
        inst.inputGate = settled
        // Resume the SAME step rather than advancing past it: the gate guards the step's
        // dispatch, it is not a step of its own. `startStep` clears the park without
        // re-stamping `startedAt`, so the human's deliberation isn't billed as a fresh attempt.
        step.approval = null
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    if (!stillBlocked) {
      // Wake the driver parked on the approval id so it re-enters step 0 and dispatches.
      await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    }
    return settled!
  }

  /**
   * The workspace's configured mode, or `off` when the settings seam is unwired (see
   * {@link InputGateControllerDeps.workspaceSettingsService}). A settings read that FAILS is
   * also `off`: an unreadable policy is not a mandate to park somebody's run, and the recorded
   * `off` verdict says the check did not happen rather than claiming the input was fine.
   */
  private async resolveMode(workspaceId: string): Promise<InputGateMode> {
    const service = this.deps.workspaceSettingsService
    if (!service) return 'off'
    try {
      return (await service.get(workspaceId)).inputGateMode
    } catch (error) {
      this.log.warn('input gate: workspace settings unreadable, skipping the check', {
        workspaceId,
        ...describeError(error),
      })
      return 'off'
    }
  }
}
