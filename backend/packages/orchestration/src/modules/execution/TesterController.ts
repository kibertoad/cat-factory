import type {
  AgentExecutor,
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  ExecutionInstance,
  PipelineStep,
} from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY, isAsyncAgentExecutor } from '@cat-factory/kernel'
import {
  type TestReport,
  type TesterAttempt,
  TESTER_QC_AGENT_KIND,
  parseTestReport,
  parseTesterInfraSetup,
} from '@cat-factory/contracts'
import { FIXER_AGENT_KIND, TESTER_AGENT_KIND } from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { TesterQualityReviewer } from './TesterQualityReviewService.js'
import { renderQualityFeedbackForTester } from './testerQuality.logic.js'
import { shouldRunGatedStep } from './stepGating.logic.js'

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
  /** The task's CI/test + QC attempt budgets (from the resolved merge preset). */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
  ) => Promise<{ ciMaxAttempts: number; maxTesterQualityIterations: number }>
  /** The async instance/block spine (container reclaim, instance persist + emit). */
  stateMachine: RunStateMachine
  /**
   * Inline reviewer for the test quality-control companion. When wired (and the Tester step
   * has the companion enabled), each Tester report is audited for coverage BEFORE the
   * greenlight/fixer decision; an inadequate report loops the Tester for a more thorough pass.
   * Absent (tests / no model) → QC is a pass-through and the gate behaves exactly as before.
   */
  qualityReviewer?: TesterQualityReviewer
  /** Current time (ms) for stamping QC verdicts. Absent → `Date.now()`. */
  clockNow?: () => number
}

/**
 * Drives the Tester gate's fix loop: apply a Tester report to its step (greenlight →
 * advance; withheld + budget left → dispatch the fixer and re-test on its completion;
 * withheld + budget spent / unparseable → fail for a human), and re-dispatch the Tester
 * after a fixer job finishes. Extracted out of `ExecutionService`; the shared engine writes
 * (block reads, container reclaim, instance persistence/emit) stay on the engine and are
 * injected via {@link TesterControllerDeps}.
 *
 * Every instance write here runs on the DURABLE-DRIVER path (the `tester-verdict` completion
 * interceptor / the fixer-completion re-dispatch), after a slow quality-reviewer LLM call or
 * a container dispatch, so it goes through {@link RunStateMachine.casPersist} rather than a
 * blind upsert: a concurrent human action (a `stopRun`/`cancel`) landing in that window loses
 * the CAS, throws `RunContendedError`, and is caught by the driver's `redriveOnContention`
 * envelope and re-driven on fresh state — never clobbering the human write or resurrecting a
 * cancelled run (race-audit 2.2 controller-half).
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
      const preset = block
        ? await this.deps.resolveRiskPolicy(workspaceId, block)
        : DEFAULT_RISK_POLICY
      step.test = {
        phase: 'testing',
        attempts: 0,
        maxAttempts: preset.ciMaxAttempts,
        lastReport: null,
      }
      // Refresh the QC budget from the task's resolved preset (the step was seeded at run
      // start with the default ceiling); done once, on the first report, alongside the fixer
      // budget so a per-task preset override takes effect.
      if (step.testerQuality) step.testerQuality.maxAttempts = preset.maxTesterQualityIterations
    }
    if (report) step.test.lastReport = report
    // Persist the in-container docker-compose stand-up record (local-infra tester) so the test
    // window can surface WHY the dependencies failed to come up — the failure-class artifact the
    // orchestrator-side provisioning logs can't capture. Refreshed each round (the Tester stands
    // the infra up anew); left untouched when the run reported none (ephemeral / no-infra).
    const infraSetup = parseTesterInfraSetup(result.infraSetup)
    if (infraSetup) step.test.infraSetup = infraSetup
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
      return this.failTester(workspaceId, instance, step, block, {
        output: result.output ?? 'Tester returned an unparseable report.',
        error: 'Tester returned an unparseable test report.',
        attempts: step.test.attempts,
      })
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

    // Test quality-control companion: gate a report that would otherwise CONCLUDE the step
    // (accepted) for coverage completeness BEFORE it is accepted. A report that will loop the
    // fixer (real failures / blocking concerns) is deliberately left to the fixer — QC re-audits
    // the fixed report on a later round rather than re-testing unfixed code or spending its
    // budget before anything is fixed. When the accepted report's coverage is inadequate, QC
    // loops the Tester (folding the prior report + gaps in) for a more thorough pass. A
    // pass-through (companion off / no model / gated out / budget spent / adequate) returns null
    // and the accept-or-fix decision below runs unchanged.
    if (accepted) {
      const qualityResult = await this.runQualityGate(workspaceId, instance, step, block, report)
      if (qualityResult) return qualityResult
    }

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
    return this.failTester(workspaceId, instance, step, block, {
      output: report.summary || 'Tester withheld its greenlight.',
      error:
        `Tester withheld its greenlight after ${step.test.attempts} fix attempt(s). ${describeTestConcerns(report)}`.trim(),
      attempts: step.test.attempts,
    })
  }

  /**
   * The test quality-control gate, run on each report that would otherwise CONCLUDE the step
   * (be accepted) BEFORE it is accepted — a report bound for the fixer is left to the fixer.
   * Returns an `awaiting_job` result when it looped the Tester for a more thorough pass;
   * returns `null` (proceed to the accept decision) when the companion is disabled, unwired,
   * gated out by the task estimate, the report is judged adequate, or the QC budget is spent.
   * Records a verdict per evaluation on `step.testerQuality` for the UI.
   */
  private async runQualityGate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block | null,
    report: TestReport,
  ): Promise<AdvanceResult | null> {
    const qc = step.testerQuality
    // Companion off, unwired reviewer, or no block ⇒ pass-through.
    if (!qc || !qc.enabled || !this.deps.qualityReviewer || !block) return null
    // Already settled as exceeded (budget spent on a prior report) ⇒ don't re-audit; proceed.
    if (qc.exceeded) return null
    // Optional estimate gating: only QC-gate a task heavy enough to qualify.
    if (qc.gating?.enabled && !shouldRunGatedStep(block.estimate, qc.gating)) return null

    const evaluated = await this.deps.qualityReviewer.evaluate(workspaceId, block, report)
    // The reviewer could not resolve a model ⇒ pass-through (never block the pipeline on a QC
    // that can't run), exactly like the requirements reviewer degrading when no model is wired.
    if (!evaluated) return null
    const { outcome, model } = evaluated
    const now = this.deps.clockNow?.() ?? Date.now()
    qc.verdicts = [
      ...(qc.verdicts ?? []),
      {
        adequate: outcome.adequate,
        feedback: outcome.feedback,
        gaps: outcome.gaps,
        at: now,
        model,
      },
    ]

    // Adequate report ⇒ proceed to the normal greenlight/fixer decision.
    if (outcome.adequate) {
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      return null
    }

    // Inadequate + budget remains ⇒ loop the Tester for a focused additional pass.
    const attempts = qc.attempts ?? 0
    const executor = this.deps.agentExecutor
    if (isAsyncAgentExecutor(executor) && attempts < qc.maxAttempts) {
      qc.attempts = attempts + 1
      // Reclaim the finished Tester container so the re-run boots fresh (idempotent dispatch by
      // run id would otherwise re-attach to the completed job and replay its report).
      await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
      return this.dispatchTester(
        workspaceId,
        instance,
        step,
        block,
        renderQualityFeedbackForTester(outcome, report),
      )
    }

    // Budget spent (or no async executor to re-run) ⇒ stop gating and proceed with the report.
    qc.exceeded = true
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    return null
  }

  /**
   * Re-dispatch the Tester after a Fixer job finished, against the (now-fixed) PR
   * branch. Parks on the fresh Tester job; its report then drives greenlight-or-loop.
   * `qualityFeedback`, when present (a QC-driven re-run), is folded into the run context
   * so the Tester closes the coverage gaps the quality companion flagged.
   */
  async dispatchTester(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    qualityFeedback?: string,
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
    // A QC-driven re-run hands the Tester the quality companion's gaps + prior report as an
    // extra prior output, so it does a focused additional pass rather than starting cold.
    if (qualityFeedback) {
      context.priorOutputs = [
        ...context.priorOutputs,
        { agentKind: TESTER_QC_AGENT_KIND, output: qualityFeedback },
      ]
    }
    // Surface the cold-boot window BEFORE the blocking dispatch (it blocks until the per-run
    // container is up and accepts the job), so the Tester window shows "spinning up" then the
    // live phase via the same `container` projection the Coder uses — true parity, instead of
    // jumping straight to "running".
    step.container = { status: 'starting' }
    step.subtasks = undefined
    if (step.test) step.test.phase = 'testing'
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)

    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    // The dispatch returned, so the container is up; the live phase + id/url arrive on the
    // first poll, surfaced via the same `container` projection identically to the Coder.
    step.container = { status: 'up' }
    await this.deps.stateMachine.casPersist(workspaceId, instance)
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
    failure: { output: string; error: string; attempts: number },
  ): Promise<AdvanceResult> {
    const { output, error, attempts } = failure
    step.output = output
    await this.deps.stateMachine.casPersist(workspaceId, instance)
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
    await this.deps.stateMachine.casPersist(workspaceId, instance)
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
      return this.failTester(workspaceId, instance, step, block, {
        output: report.summary || 'Tester withheld its greenlight.',
        error:
          `Tester withheld its greenlight and there is no PR branch for the fixer to push to. ${describeTestConcerns(report)}`.trim(),
        attempts: step.test?.attempts ?? 0,
      })
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Build the context AS the fixer: the hosting step's kind is the tester, so the
    // `code-aware` service-fragment fold must key off the fixer's kind (the tester
    // itself is not code-aware — it only reads).
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      { agentKind: FIXER_AGENT_KIND },
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
    // Surface the cold-boot window before the blocking dispatch, then `up` once it returns —
    // same `container` projection the Coder uses, so the Tester window shows the fixer's
    // container spinning up then running rather than jumping straight to "running".
    step.container = { status: 'starting' }
    step.subtasks = undefined
    step.test = {
      phase: 'fixing',
      attempts: (step.test?.attempts ?? 0) + 1,
      maxAttempts: step.test?.maxAttempts ?? DEFAULT_RISK_POLICY.ciMaxAttempts,
      lastReport: report,
      // Preserve the inspectable fixer history across the rebuild — this round's entry is
      // appended when the fixer finishes (see recordFixerOutcome).
      ...(step.test?.attemptLog ? { attemptLog: step.test.attemptLog } : {}),
    }
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)

    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    // The fixer's container is up once the dispatch returns; the live phase + id/url arrive
    // on the first poll.
    step.container = { status: 'up' }
    await this.deps.stateMachine.casPersist(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }
}
