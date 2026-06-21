import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentKind,
  AgentRunContext,
  AgentRunResult,
  AsyncAgentExecutor,
  PullRequestRef,
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
   * The assessment the `merger` step reports. When omitted, the fake derives one
   * from `confidence` so existing tests keep their semantics: high confidence
   * (≥ 0.8) yields a within-threshold assessment (auto-merge → `done`), and low
   * confidence yields a severe assessment (raise `merge_review` → `pr_ready`).
   */
  mergeAssessment?: { complexity: number; risk: number; impact: number; rationale: string }
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
      const seq = this.options.companionRatings
      const rating = seq?.length
        ? (seq[Math.min(this.companionCalls, seq.length - 1)] ?? 1)
        : (this.options.companionRating ?? 1)
      this.companionCalls += 1
      return {
        output: JSON.stringify({
          rating,
          summary: `[${context.agentKind}] rated ${(rating * 100).toFixed(0)}%`,
        }),
        model: 'fake',
        usage: this.options.usage,
      }
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
    return {
      output: `[${context.agentKind}] processed "${context.block.title}"${revisionSuffix}${descSuffix}`,
      model: 'fake',
      confidence: context.isFinalStep ? confidence : undefined,
      usage: this.options.usage,
      // Mimic the container "implementer" agent opening a PR for repo-operating work.
      ...(this.options.pullRequest ? { pullRequest: this.options.pullRequest } : {}),
    }
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
