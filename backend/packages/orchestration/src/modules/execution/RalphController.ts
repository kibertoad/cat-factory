import type {
  AgentExecutor,
  AgentRunResult,
  Block,
  BlockRepository,
  ExecutionInstance,
  PipelineStep,
  RalphAttempt,
  RalphVerdict,
} from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import { parseRalphVerdict } from '@cat-factory/contracts'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { decideRalphNext, describeRalphVerdict, RALPH_AGENT_KIND } from './ralph.logic.js'

/** The engine collaborators the ralph loop drives (kept on the engine, injected here). */
export interface RalphControllerDeps {
  blockRepository: BlockRepository
  notificationService?: NotificationService
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  /** The async instance/block spine (container reclaim, instance persist + emit). */
  stateMachine: RunStateMachine
  /** Current time (ms) for stamping attempts. Absent → `Date.now()`. */
  clockNow?: () => number
}

/**
 * Drives the Ralph loop's retry-until-done cycle: apply a finished iteration's HARNESS-COMPUTED
 * validation verdict to its `ralph` step and either finish (the completion command passed),
 * re-dispatch a fresh-context iteration (the command failed and the budget remains), or give up
 * for a human (the budget is spent). This is the ralph analogue of {@link TesterController}: the
 * SAME `ralph` kind re-dispatches each iteration (there is no separate helper kind — the loop
 * body both codes and is validated), and the loop's exit condition is the exit code of the
 * task's configured command, not a model self-report.
 *
 * Restart-survival is inherent: every mutation lands on the persisted `step.ralph` through
 * {@link RunStateMachine.casPersist}, so a mid-loop run re-driven by either durable driver /
 * sweeper resumes from exactly the recorded iteration count. A concurrent human action
 * (stop/cancel) landing in the CAS window loses the swap, throws `RunContendedError`, and is
 * re-driven on fresh state by the driver's contention envelope — never clobbered.
 */
export class RalphController {
  constructor(private readonly deps: RalphControllerDeps) {}

  /**
   * Apply a finished ralph iteration's verdict to its step. Records the iteration on the step,
   * then decides: passed ⇒ returns `null` so `recordStepResult` finishes + advances; failed with
   * budget left ⇒ re-dispatches a fresh iteration (parked on the new job); budget spent (or no
   * async executor / no verdict) ⇒ fails the run for a human.
   */
  async resolveRalphResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
  ): Promise<AdvanceResult | null> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    let verdict: RalphVerdict | null = null
    try {
      verdict = result.ralphVerdict !== undefined ? parseRalphVerdict(result.ralphVerdict) : null
    } catch {
      verdict = null
    }
    // Defensive: the step should have been seeded at run start, but re-seed a minimal state if
    // it is somehow absent so the loop can still terminate rather than throwing.
    if (!step.ralph) {
      step.ralph = {
        phase: 'iterating',
        attempts: 0,
        maxIterations: 1,
        validationCommand: '',
        attemptLog: [],
      }
    }

    // Count this finished iteration and record it in the inspectable history.
    step.ralph.attempts += 1
    step.ralph.phase = 'iterating'
    step.subtasks = undefined
    if (verdict) {
      step.ralph.lastExitCode = verdict.exitCode
      step.ralph.lastValidationTail = verdict.validationOutputTail ?? null
    }
    this.recordAttempt(step, verdict, result.output ?? null)

    const decision = decideRalphNext(step.ralph, verdict)
    if (decision === 'done') {
      // The completion command passed — record a summary and let the normal completion finish
      // + advance the run (the PR from this loop then flows through the pipeline's ship tail).
      step.output = `Ralph loop complete after ${step.ralph.attempts} iteration(s): ${describeRalphVerdict(verdict)}`
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      return null
    }

    const executor = this.deps.agentExecutor
    if (decision === 'retry' && isAsyncAgentExecutor(executor) && block) {
      // Reclaim the finished iteration's container so the next one boots fresh — the per-run
      // container would otherwise re-attach to the completed job (idempotent dispatch by run id)
      // and replay its result. The dispatch epoch (from the now-incremented attempts) also
      // changes the job id, but reclaiming keeps a container-reusing transport honest too.
      await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
      return this.dispatchIteration(workspaceId, instance, step, block, verdict)
    }

    // Budget spent (or no async executor to iterate with): give up for human attention.
    return this.failRalph(workspaceId, instance, step, block, verdict)
  }

  /**
   * Dispatch the next fresh-context ralph iteration against the same work branch/PR. The
   * previous iteration's validation output is threaded into the run context as a prior output
   * so the fresh agent sees exactly what still fails; the {@link AgentContextBuilder} folds the
   * next iteration number + the completion command into `ralphValidation` from `step.ralph`.
   */
  async dispatchIteration(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    lastVerdict: RalphVerdict | null,
  ): Promise<AdvanceResult> {
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return { kind: 'job_failed', error: 'No async executor available to run the ralph loop.' }
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const context = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    // Feed the previous iteration's validation failure to the fresh agent as an extra prior
    // output, so it works the actual failing check rather than starting cold. (The agent also
    // reads its own committed progress log on the branch.)
    if (lastVerdict && !lastVerdict.validationPassed) {
      context.priorOutputs = [
        ...context.priorOutputs,
        {
          agentKind: RALPH_AGENT_KIND,
          output: `Previous iteration's validation still fails — ${describeRalphVerdict(lastVerdict)}`,
        },
      ]
    }
    // Surface the cold-boot window before the blocking dispatch (parity with the Coder/Tester):
    // the ralph result view shows the container spinning up, then the live phase on first poll.
    step.container = { status: 'starting' }
    step.subtasks = undefined
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)

    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.container = { status: 'up' }
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Append the just-finished iteration to the step's inspectable history, so the ralph result
   * view can show what each pass did and how its validation ended — a bare attempt count alone
   * is a black box. Mutation only; the caller persists.
   */
  recordAttempt(step: PipelineStep, verdict: RalphVerdict | null, output: string | null): void {
    if (!step.ralph) return
    const now = this.deps.clockNow?.() ?? Date.now()
    const entry: RalphAttempt = {
      attempt: step.ralph.attempts,
      at: now,
      validationPassed: verdict?.validationPassed ?? false,
      ...(verdict ? { exitCode: verdict.exitCode } : {}),
      ...(verdict?.validationOutputTail ? { outputTail: verdict.validationOutputTail } : {}),
      ...(output ? { summary: output } : {}),
    }
    step.ralph.attemptLog = [...(step.ralph.attemptLog ?? []), entry]
  }

  /**
   * Give up on a ralph loop whose completion command never passed within its budget. Records the
   * outcome on the step (left un-`done`, like the CI/Tester gates), raises a human-actionable
   * notification, and fails the run so the block lands `blocked` for a human to take over.
   */
  private async failRalph(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block | null,
    verdict: RalphVerdict | null,
  ): Promise<AdvanceResult> {
    const attempts = step.ralph?.attempts ?? 0
    const detail = describeRalphVerdict(verdict)
    step.output = `Ralph loop gave up after ${attempts} iteration(s): ${detail}`
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    if (this.deps.notificationService && block) {
      await this.deps.notificationService.raise(workspaceId, {
        type: 'decision_required',
        blockId: block.id,
        executionId: instance.id,
        title: `Ralph loop is still failing for "${block.title}"`,
        body:
          `The loop ran ${attempts} iteration(s) but the validation command never passed. ` +
          `${detail} Take a look at the PR and retry the run once addressed.`,
        payload: {
          ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
          pipelineName: instance.pipelineName,
        },
      })
    }
    return {
      kind: 'job_failed',
      failureKind: 'agent',
      error: `Ralph loop did not pass its validation command after ${attempts} iteration(s). ${detail}`,
      detail: step.output,
    }
  }
}
