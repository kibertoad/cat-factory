import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentKind,
  AgentRunContext,
  AgentRunResult,
  AsyncAgentExecutor,
  PullRequestRef,
  PeerPullRequest,
  TestReport,
} from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  defaultAgentKindRegistry,
  isCompanionKind,
} from '@cat-factory/agents'

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
  /**
   * Agent kinds whose `startJob` should THROW (the container/runner never accepts the
   * job), so the conformance suite can assert the engine's dispatch-failure
   * classification — the run fails with `failureKind: 'dispatch'` ("Container failed to
   * start") identically on both runtimes. Only meaningful for {@link asyncKinds}.
   */
  dispatchThrowKinds?: AgentKind[]
  /** The verbatim error a {@link dispatchThrowKinds} dispatch throws. Default a generic 503. */
  dispatchThrowMessage?: string
  /**
   * Agent kinds whose async poll reports a FAILED job carrying the harness's STRUCTURED
   * `failureCause` (and `detail`), so the conformance suite can assert the engine maps the
   * cause → {@link AgentFailureKind} (e.g. `inactivity-timeout` → `timeout`) and surfaces the
   * harness detail — identically on both runtimes. Only meaningful for {@link asyncKinds}.
   */
  pollFailKinds?: AgentKind[]
  /** The structured `failureCause` a {@link pollFailKinds} poll reports. Default `inactivity-timeout`. */
  pollFailCause?: string
  /** The extended `detail` a {@link pollFailKinds} poll reports. Default a phase-timing breadcrumb. */
  pollFailDetail?: string
  /** Token usage reported per call, so the spend safeguard can be exercised. */
  usage?: { inputTokens: number; outputTokens: number }
  /**
   * How {@link usage} is billed. `'subscription'` marks a flat-rate quota-harness run so the
   * usage report counts it but the spend budget excludes it; omit (⇒ metered) for a real
   * per-token cost that the budget sums. Lets the suite pin the metered-vs-subscription split.
   */
  usageBilling?: 'metered' | 'subscription'
  /** The subscription vendor tagged onto a `'subscription'` {@link usageBilling} run. */
  usageVendor?: string
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
  /**
   * When set, the (generic-kind) agent echoes the initiative-preset steering it was handed
   * as `[preset]label|promptAddition[/preset]`, so a test can assert the engine resolved the
   * preset's per-kind methodology onto a SPAWNED run's context (D1). Empty `[preset][/preset]`
   * when no preset reached the run.
   */
  echoPreset?: boolean
  /** A PR the (container-flavoured) agent reports opening, so persistence can be exercised. */
  pullRequest?: PullRequestRef
  /**
   * PRs the (container-flavoured) agent reports opening in CONNECTED services' repos during a
   * multi-repo run (service-connections phase 3), so the engine's `peerPullRequests` recording +
   * persistence round-trip can be exercised without a real container. Beside {@link pullRequest}.
   */
  peerPullRequests?: PeerPullRequest[]
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
   * When true the `spec-writer` step reports `noBusinessSpecs` (a purely technical task)
   * instead of a spec doc, so the engine's "no new specs" path + the `technical` label
   * inference can be exercised. Takes precedence over {@link spec}.
   */
  noBusinessSpecs?: boolean
  /**
   * The `technicalCorroborated` verdict the `spec-companion` includes in its assessment
   * (the spec phase's business-vs-technical corroboration). Omitted ⇒ no opinion (the
   * engine infers nothing). Drives the cross-runtime `technical`-label inference assertion.
   */
  technicalCorroborated?: boolean
  /**
   * The triage a `task-estimator` step emits (as JSON output the engine parses onto
   * `block.estimate`). Omitted ⇒ a deterministic default, so the persistence round-trip
   * can be asserted identically across runtimes.
   */
  taskEstimate?: { complexity: number; risk: number; impact: number; rationale: string }
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
   * The assessment the `on-call` step reports as `result.onCallAssessment` — the
   * post-release-health gate's INVESTIGATE-don't-fix helper. On a release regression the gate
   * escalates the on-call agent; its completion is resolved specially (`resolveHelperCompletion`)
   * to raise a `release_regression` notification carrying this assessment. Omitted ⇒ a
   * deterministic default so the notification payload always carries a recommendation.
   */
  onCallAssessment?: {
    culpritConfidence: number
    recommendation: 'revert' | 'hold' | 'monitor'
    rationale: string
    evidence?: string[]
  }
  /**
   * A SEQUENCE of test reports the `tester` step returns, one per successive Tester
   * call (the last repeats once exhausted). Lets a test drive the Tester→Fixer loop:
   * e.g. a first report that withholds its greenlight (the engine loops the `fixer`),
   * then a greenlit one. When omitted the Tester greenlights immediately.
   */
  testReports?: TestReport[]
  /**
   * The in-container docker-compose dependency stand-up record a `tester` step reports
   * alongside its report (the deterministic analogue of the harness capturing `docker
   * compose up` logs). Lets the conformance suite assert it round-trips onto
   * `step.test.infraSetup` identically on both stores. Omitted ⇒ the tester reports none
   * (ephemeral / no-infra).
   */
  testerInfraSetup?: {
    started: boolean
    composePath?: string
    at: number
    durationMs?: number
    logs?: string
    error?: string
  }
  /**
   * The structured JSON a registered CUSTOM kind (one with a `container-explore`
   * structured agent step) returns as `result.custom`, so the engine's generic post-op
   * (coerce → render → commit via the checkout-free RepoFiles port) can be exercised
   * without a real container. Omitted ⇒ a deterministic `{ ok: true }`.
   */
  customResult?: unknown
  /**
   * The multi-phase plan draft the `initiative-planner` step returns as `result.initiativePlan`
   * (an {@link InitiativePlanDraft}); the engine ingests it via `InitiativeService.ingestPlan`.
   * Set it whenever a test drives an initiative PLANNING pipeline to completion — the planner's
   * post-completion resolver FAULTS the run when the plan is absent, so without this the fake's
   * generic prose result would fail every planning run. The analyst/committer need no companion
   * option: the analyst's benign prose feeds `recordAnalysis`, and the committer is a
   * deterministic engine step that never calls the executor. Omitted ⇒ no plan channel.
   */
  initiativePlan?: unknown
  /**
   * Forward-looking follow-up / question items the async `coder` streams on its FIRST
   * running poll (the deterministic analogue of the harness tailing the sentinel file), so
   * the conformance suite can exercise the Follow-up companion gate (park until decided →
   * loop / advance) without a real container. Emitted once per fresh job. Omitted ⇒ none.
   */
  followUps?: { kind: 'follow_up' | 'question'; title: string; detail?: string }[]
  /**
   * Model a CONTAINER-REUSING runner (a warm local pool / self-hosted runner pool) instead
   * of the default per-run-container transport. A pooled member's harness `JobRegistry`
   * survives across rounds (reclaiming it does NOT destroy it), so:
   *  - jobs are keyed by the SAME identity the real {@link ContainerAgentExecutor} uses —
   *    `run + agentKind + dispatchEpoch` — rather than the step index, and
   *  - a re-dispatch RE-ATTACHES to an existing entry and replays its STORED result (the
   *    harness never re-runs a job it already has), and `stopJob` does NOT clear it.
   * This reproduces the Tester→Fixer bug where a re-test silently replayed the first
   * round's report: it loops/“passes regardless” WITHOUT the per-round `dispatchEpoch`
   * fix, and re-runs correctly WITH it. Default false (per-run container, fresh each round).
   */
  pooledContainer?: boolean
  /**
   * The app-owned agent-kind registry the fake reads to detect a structured `container-explore`
   * kind (built-in `bug-investigator` or a registered CUSTOM kind) so it returns `result.custom`.
   * The custom-kind conformance case injects the SAME instance the container was built with;
   * omitted ⇒ a fresh {@link defaultAgentKindRegistry} (built-ins only).
   */
  agentKindRegistry?: AgentKindRegistry
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
  /** The agent-kind registry backing the structured-output detection (defaults to built-ins). */
  protected readonly agentKindRegistry: AgentKindRegistry

  constructor(private readonly options: FakeAgentOptions = {}) {
    this.agentKindRegistry = options.agentKindRegistry ?? defaultAgentKindRegistry()
  }

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

  /** The usage fields to spread onto a result: the token counts + optional billing tag. */
  private usageFields(): Pick<AgentRunResult, 'usage' | 'usageBilling' | 'usageVendor'> {
    return {
      usage: this.options.usage,
      ...(this.options.usageBilling ? { usageBilling: this.options.usageBilling } : {}),
      ...(this.options.usageVendor ? { usageVendor: this.options.usageVendor } : {}),
    }
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
        ...this.usageFields(),
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

    // Mimic the container spec-writer step returning the updated doc. It applies ONLY
    // the current task's requirements (the block description) as an increment onto the
    // baseline — there is no cross-task aggregation to surface.
    if (context.agentKind === 'spec-writer') {
      // A purely technical task: report "no business specs" (the engine leaves the
      // baseline untouched and records the determination for the technical-label inference).
      if (this.options.noBusinessSpecs) {
        return {
          output: `[spec-writer] no business specs for "${context.block.title}"`,
          model: 'fake',
          noBusinessSpecs: true,
        }
      }
      if (this.options.spec !== undefined) {
        return {
          output: `[spec-writer] wrote spec increment for "${context.block.title}"`,
          model: 'fake',
          spec: this.options.spec,
        }
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
          ...this.usageFields(),
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
      // The spec-companion corroborates the writer's business-vs-technical determination
      // when configured, so the engine's `technical`-label inference can be exercised.
      const corroborated =
        context.agentKind === 'spec-companion' ? this.options.technicalCorroborated : undefined
      return {
        output: JSON.stringify({
          rating,
          summary: `[${context.agentKind}] rated ${(rating * 100).toFixed(0)}%`,
          ...(comments ? { comments } : {}),
          ...(corroborated !== undefined ? { technicalCorroborated: corroborated } : {}),
        }),
        model: 'fake',
        ...this.usageFields(),
      }
    }

    // The `tester` step returns a structured report. A `testReports` sequence walks
    // one report per Tester call (last repeats) so a test can drive a withheld
    // greenlight → fixer loop → greenlight; omitted ⇒ greenlight immediately.
    if (context.agentKind === 'tester-api' || context.agentKind === 'tester-ui') {
      const seq = this.options.testReports
      const report: TestReport = seq?.length
        ? (seq[Math.min(this.testerCalls, seq.length - 1)] ?? greenReport())
        : greenReport()
      this.testerCalls += 1
      return {
        output: `[tester] ${report.greenlight ? 'greenlit' : 'found issues for'} "${context.block.title}"`,
        model: 'fake',
        testReport: report,
        // The in-container compose stand-up record rides back exactly as the harness sends it,
        // so the engine's persist → reload round-trip onto `step.test.infraSetup` is asserted.
        ...(this.options.testerInfraSetup ? { infraSetup: this.options.testerInfraSetup } : {}),
      }
    }

    // The `fixer` step just reports success so the engine re-dispatches the Tester.
    if (context.agentKind === 'fixer') {
      return { output: `[fixer] applied fixes for "${context.block.title}"`, model: 'fake' }
    }

    // The `task-estimator` step emits a JSON triage the engine parses + persists onto
    // `block.estimate` (the new column on both stores). Deterministic so the conformance
    // suite can assert the round-trip is identical across runtimes.
    if (context.agentKind === 'task-estimator') {
      const estimate = this.options.taskEstimate ?? {
        complexity: 0.7,
        risk: 0.8,
        impact: 0.6,
        rationale: 'fake estimate',
      }
      return { output: JSON.stringify(estimate), model: 'fake' }
    }

    // A registered CUSTOM kind whose agent step declares a structured output returns its
    // parsed JSON as `custom` — exactly what the generic manifest-driven `agent` dispatch
    // surfaces — so the engine's registered post-op (render + commit via RepoFiles) runs
    // without a container. Detected from the registry, so the shared fake needs no per-kind id.
    if (this.agentKindRegistry.agentStep(context.agentKind)?.output?.kind === 'structured') {
      return {
        output: `[${context.agentKind}] produced structured output for "${context.block.title}"`,
        model: 'fake',
        custom: this.options.customResult ?? { ok: true },
      }
    }

    // The initiative PLANNER returns the multi-phase plan the engine ingests
    // (`InitiativeService.ingestPlan` → the preset's phase-template normalizer + `seedPlan`),
    // then the loop spawns the decorated tasks. Without this channel the planner's
    // post-completion resolver faults the run (an absent plan is a hard error), so a test that
    // drives create-with-preset → auto-plan → spawn supplies the draft via `initiativePlan`.
    if (context.agentKind === 'initiative-planner' && this.options.initiativePlan !== undefined) {
      return {
        output: `[initiative-planner] planned "${context.block.title}"`,
        model: 'fake',
        initiativePlan: this.options.initiativePlan,
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
        ...this.usageFields(),
        mergeAssessment,
      }
    }

    // The `on-call` step (the post-release-health gate's helper) INVESTIGATES a release
    // regression and returns a structured assessment — it makes no commits and reverts
    // nothing. The engine coerces this into `result.onCallAssessment`, which the gate's
    // `resolveHelperCompletion` folds into the `release_regression` notification. Without this
    // channel the generic prose fall-through would leave the assessment null.
    if (context.agentKind === 'on-call') {
      return {
        output: `[on-call] investigated "${context.block.title}"`,
        model: 'fake',
        onCallAssessment: this.options.onCallAssessment ?? {
          culpritConfidence: 0.8,
          recommendation: 'hold',
          rationale: 'fake: the regression correlates with the released diff',
          evidence: [],
        },
        ...this.usageFields(),
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
    const preset = context.initiative?.preset
    const presetSuffix = this.options.echoPreset
      ? ` [preset]${preset ? `${preset.label}|${preset.promptAddition ?? ''}` : ''}[/preset]`
      : ''
    return {
      output: `[${context.agentKind}] processed "${context.block.title}"${revisionSuffix}${descSuffix}${fragSuffix}${presetSuffix}`,
      model: 'fake',
      confidence: context.isFinalStep ? confidence : undefined,
      ...this.usageFields(),
      // Mimic the container "implementer" agent opening a PR for repo-operating work.
      ...(this.options.pullRequest ? { pullRequest: this.options.pullRequest } : {}),
      // ...and, for a multi-repo run, the PRs it opened in the connected services' repos.
      ...(this.options.peerPullRequests?.length
        ? { peerPullRequests: this.options.peerPullRequests }
        : {}),
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
  private readonly jobs = new Map<
    string,
    { polled: number; context: AgentRunContext; result?: AgentRunResult }
  >()
  private readonly asyncKinds: ReadonlySet<AgentKind>
  private readonly pooledContainer: boolean
  private readonly asyncPolls: number
  private readonly dispatchThrowKinds: ReadonlySet<AgentKind>
  private readonly dispatchThrowMessage: string
  private readonly pollFailKinds: ReadonlySet<AgentKind>
  private readonly pollFailCause: string
  private readonly pollFailDetail: string
  protected readonly followUpItems: FakeAgentOptions['followUps']

  constructor(options: FakeAgentOptions = {}) {
    super(options)
    this.asyncKinds = new Set(options.asyncKinds ?? [])
    this.pooledContainer = options.pooledContainer ?? false
    this.asyncPolls = Math.max(1, options.asyncPolls ?? 2)
    this.dispatchThrowKinds = new Set(options.dispatchThrowKinds ?? [])
    this.dispatchThrowMessage =
      options.dispatchThrowMessage ?? 'Container dispatch failed (HTTP 503): no capacity'
    this.pollFailKinds = new Set(options.pollFailKinds ?? [])
    this.pollFailCause = options.pollFailCause ?? 'inactivity-timeout'
    this.pollFailDetail =
      options.pollFailDetail ??
      'Phase timings: clone=2s, agent=600s. last completed tool bash 600s ago.'
    this.followUpItems = options.followUps
  }

  runsAsync(context: AgentRunContext): boolean {
    return this.asyncKinds.has(context.agentKind)
  }

  // Deterministic, idempotent job id per (execution, step): a replayed dispatch
  // re-attaches to the same job rather than starting a duplicate. In `pooledContainer`
  // mode it mirrors the real ContainerAgentExecutor's `stepJobId(run, kind, epoch)` so a
  // re-dispatched step (the Tester re-test, a fixer round) only gets a fresh job when the
  // engine bumps the dispatch epoch — otherwise it re-attaches to the prior round's result.
  private jobIdFor(context: AgentRunContext): string {
    if (this.pooledContainer) {
      const base = `fakejob:${context.executionId ?? 'noexec'}:${context.agentKind}`
      const epoch = context.dispatchEpoch ?? 0
      return epoch > 0 ? `${base}:${epoch}` : base
    }
    return `fakejob:${context.executionId ?? 'noexec'}:${context.stepIndex}`
  }

  async startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    // Simulate a container/runner that never accepts the job, so the engine's
    // dispatch-failure classification (failureKind 'dispatch') is exercised.
    if (this.dispatchThrowKinds.has(context.agentKind)) {
      throw new Error(this.dispatchThrowMessage)
    }
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
    // A pooled member is RETURNED to the pool, not destroyed, so its harness JobRegistry
    // survives — modelled by NOT clearing the run's jobs. (This is the whole point of the
    // mode: the re-dispatch must rely on a fresh dispatch epoch, not on container teardown.)
    if (this.pooledContainer) return
    const prefix = `fakejob:${handle.jobId}:`
    for (const id of this.jobs.keys()) if (id.startsWith(prefix)) this.jobs.delete(id)
  }

  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const job = this.jobs.get(handle.jobId)
    // An unknown job id (e.g. polled after a result was already recorded) is treated as
    // finished work; the engine clears the handle once a result lands, so it won't re-poll.
    if (!job) return { state: 'done', result: { output: '[async] done', model: 'fake' } }
    // Report a structured-cause failure (the deterministic analogue of the harness's failed
    // job view) so the engine's cause → AgentFailureKind mapping is exercised on both runtimes.
    if (this.pollFailKinds.has(job.context.agentKind)) {
      return {
        state: 'failed',
        error: 'Aborted: no agent activity for 600s (likely hung in agent phase)',
        failureCause: this.pollFailCause,
        detail: this.pollFailDetail,
      }
    }
    job.polled += 1
    // Stream the configured follow-up items on the FIRST running poll of a `coder` job —
    // the deterministic analogue of the harness tailing the Coder's sentinel file — so the
    // engine appends them to the step live and the Follow-up companion gate is exercised.
    const followUps =
      job.polled === 1 &&
      job.context.agentKind === 'coder' &&
      this.followUpItems &&
      this.followUpItems.length > 0
        ? this.followUpItems.map((f) => ({ kind: f.kind, title: f.title, detail: f.detail ?? '' }))
        : undefined
    if (job.polled < this.asyncPolls) {
      return {
        state: 'running',
        subtasks: { completed: job.polled, inProgress: 1, total: this.asyncPolls },
        // The deterministic analogue of the harness's live phase + the transport's
        // container id/url: the first running poll is still preparing the checkout
        // (`clone`), later polls are the agent making calls (`agent`). Lets the
        // conformance suite assert the engine folds these onto `step.container`
        // identically on both runtimes.
        phase: job.polled === 1 ? 'clone' : 'agent',
        container: {
          id: `fake-container-${handle.runId ?? handle.jobId}`,
          url: 'http://127.0.0.1:8080',
        },
        ...(followUps ? { followUps } : {}),
      }
    }
    // A pooled harness CACHES a finished job's result and replays it on every later poll /
    // re-attach — it never re-runs a job id it already completed. (The default per-run fake
    // recomputes via `run()`, which is how its existing tests advance a sequenced result on
    // re-dispatch; keep that path untouched.) Caching is what makes a re-dispatch with a
    // STALE job id replay the prior round — exactly the production bug the epoch fix prevents.
    if (this.pooledContainer) {
      if (!job.result) job.result = await this.run(job.context)
      return { state: 'done', result: job.result, ...(followUps ? { followUps } : {}) }
    }
    return {
      state: 'done',
      result: await this.run(job.context),
      ...(followUps ? { followUps } : {}),
    }
  }
}
