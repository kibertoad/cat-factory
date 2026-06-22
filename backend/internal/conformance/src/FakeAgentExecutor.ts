import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentKind,
  AgentRunContext,
  AgentRunResult,
  AsyncAgentExecutor,
  PullRequestRef,
  TestReport,
} from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import { isCompanionKind } from '@cat-factory/agents'

export interface FakeAgentOptions {
  /** Confidence reported on the final step (drives auto-merge vs PR). Default 1. */
  confidence?: number
  /** Step indices that should raise a decision (once) before completing. */
  decisionOnSteps?: number[]
  /**
   * Agent kinds the {@link AsyncFakeAgentExecutor} should drive as a POLLED async job
   * (`startJob`/`pollJob`) rather than running inline — so the conformance suite can
   * exercise the durable driver's `awaiting_job` poll loop identically on both runtimes.
   */
  asyncKinds?: AgentKind[]
  /** Number of `running` polls an async job reports before `done`. Default 2. */
  asyncPolls?: number
  /** Token usage reported per call, so the spend safeguard can be exercised. */
  usage?: { inputTokens: number; outputTokens: number }
  /**
   * When set, the (generic-kind) agent echoes the description it was handed into its
   * output as `[desc]…[/desc]`, so a test can assert WHICH requirements text the engine
   * fed it — e.g. that a block's reworked requirements replaced its raw description.
   */
  echoDescription?: boolean
  /**
   * When set, the (generic-kind) agent echoes the ids of the resolved best-practice
   * fragments it was handed as `[frags]id,id[/frags]`, so a test can assert WHICH
   * fragments the engine folded in — e.g. that only `code-aware` kinds receive the
   * running service's `serviceFragmentIds`.
   */
  echoFragments?: boolean
  /** A PR the (container-flavoured) agent reports opening, so persistence can be exercised. */
  pullRequest?: PullRequestRef
  /**
   * A blueprint tree the `blueprints` step reports, so the engine's ingest +
   * board reconcile can be exercised without a real container.
   */
  blueprintService?: unknown
  /**
   * A spec doc the `spec-writer` step reports, so the engine's strict-parse + ingest
   * can be exercised without a real container.
   */
  spec?: unknown
  /**
   * Overall quality rating (0..1) every companion step returns, so the engine's
   * companion review + rework loop can be exercised deterministically. When omitted a
   * companion returns a passing rating of 1.
   */
  companionRating?: number
  /**
   * A SEQUENCE of companion ratings, one per successive companion grading call (the
   * last value repeats once exhausted). Lets a test drive the rework loop and then
   * recover — e.g. `[0.4, 1]` fails the first grade (looping the producer back) then
   * passes the re-grade. Takes precedence over `companionRating` when set.
   */
  companionRatings?: number[]
  /**
   * When true, every companion step returns NON-JSON output, so the engine's verdict
   * parse fails (even after its repair retry). Exercises the guard that a companion
   * whose own reply can't be parsed surfaces for a human (run fails) rather than being
   * silently treated as a perfect pass — the bug where a truncated reviewer showed 100%.
   */
  companionMalformed?: boolean
  /**
   * The assessment the `merger` step reports. When omitted, the fake derives one
   * from `confidence` so existing tests keep their semantics: high confidence
   * (≥ 0.8) yields a within-threshold assessment (auto-merge → `done`), and low
   * confidence yields a severe assessment (raise `merge_review` → `pr_ready`).
   */
  mergeAssessment?: { complexity: number; risk: number; impact: number; rationale: string }
  /**
   * A SEQUENCE of test reports the `tester` step returns, one per successive Tester
   * call (the last repeats once exhausted). Lets a test drive the Tester→Fixer loop:
   * e.g. a first report that withholds its greenlight (the engine loops the `fixer`),
   * then a greenlit one. When omitted the Tester greenlights immediately.
   */
  testReports?: TestReport[]
}

/**
 * Deterministic agent for integration + conformance tests. It performs no network
 * calls and behaves predictably, so the engine's orchestration (step advancement,
 * decisions, finalisation) can be asserted exactly — without the cost or
 * nondeterminism of a real LLM. This is the single canonical fake shared by every
 * runtime facade, so the cross-runtime conformance suite drives identical agent
 * behaviour on the Cloudflare Worker and the Node service.
 */
export class FakeAgentExecutor implements AgentExecutor {
  constructor(private readonly options: FakeAgentOptions = {}) {}

  /** Count of companion grading calls so far, to walk `companionRatings` in order. */
  private companionCalls = 0

  /** Count of Tester calls so far, to walk `testReports` in order. */
  private testerCalls = 0

  // Matches the `model: 'fake'` every result carries, so the engine's up-front
  // model preview (shown on the first "spinning up container" / querying emit)
  // resolves to the same value the result later confirms.
  async resolveModel(): Promise<string> {
    return 'fake'
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const raisesDecision =
      this.options.decisionOnSteps?.includes(context.stepIndex) && !context.resolvedDecision
    if (raisesDecision) {
      return {
        decision: {
          question: `Decision for ${context.agentKind}?`,
          options: ['Option A', 'Option B'],
        },
        usage: this.options.usage,
      }
    }

    // Mimic the container Blueprinter step returning a decomposition tree.
    if (context.agentKind === 'blueprints' && this.options.blueprintService !== undefined) {
      return {
        output: `[blueprints] mapped "${context.block.title}"`,
        model: 'fake',
        blueprintService: this.options.blueprintService,
      }
    }

    // Mimic the container spec-writer step returning the unified doc, and surface the
    // aggregated task context it was given so the engine's population of
    // `serviceTasks` can be asserted.
    if (context.agentKind === 'spec-writer' && this.options.spec !== undefined) {
      const tasks = context.serviceTasks?.length ?? 0
      return {
        output: `[spec-writer] wrote spec for "${context.block.title}" from ${tasks} task(s)`,
        model: 'fake',
        spec: this.options.spec,
      }
    }

    // Mimic a companion step grading the prior producer: return the configured rating
    // (default 1 = pass) as the JSON assessment the engine parses. A `companionRatings`
    // sequence walks one rating per grade (last repeats) so a test can fail then pass.
    if (isCompanionKind(context.agentKind)) {
      // A companion whose reply can't be parsed: return prose, not JSON, so the engine's
      // verdict parse (and its repair retry) fail and the run surfaces for a human.
      if (this.options.companionMalformed) {
        this.companionCalls += 1
        return {
          output: 'I reviewed it and it looks fine overall, but my reply got cut off mid-',
          model: 'fake',
          usage: this.options.usage,
        }
      }
      const seq = this.options.companionRatings
      const rating = seq?.length
        ? (seq[Math.min(this.companionCalls, seq.length - 1)] ?? 1)
        : (this.options.companionRating ?? 1)
      this.companionCalls += 1
      // A downrating critic also returns anchor-based per-item comments (the shape the
      // real Spec Reviewer emits: `{anchorId, body}`, with NO `quotedSource`). Emitting
      // them here exercises the actual `companionAssessmentSchema`/`stepReviewCommentSchema`
      // parse the engine runs — guarding the regression where an anchor-only comment made
      // the verdict unparseable and the rating silently defaulted to a passing 1.
      const comments =
        rating < 1 ? [{ anchorId: `${context.agentKind}-1`, body: 'address this gap' }] : undefined
      return {
        output: JSON.stringify({
          rating,
          summary: `[${context.agentKind}] rated ${(rating * 100).toFixed(0)}%`,
          ...(comments ? { comments } : {}),
        }),
        model: 'fake',
        usage: this.options.usage,
      }
    }

    // The `tester` step returns a structured report. A `testReports` sequence walks
    // one report per Tester call (last repeats) so a test can drive a withheld
    // greenlight → fixer loop → greenlight; omitted ⇒ greenlight immediately.
    if (context.agentKind === 'tester') {
      const seq = this.options.testReports
      const report: TestReport = seq?.length
        ? (seq[Math.min(this.testerCalls, seq.length - 1)] ?? greenReport())
        : greenReport()
      this.testerCalls += 1
      return {
        output: `[tester] ${report.greenlight ? 'greenlit' : 'found issues for'} "${context.block.title}"`,
        model: 'fake',
        testReport: report,
      }
    }

    // The `fixer` step just reports success so the engine re-dispatches the Tester.
    if (context.agentKind === 'fixer') {
      return { output: `[fixer] applied fixes for "${context.block.title}"`, model: 'fake' }
    }

    const confidence = this.options.confidence ?? 1

    // The `merger` step returns a PR assessment the engine compares to the task's
    // thresholds. Derive it from `confidence` (unless explicitly supplied) so the
    // old auto-merge-vs-PR semantics carry over: high confidence → within-threshold
    // (auto-merge), low confidence → severe (raise a review notification).
    if (context.agentKind === 'merger') {
      const severe = confidence < 0.8
      const mergeAssessment =
        this.options.mergeAssessment ??
        (severe
          ? { complexity: 1, risk: 1, impact: 1, rationale: 'fake: low confidence' }
          : { complexity: 0, risk: 0, impact: 0, rationale: 'fake: high confidence' })
      return {
        output: `[merger] assessed "${context.block.title}"`,
        model: 'fake',
        confidence: context.isFinalStep ? confidence : undefined,
        usage: this.options.usage,
        mergeAssessment,
      }
    }

    // Surface revision feedback (and any per-block comment count) so a "request
    // changes" re-run — freeform and/or comment-driven — can be asserted.
    const commentCount = context.revision?.comments?.length ?? 0
    const revisionSuffix = context.revision
      ? ` [revised: ${context.revision.feedback ?? ''}${commentCount ? ` +${commentCount} comments` : ''}]`
      : ''
    const descSuffix = this.options.echoDescription
      ? ` [desc]${context.block.description}[/desc]`
      : ''
    const fragSuffix = this.options.echoFragments
      ? ` [frags]${(context.block.resolvedFragments ?? []).map((f) => f.id).join(',')}[/frags]`
      : ''
    return {
      output: `[${context.agentKind}] processed "${context.block.title}"${revisionSuffix}${descSuffix}${fragSuffix}`,
      model: 'fake',
      confidence: context.isFinalStep ? confidence : undefined,
      usage: this.options.usage,
      // Mimic the container "implementer" agent opening a PR for repo-operating work.
      ...(this.options.pullRequest ? { pullRequest: this.options.pullRequest } : {}),
    }
  }
}

/** A passing test report (no concerns, greenlit) — the Tester's default outcome. */
function greenReport(): TestReport {
  return {
    greenlight: true,
    summary: 'fake: all tests passed',
    tested: ['fake requirement'],
    outcomes: [{ name: 'fake requirement', status: 'passed' }],
    concerns: [],
  }
}

/**
 * A {@link FakeAgentExecutor} that additionally drives the configured `asyncKinds` as
 * POLLED jobs — the deterministic analogue of the container executor. It reports
 * `running` for `asyncPolls` polls (surfacing subtask progress) and then `done` with the
 * same work product `run()` would have produced. This lets the conformance suite exercise
 * the durable driver's `awaiting_job` poll loop (Cloudflare Workflows / pg-boss) on BOTH
 * runtimes, so that path can't silently drift between them. Kept as a SEPARATE class so the
 * default fake stays a plain (non-async) `AgentExecutor` — flipping `isAsyncAgentExecutor`
 * for every test would change the CI-fixer / conflict-resolver / stopJob gates.
 */
export class AsyncFakeAgentExecutor extends FakeAgentExecutor implements AsyncAgentExecutor {
  private readonly jobs = new Map<string, { polled: number; context: AgentRunContext }>()
  private readonly asyncKinds: ReadonlySet<AgentKind>
  private readonly asyncPolls: number

  constructor(options: FakeAgentOptions = {}) {
    super(options)
    this.asyncKinds = new Set(options.asyncKinds ?? [])
    this.asyncPolls = Math.max(1, options.asyncPolls ?? 2)
  }

  runsAsync(context: AgentRunContext): boolean {
    return this.asyncKinds.has(context.agentKind)
  }

  // Deterministic, idempotent job id per (execution, step): a replayed dispatch
  // re-attaches to the same job rather than starting a duplicate.
  private jobIdFor(context: AgentRunContext): string {
    return `fakejob:${context.executionId ?? 'noexec'}:${context.stepIndex}`
  }

  async startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    const jobId = this.jobIdFor(context)
    if (!this.jobs.has(jobId)) this.jobs.set(jobId, { polled: 0, context })
    return { jobId, model: 'fake', workspaceId: context.workspaceId }
  }

  /**
   * Release the run's jobs — the deterministic analogue of reclaiming the per-run
   * container. The engine releases by run id (executionId) between Tester→Fixer loop
   * iterations so the next job runs fresh; clearing every slot for the run lets the
   * re-dispatched job re-run (and the `testReports` sequence advance) rather than
   * re-attaching to a finished result.
   */
  async stopJob(handle: AgentJobHandle): Promise<void> {
    const prefix = `fakejob:${handle.jobId}:`
    for (const id of this.jobs.keys()) if (id.startsWith(prefix)) this.jobs.delete(id)
  }

  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const job = this.jobs.get(handle.jobId)
    // An unknown job id (e.g. polled after a result was already recorded) is treated as
    // finished work; the engine clears the handle once a result lands, so it won't re-poll.
    if (!job) return { state: 'done', result: { output: '[async] done', model: 'fake' } }
    job.polled += 1
    if (job.polled < this.asyncPolls) {
      return {
        state: 'running',
        subtasks: { completed: job.polled, inProgress: 1, total: this.asyncPolls },
      }
    }
    return { state: 'done', result: await this.run(job.context) }
  }
}
