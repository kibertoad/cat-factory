import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { DEFAULT_MERGE_PRESET, isAsyncAgentExecutor } from '@cat-factory/kernel'
import { type TestReport, type TesterAttempt, parseTestReport } from '@cat-factory/contracts'
import { FIXER_AGENT_KIND, TESTER_AGENT_KIND } from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'

/** Whether a Tester report raised any concern serious enough to block a release. */
function hasBlockingConcerns(report: TestReport): boolean {
  return report.concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
}

/** Whether a Tester report recorded any check that outright FAILED (not skipped). */
function hasFailedOutcome(report: TestReport): boolean {
  return report.outcomes.some((o) => o.status === 'failed')
}

/**
 * Ensure a free-text fragment ends with sentence-terminating punctuation so it can be
 * concatenated into a notification body without running into the following sentence.
 */
function endWithStop(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * The engine's release verdict for a Tester report: greenlit only when the Tester
 * said so AND it raised no blocking (high/critical) concern AND no check failed.
 * Defensive against a harness that greenlights with open blockers or red checks — a
 * failed outcome is itself a blocker, so it loops the fixer regardless of the
 * greenlight flag; low/medium concerns are advisory and do not, on their own, withhold
 * the greenlight or loop the fixer.
 */
function isGreenlit(report: TestReport): boolean {
  return report.greenlight === true && !hasBlockingConcerns(report) && !hasFailedOutcome(report)
}

/** One-line, human-readable summary of a Tester report's concerns, for failure messages. */
function describeTestConcerns(report: TestReport): string {
  if (!report.concerns.length) return report.summary || 'No greenlight given.'
  const names = report.concerns
    .map((c) => `${c.title} (${c.severity})`)
    .slice(0, 5)
    .join(', ')
  return `Concerns: ${names}${report.concerns.length > 5 ? ', …' : ''}`
}

/** Render a Tester report as the resolved-context block handed to the fixer. */
function renderReportForFixer(report: TestReport): string {
  const lines = ['Tester report — fix the concerns below, then the tester will re-run.', '']
  if (report.summary) lines.push(report.summary, '')
  if (report.concerns.length) {
    lines.push('Concerns to fix:')
    for (const c of report.concerns) lines.push(`- [${c.severity}] ${c.title}: ${c.detail}`)
    lines.push('')
  }
  const failed = report.outcomes.filter((o) => o.status === 'failed')
  if (failed.length) {
    lines.push('Failed checks:')
    for (const o of failed) lines.push(`- ${o.name}${o.detail ? `: ${o.detail}` : ''}`)
  }
  return lines.join('\n').trim()
}

/** The engine collaborators the Tester gate drives (kept on the engine, injected here). */
export interface TesterControllerDeps {
  blockRepository: BlockRepository
  notificationService?: NotificationService
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  /** The task's CI/test attempt budget (from the resolved merge preset). */
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<{ ciMaxAttempts: number }>
  /** The async instance/block spine (container reclaim, instance persist + emit). */
  stateMachine: RunStateMachine
}

/**
 * Drives the Tester gate's fix loop: apply a Tester report to its step (greenlight →
 * advance; withheld + budget left → dispatch the fixer and re-test on its completion;
 * withheld + budget spent / unparseable → fail for a human), and re-dispatch the Tester
 * after a fixer job finishes. Extracted out of `ExecutionService`; the shared engine writes
 * (block reads, container reclaim, instance persistence/emit) stay on the engine and are
 * injected via {@link TesterControllerDeps}.
 */
export class TesterController {
  constructor(private readonly deps: TesterControllerDeps) {}

  /**
   * Apply a Tester report to its step's gate. Records the report on the step, then:
   *  - greenlight → returns `null` so `recordStepResult` finishes + advances;
   *  - withheld + budget left → dispatches the `fixer` and parks (re-tested on its
   *    completion, see `pollAgentJob`);
   *  - withheld + budget spent (or unparseable) → fails the run for human attention.
   */
  async resolveTesterResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
  ): Promise<AdvanceResult | null> {
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    let report: TestReport | null = null
    try {
      report = parseTestReport(result.testReport)
    } catch {
      report = null
    }
    if (!step.test) {
      const maxAttempts = block
        ? (await this.deps.resolveMergePreset(workspaceId, block)).ciMaxAttempts
        : DEFAULT_MERGE_PRESET.ciMaxAttempts
      step.test = { phase: 'testing', attempts: 0, maxAttempts, lastReport: null }
    }
    if (report) step.test.lastReport = report
    step.test.phase = 'testing'
    step.subtasks = undefined

    // Auto-abort: the Tester was configured for an ephemeral environment that never came up
    // (provisioning failed), so there is nothing to meaningfully test and no point looping the
    // fixer — it can't provision infrastructure. Stop the run for a human regardless of what
    // (if anything) the report says, BEFORE the unparseable / greenlight checks below.
    if (step.environment?.status === 'failed') {
      return this.abortTester(
        workspaceId,
        instance,
        step,
        block,
        step.environment.lastError ??
          'the ephemeral test environment failed to provision, so the change could not be tested',
      )
    }

    // Report-driven abort: the Tester itself decided it cannot run a meaningful test (and set
    // `abort`), so STOP the run for a human instead of looping the fixer over a non-bug.
    if (report?.abort) {
      return this.abortTester(workspaceId, instance, step, block, report.abort.reason)
    }

    // An unparseable report can't gate a release — fail loudly rather than silently
    // greenlighting or looping forever.
    if (!report) {
      return this.failTester(
        workspaceId,
        instance,
        step,
        block,
        result.output ?? 'Tester returned an unparseable report.',
        'Tester returned an unparseable test report.',
        step.test.attempts,
      )
    }

    // The FIRST testing round always loops the fixer when the report flags ANYTHING — any
    // concern (regardless of severity) or a withheld greenlight — so the first batch of
    // findings is always handed to the fixer. From the SECOND round onward the normal
    // threshold applies (`isGreenlit`: a greenlight stands unless a high/critical concern
    // is open; low/medium concerns are advisory). The defensive greenlight+no-blocker
    // check still protects every round against a harness that greenlights with blockers.
    const firstRound = step.test.attempts === 0
    const accepted = firstRound
      ? report.greenlight === true && report.concerns.length === 0 && !hasFailedOutcome(report)
      : isGreenlit(report)
    if (accepted) return null

    // Withheld greenlight: loop the fixer if any budget remains, else give up.
    const executor = this.deps.agentExecutor
    if (isAsyncAgentExecutor(executor) && block && step.test.attempts < step.test.maxAttempts) {
      // Reclaim the finished Tester container before dispatching the Fixer so the
      // next job boots fresh — the per-run container would otherwise re-attach to the
      // completed Tester job (idempotent dispatch by run id), replaying its result.
      await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
      return this.dispatchFixer(workspaceId, instance, step, block, report)
    }
    // Budget spent (or no async executor to fix with): give up for human attention.
    return this.failTester(
      workspaceId,
      instance,
      step,
      block,
      report.summary || 'Tester withheld its greenlight.',
      `Tester withheld its greenlight after ${step.test.attempts} fix attempt(s). ${describeTestConcerns(report)}`.trim(),
      step.test.attempts,
    )
  }

  /**
   * Re-dispatch the Tester after a Fixer job finished, against the (now-fixed) PR
   * branch. Parks on the fresh Tester job; its report then drives greenlight-or-loop.
   */
  async dispatchTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return { kind: 'job_failed', error: 'No async executor available to run the tester.' }
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const context = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    // The dispatch returned, so the (per-run) container is up; the live phase + id/url
    // arrive on the first poll. Surfaced via the same `container` projection the Coder
    // uses, so the Tester window shows the container lifecycle identically.
    step.container = { status: 'up' }
    step.subtasks = undefined
    if (step.test) step.test.phase = 'testing'
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Append the just-finished `fixer` round to the Tester step's inspectable history, so the
   * test window can show what each attempt set out to fix (the concerns it was handed) and how
   * it ended — a fixer run is otherwise an opaque sub-job behind only a bare attempt count.
   * Called from the driver's fixer-completion branch BEFORE the Tester is re-dispatched.
   * Mutation only; the caller persists + emits as part of the re-dispatch.
   */
  recordFixerOutcome(
    step: PipelineStep,
    outcome: { state: 'done' | 'failed'; output?: string | null; error?: string | null },
    now: number,
  ): void {
    if (!step.test) return
    const summary = outcome.state === 'done' ? outcome.output : outcome.error
    const concerns = step.test.lastReport?.concerns
    const entry: TesterAttempt = {
      attempt: step.test.attempts,
      at: now,
      outcome: outcome.state === 'done' ? 'completed' : 'failed',
      ...(summary ? { summary } : {}),
      ...(concerns && concerns.length ? { concerns } : {}),
    }
    step.test.attemptLog = [...(step.test.attemptLog ?? []), entry]
  }

  /**
   * Give up on a Tester gate that can't be greenlit. Persists the step (left
   * un-`done`, like the CI gate — never falsely completed), raises a human-actionable
   * `test_failed` notification, and fails the run for human attention. Returns the
   * `job_failed` result the driver propagates.
   */
  private async failTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block | null,
    output: string,
    error: string,
    attempts: number,
  ): Promise<AdvanceResult> {
    step.output = output
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.raiseTestFailed(workspaceId, instance, block, error, attempts)
    // Carry the precise classification (`agent`, not the generic container `job_failed`)
    // and the Tester's own summary to the driver's single `failRun` funnel; failing the
    // run here too would let the driver's second `failRun` clobber it.
    return { kind: 'job_failed', failureKind: 'agent', error, detail: output || undefined }
  }

  /**
   * Abort the run from the Tester WITHOUT looping the fixer: the test couldn't run at all
   * (its ephemeral environment never came up, or the Tester reported it can't exercise the
   * change). Records the reason, raises a human-actionable notification, and fails the run as
   * a (retryable) `agent` failure so the block lands `blocked` for a human — never the fixer,
   * which can't provision infrastructure. Mirrors {@link failTester}'s funnel.
   */
  private async abortTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block | null,
    reason: string,
  ): Promise<AdvanceResult> {
    step.output = reason
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.raiseTestAborted(workspaceId, instance, block, reason)
    return {
      kind: 'job_failed',
      failureKind: 'agent',
      error: `Testing could not run: ${reason}`,
      detail: reason,
    }
  }

  /** Raise a `test_failed` notification when the Tester aborts the run (no fix attempted). */
  private async raiseTestAborted(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null,
    reason: string,
  ): Promise<void> {
    if (!this.deps.notificationService || !block) return
    await this.deps.notificationService.raise(workspaceId, {
      type: 'test_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `Testing could not run for "${block.title}"`,
      // Punctuate the reason so it doesn't run into the next sentence (the reason comes from
      // the Tester / env error and may not end with terminal punctuation).
      body:
        `The Tester stopped the run without attempting a fix: ${endWithStop(reason)} ` +
        `Resolve the cause, then retry the run.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /** Raise a `test_failed` notification when the Tester gate gives up. */
  private async raiseTestFailed(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null,
    summary: string,
    attempts: number,
  ): Promise<void> {
    if (!this.deps.notificationService || !block) return
    await this.deps.notificationService.raise(workspaceId, {
      type: 'test_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `Tests are still failing for "${block.title}"`,
      body:
        `The Fixer agent tried ${attempts} time(s) but the Tester still won't greenlight. ${endWithStop(summary)} ` +
        `Take a look and retry the run once fixed.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Dispatch a `fixer` container job for a Tester step that withheld its greenlight:
   * build the agent context with the kind overridden to `fixer` and the Tester's
   * report folded in as resolved context, park on the job, and flip the gate to
   * `fixing`. On the fixer's completion `pollAgentJob` re-dispatches the Tester.
   */
  private async dispatchFixer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    report: TestReport,
  ): Promise<AdvanceResult> {
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return { kind: 'job_failed', error: 'No async executor available to fix test failures.' }
    }
    // The fixer pushes its commits onto the implementation PR branch, so it can only
    // run once a coder/integrator step opened one. A Tester-only pipeline (or one whose
    // earlier step never produced a PR) can't be auto-fixed — fail cleanly with the
    // report instead of letting the job-body builder throw out of the advance.
    if (!block.pullRequest?.branch) {
      return this.failTester(
        workspaceId,
        instance,
        step,
        block,
        report.summary || 'Tester withheld its greenlight.',
        `Tester withheld its greenlight and there is no PR branch for the fixer to push to. ${describeTestConcerns(report)}`.trim(),
        step.test?.attempts ?? 0,
      )
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    const context: AgentRunContext = {
      ...base,
      agentKind: FIXER_AGENT_KIND,
      // Hand the fixer the Tester's report (what failed + the concerns) as context.
      priorOutputs: [
        ...base.priorOutputs,
        { agentKind: TESTER_AGENT_KIND, output: renderReportForFixer(report) },
      ],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    // The fixer's container is up once the dispatch returns; surfaced via the same
    // `container` projection so the Tester window shows the fixer's container lifecycle.
    step.container = { status: 'up' }
    step.subtasks = undefined
    step.test = {
      phase: 'fixing',
      attempts: (step.test?.attempts ?? 0) + 1,
      maxAttempts: step.test?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      lastReport: report,
      // Preserve the inspectable fixer history across the rebuild — this round's entry is
      // appended when the fixer finishes (see recordFixerOutcome).
      ...(step.test?.attemptLog ? { attemptLog: step.test.attemptLog } : {}),
    }
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }
}
