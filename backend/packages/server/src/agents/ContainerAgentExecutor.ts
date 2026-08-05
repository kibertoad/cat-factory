import {
  type AgentContextRecorder,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type HarnessCallMetric,
  type HarnessKind,
  type LlmTraceSink,
  type Logger,
  type ModelFlavor,
  type ModelRef,
  type OperationalMetrics,
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  type RunnerJobView,
  type RunnerJobResult,
  type StoreAgentContextGate,
  type SubscriptionQuotaTarget,
  type SubscriptionVendor,
  type TestSecretEntry,
  type ToolSecretResolver,
  type WebSearchAvailability,
} from '@cat-factory/kernel'
import {
  ConflictError,
  CredentialRequiredError,
  VCS_DOC_URLS,
  SUBSCRIPTION_VENDORS,
  isIndividualVendor,
  isSubscriptionVendor,
  runBestEffort,
} from '@cat-factory/kernel'
import { resolveAprioriWorkingBranch, resolveInstanceTypeId } from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  type AgentRouting,
  agentTuningFor,
  withComplexityAllowance,
  defaultAgentKindRegistry,
  isProxyableProvider,
  isReadOnlyAgentKind,
  webResearchGuidanceFor,
} from '@cat-factory/agents'
import { ModelRouter } from './ModelRouter.js'
import { buildContextFiles, renderSkillsForHarness } from './contextFiles.js'
import { resolveToolServers, type ResolvedToolServers } from './toolServers.js'
import { resolveBinaryGeneratorSecrets } from './binaryGenerators.js'
import { buildFailureMeta, buildRunningUpdate, toRunResult } from './containerAgentResult.js'
import { buildKindBody } from './jobBody.js'
import { containerJobLog } from './containerAgentLogging.js'
import { buildAgentContextRecord } from './agentContextRecord.js'
import { type RecordToolCalls, drainToolCalls } from './toolTrajectory.js'
import {
  UI_TESTER_AGENT_KIND,
  isTesterKind,
  type HarnessCallsRecordInput,
} from '@cat-factory/orchestration'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import type { ResolveRepoTargets } from './resolveRepoTarget.js'
import {
  buildCommonBody,
  buildRepoSpec,
  githubRepoOrigin,
  resolveAuxiliaryRepos,
} from './containerAgentBody.js'

// Re-exported for the composition root + tests that wire this executor by name.
export type { ResolveRunnerTransport }

// The repo-targeting vocabulary lives next door (a pure declaration block that was crowding
// this file against its size budget); re-exported here so every existing importer is unchanged.
import type {
  EnsureWorkBranch,
  JobPackageRegistrySpec,
  MintInstallationToken,
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from './repoTargeting.js'
import { jobTokenRepoIds } from './repoTargeting.js'
export type {
  EnsureWorkBranch,
  JobPackageRegistrySpec,
  MintInstallationToken,
  RepoOrigin,
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from './repoTargeting.js'
export { jobTokenRepoIds } from './repoTargeting.js'

/** A subscription token leased from the workspace's pool for a vendor. */
interface LeasedSubscriptionToken {
  tokenId: string
  secret: string
}

/** Lease the least-loaded subscription token for a vendor, or throw if none. */
type LeaseSubscriptionToken = (
  workspaceId: string,
  vendor: SubscriptionVendor,
) => Promise<LeasedSubscriptionToken>

/**
 * Lease the run-initiator's OWN activated personal credential for an individual-usage
 * vendor (Claude). Scoped to the run + user (not pooled); throws a
 * `CredentialRequiredError` when the run has no live activation (the user must re-enter
 * their password). Returns just the raw secret — no token id, since there is no pool
 * rotation/usage to attribute for a single-user credential.
 */
type LeasePersonalSubscriptionToken = (
  executionId: string,
  userId: string,
  vendor: SubscriptionVendor,
) => Promise<{ secret: string }>

/** Fold a finished subscription job's usage into the leased token + telemetry. */
type RecordSubscriptionUsage = (
  workspaceId: string,
  tokenId: string,
  usage: { inputTokens: number; outputTokens: number },
) => Promise<void>

/**
 * Fold a finished subscription job's usage into the MODELED quota-cycle counters
 * (usage-and-quota-tracking, Part B). Unlike {@link RecordSubscriptionUsage} this counts
 * BOTH pooled runs (scope = the leased token) and personal runs (scope = the initiator),
 * so it is keyed by a {@link SubscriptionQuotaTarget}, not a pooled token id.
 */
type RecordSubscriptionQuotaUsage = (
  target: SubscriptionQuotaTarget,
  usage: { inputTokens: number; outputTokens: number },
) => Promise<void>

/**
 * Record a finished subscription harness's per-call telemetry into `llm_call_metrics`
 * — the proxy-bypassing analogue of the per-call rows the LLM proxy writes for Pi. The
 * facade maps each harness call metric onto the observability sink. NOT gated on a
 * pooled token id (a personal/individual subscription leases no tokenId yet still
 * produces telemetry), unlike {@link RecordSubscriptionUsage}. The payload is the
 * orchestration recorder's own {@link HarnessCallsRecordInput}, so the two can't drift.
 */
type RecordHarnessCalls = (input: HarnessCallsRecordInput) => Promise<void>

/**
 * The repo spec every container job body carries: clone coordinates plus, for a
 * monorepo service, the subdirectory the harness should run the agent within. Built
 * here once so the (six) agent-kind job bodies can't drift on which repo fields they
 * forward.
 */
/**
 * The harness job id for one pipeline step: the run (execution) id plus the agent
 * kind. A run executes a sequence of steps that all share the one per-run container,
 * so each needs an id that is UNIQUE WITHIN THE RUN — the harness keys its per-kind
 * job registries by it, and two steps sharing an id alias there (the bug where an
 * `architect` /explore poll read back the `spec-writer`'s /spec result). The run is
 * addressed separately by the execution id (the {@link RunnerJobRef.runId}).
 *
 * A step RE-dispatched within the run (the Tester→Fixer loop's re-test, a fixer round, a
 * polling gate's helper retry, a container-eviction recovery) carries a non-zero
 * `dispatchEpoch` so each round gets a distinct id. The harness re-attaches to an EXISTING job
 * id rather than re-running (replay idempotency), and a container-reusing transport (a warm
 * local pool / a self-hosted runner pool) keeps that registry alive across rounds — reclaiming
 * a pooled member does NOT destroy it — so without the epoch a re-test would replay the first
 * round's stale report (the bug where the Tester appeared to "pass regardless" and never
 * actually re-ran), and an eviction recovery would land back on the job whose runner just died
 * rather than on a fresh one. Epoch 0 (a step dispatched once) keeps the original unsuffixed
 * id, so single-dispatch steps are unaffected. See {@link AgentRunContext.dispatchEpoch}.
 */
function stepJobId(executionId: string, agentKind: string, dispatchEpoch = 0): string {
  const base = `${executionId}-${agentKind}`
  return dispatchEpoch > 0 ? `${base}-${dispatchEpoch}` : base
}

/** The provider slug from a handle's `provider:model` string (fallback when the handle omits `provider`). */
function providerOf(model: string | undefined): string {
  if (!model) return 'unknown'
  const colon = model.indexOf(':')
  return colon > 0 ? model.slice(0, colon) : model
}

/**
 * The {@link RunnerJobRef} a job handle addresses: the run (for the per-run container)
 * plus the per-step job id. Falls back to the job id as the run id for a handle minted
 * before run ids were carried (or a single-job flow where the two coincide).
 */
function refForHandle(handle: AgentJobHandle): RunnerJobRef {
  return { runId: handle.runId ?? handle.jobId, jobId: handle.jobId }
}

export interface ContainerAgentExecutorDependencies {
  /** Resolve which runner backend (Cloudflare container or self-hosted pool) a job runs on. */
  resolveTransport: ResolveRunnerTransport
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref, under a preset's route order. */
  resolveBlockModel: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins no model. Optional: absent → the env routing for the kind is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Resolve which repo (and installation) a run targets. */
  resolveRepoTarget: ResolveRepoTarget
  /**
   * Resolve every repo a MULTI-REPO run touches — the task's own service plus each connected
   * involved service's repo, deduped (service-connections phase 3). Optional: absent ⇒ every
   * run is single-repo (the involved-services coding fan-out is off), the prior behaviour. Used
   * only when the block names involved services and the step is the coding implementer.
   */
  resolveRepoTargets?: ResolveRepoTargets
  /**
   * Resolve a workspace's owning account id, signed into the proxy session token so the
   * proxy can lease an account-scoped API key from the merged pool. Optional; absent ⇒
   * only the workspace + initiator scopes are leased.
   */
  resolveAccountId?: (workspaceId: string) => Promise<string | null | undefined>
  /** Mint a short-lived GitHub installation token for cloning + opening the PR. */
  mintInstallationToken: MintInstallationToken
  /**
   * Create the shared per-task work branch up front so every agent — including the
   * read-only design agents — operates on the same branch. Optional: absent (tests, no
   * GitHub) ⇒ read-only agents clone the base branch, the prior behaviour.
   */
  ensureWorkBranch?: EnsureWorkBranch
  /** Mints the signed LLM-proxy session token the container uses (Pi harness). */
  sessionService: ContainerSessionService
  /**
   * Lease a pooled subscription token for a vendor. Required for the Claude Code /
   * Codex subscription harnesses; absent ⇒ those harnesses are unavailable and a
   * subscription-only model fails loudly at dispatch.
   */
  leaseSubscriptionToken?: LeaseSubscriptionToken
  /**
   * Lease the run-initiator's personal (individual-usage) credential for a vendor like
   * Claude. Required to run an individual-usage model; absent ⇒ such models fail loudly
   * at dispatch (the per-user personal store isn't wired on this deployment).
   */
  leasePersonalSubscriptionToken?: LeasePersonalSubscriptionToken
  /** Attribute a finished subscription job's usage to its leased token (usage-aware rotation). */
  recordSubscriptionUsage?: RecordSubscriptionUsage
  /**
   * Fold a finished subscription harness's usage into the MODELED quota-cycle counters
   * (usage-and-quota-tracking, Part B). Counted for BOTH pooled runs (scope = the leased
   * token) and personal runs (scope = the initiator), so — unlike {@link recordSubscriptionUsage}
   * — it is NOT gated on a pooled token id. Best-effort; absent ⇒ no quota tracking.
   */
  recordSubscriptionQuotaUsage?: RecordSubscriptionQuotaUsage
  /**
   * Record a finished subscription harness's per-call telemetry into `llm_call_metrics`
   * (the proxy-bypassing analogue of the LLM proxy's per-call rows for Pi). Best-effort;
   * absent ⇒ no subscription-harness call telemetry is captured. See {@link RecordHarnessCalls}.
   */
  recordHarnessCalls?: RecordHarnessCalls
  /** The trajectory drain's two halves, both documented in `toolTrajectory.ts`. */
  recordToolCalls?: RecordToolCalls
  toolBodyGate?: StoreAgentContextGate
  /**
   * NATIVE LOCAL EXECUTION (local facade only, opt-in via `LOCAL_NATIVE_AGENTS`): when this
   * returns true for a resolved subscription harness + vendor, the job carries
   * `ambientAuth: true` INSTEAD of a leased credential — the harness (run as a host process)
   * drives the developer's OWN installed `claude` / `codex` CLI with its ambient login. No
   * token is leased and no personal-credential gate applies. It is passed the resolved
   * `vendor` precisely so it can refuse a non-native vendor that merely REUSES the
   * `claude-code` harness (GLM/Kimi/DeepSeek): those carry an Anthropic-compatible
   * `subscriptionBaseUrl`, which ambient auth would silently drop — running the step on the
   * developer's own Anthropic login instead of the pinned vendor. Default off everywhere
   * else, so the Cloudflare/Node leasing paths are untouched.
   */
  nativeAmbientAuth?: (harness: HarnessKind, vendor: SubscriptionVendor | undefined) => boolean
  /**
   * Whether the workspace has a pooled token for a vendor. Drives "subscriptions
   * always win" for POOLABLE vendors: a step pinned to a dual-mode model (Kimi/DeepSeek
   * with a Cloudflare base) is auto-routed to its subscription flavour when this returns
   * true.
   */
  hasSubscriptionToken?: (workspaceId: string, vendor: SubscriptionVendor) => Promise<boolean>
  /**
   * Whether the run-initiator has their OWN personal subscription for an INDIVIDUAL-usage
   * vendor. Individual vendors (e.g. GLM) are never pooled, so a dual-mode individual
   * model is auto-routed to the user's personal subscription when this returns true, and
   * otherwise stays on its Cloudflare base — so a subscriber runs GLM on their plan while
   * a non-subscriber on the same workspace falls back to Cloudflare GLM.
   */
  hasPersonalSubscription?: (userId: string, vendor: SubscriptionVendor) => Promise<boolean>
  /**
   * Public base URL of the facade's OpenAI-compatible LLM proxy, including the
   * `/v1` suffix — Pi posts to `${proxyBaseUrl}/chat/completions`.
   */
  proxyBaseUrl: string
  /** GitHub REST base for opening the PR (GitHub Enterprise / api.github.com). */
  githubApiBase?: string
  /**
   * Resolve a repo's clone URL + VCS provider. Defaults to GitHub; the local GitLab facade
   * injects a GitLab origin so containers clone the right host (gitlab.com or a self-managed
   * instance) and open merge requests. See {@link ResolveRepoOrigin}.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Resolve whether THIS run's account actually has a usable container web-search
   * upstream — and, if so, which provider serves it — so a coding/ci-fixer job is told to
   * point Pi's `web_search` tool at `${proxyBaseUrl}/web-search` ONLY when a search will
   * really work (keys are now per-account, resolved by the proxy off the run's account).
   * This keeps the advertised tool coupled to real availability — we don't offer
   * `web_search` to a run whose account has no keys (it would just fail/return nothing).
   * The resolved `{available, provider}` is also surfaced on the step (run details) via the
   * job handle. Absent / resolves `available:false` ⇒ container web search stays disabled.
   */
  resolveWebSearchAvailability?: (workspaceId: string) => Promise<WebSearchAvailability>
  /**
   * Resolve the workspace's private package-registry entries (npm private orgs, GitHub
   * Packages) for a container dispatch — decrypted host + scopes + token, rendered by
   * the harness into `~/.npmrc` before the agent runs so private dependencies resolve
   * on install. A resolution failure PROPAGATES (fails the dispatch): a workspace that
   * configured private registries must not silently run without them. Absent ⇒ no
   * registry auth is forwarded.
   */
  resolvePackageRegistries?: (workspaceId: string) => Promise<JobPackageRegistrySpec[]>
  /**
   * Resolve (DECRYPT) the sensitive test credentials configured for a run block's service frame
   * — the values the harness injects into the Tester container's environment OUT OF BAND. Called
   * only for the tester kinds. Wired from the facade's `TestSecretsService`; absent ⇒ no secrets
   * are injected. The returned values are put on a dedicated top-level body field (like
   * {@link JobPackageRegistrySpec}), which the agent-context snapshot allow-list OMITS — so a
   * value NEVER reaches a prompt or the telemetry snapshot, only the container environment.
   */
  resolveTestSecrets?: (workspaceId: string, blockId: string) => Promise<TestSecretEntry[]>
  /**
   * Resolve the credentials a TOOL SERVER (MCP) declared, for a kind that declares tool servers.
   * Both facades wire the deployment-environment resolver (`createEnvToolSecretResolver`) by
   * default, so a registered server works with no new storage; a deployment needing per-workspace
   * credentials implements the port itself. Absent ⇒ a server declaring a REQUIRED secret is
   * reported to the agent as unavailable rather than started without its credential.
   */
  resolveToolSecrets?: ToolSecretResolver
  /**
   * The facade logger, used for the best-effort degradations around agent capabilities (an
   * unregistered tool-server id, a credential lookup that failed). Absent ⇒ those are silent,
   * which is why every facade wires it.
   */
  logger?: Logger
  /**
   * Where this seam counts its operational faults (dispatch failures, container evictions).
   * Absent ⇒ the counts go nowhere, which is why every facade wires the app's collector.
   */
  operationalMetrics?: OperationalMetrics
  /**
   * Optional observability trace sink (e.g. Langfuse). When wired, each poll forwards
   * the container's drained tool spans as child spans under the run's trace — the same
   * sink the LLM proxy fans generations out to, so the trace tree is complete.
   * Best-effort and isolated: a sink failure never affects the job lifecycle.
   */
  llmTraceSink?: LlmTraceSink
  /**
   * Optional agent-context observability recorder. When wired, each dispatch records the
   * complete, redacted context provided to the agent (composed prompts + folded-in
   * fragment bodies + the files injected into the container). Best-effort and gated
   * inside the recorder (the deployment's prompt-recording switch + the workspace's
   * `storeAgentContext` setting); absent ⇒ nothing is captured.
   */
  agentContextObservability?: AgentContextRecorder
  /**
   * The app-owned agent-kind registry: threaded into the job-body builders so a
   * registered kind's system/user prompt, tuning and web-research hint resolve off the
   * SAME instance the rest of the app uses. Defaults to a fresh
   * {@link defaultAgentKindRegistry} (built-ins only) when a facade doesn't inject one.
   */
  agentKindRegistry?: AgentKindRegistry
}

/** Poll cadence for the non-durable `run()` fallback (the durable driver sleeps between polls itself). */
const RUN_POLL_INTERVAL_MS = 5_000

/**
 * An {@link AgentExecutor} that performs implementation work in a real sandbox:
 * it dispatches a per-run container running the Pi coding agent (a per-run
 * Cloudflare Container, or an org's self-hosted runner pool), feeds it the block's
 * composed prompt fragments as context, and has it clone the repo, implement the
 * block, push a branch and open a PR.
 *
 * Secrets never reach the container image. Provider keys stay in the backend; the
 * container reaches models only through the facade's LLM proxy using a
 * short-lived, model-locked session token, and clones/pushes with a short-lived
 * GitHub installation token — both handed over per job. Token usage is metered
 * by the proxy (the single metering point), so this executor reports no `usage`
 * to avoid double-counting in the execution engine.
 */
export class ContainerAgentExecutor implements AsyncAgentExecutor {
  /** Shared backend-polymorphic dispatch/poll/release plumbing (see RunnerJobClient). */
  private readonly jobs: RunnerJobClient

  /**
   * Job ids whose subscription usage has already been folded into the leased token.
   * `recordSubscriptionUsage` is additive, and the durable driver polls a finished
   * job inside a retriable step — so a poll that records usage and then throws (or
   * whose surrounding upsert/emit throws) would replay and double-count, unfairly
   * penalising the token in the usage-aware rotation. Recording once per job id
   * guards that. Best-effort + bounded: cleared wholesale past a cap, and it cannot
   * survive a cold isolate replay — a re-record there is the documented, benign
   * worst case (one extra job's tokens on one row), never silent over-counting.
   */
  private readonly recordedUsageJobs = new Set<string>()

  /**
   * Job ids whose per-call telemetry (`llm_call_metrics`) has already been recorded.
   * Separate from {@link recordedUsageJobs} because the two recorders are independently
   * wired and gated (telemetry records even for a personal subscription that leases no
   * pooled token id). Same replay-safety rationale + bound as the usage guard.
   */
  private readonly recordedCallMetricJobs = new Set<string>()

  /**
   * Per-job set of harness call `seq`s this process already recorded from the LIVE poll drain,
   * so the terminal write can skip them. Without it the terminal pass re-walks the job's WHOLE
   * list, and each already-stored call costs a chain-tip read plus an ignored insert — hundreds
   * of pointless round-trips at the end of a long run (and, on the Worker, hundreds of
   * subrequests inside one Workflow step).
   *
   * A set of the seqs actually recorded, not a high-water mark: a drained batch whose write
   * failed is swallowed (telemetry never fails a run), and those calls must still be picked up
   * by the terminal write rather than skipped as "already done". Dropped once the job records
   * terminally, and bounded by the same wholesale clear as {@link recordedCallMetricJobs} — a
   * lost entry only costs the redundant write it was there to avoid.
   */
  private readonly recordedCallSeqs = new Map<string, Set<number>>()

  /**
   * Job ids whose subscription usage has already been folded into the modeled quota
   * cycle. Separate from {@link recordedUsageJobs} because quota tracking counts BOTH
   * pooled and personal runs (not gated on a pooled token id). Same replay-safety
   * rationale + bound as the usage guard.
   */
  private readonly recordedQuotaJobs = new Set<string>()

  /** Resolves which model + subscription path a step runs on (routing policy). */
  private readonly modelRouter: ModelRouter

  /** The app-owned agent-kind registry the job-body builders read (custom-kind prompts/tuning). */
  private readonly agentKindRegistry: AgentKindRegistry

  constructor(private readonly deps: ContainerAgentExecutorDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
    this.agentKindRegistry = deps.agentKindRegistry ?? defaultAgentKindRegistry()
    this.modelRouter = new ModelRouter({
      agentRouting: deps.agentRouting,
      resolveBlockModel: deps.resolveBlockModel,
      resolveWorkspaceModelDefault: deps.resolveWorkspaceModelDefault,
      hasSubscriptionToken: deps.hasSubscriptionToken,
      hasPersonalSubscription: deps.hasPersonalSubscription,
    })
  }

  /** Repo-operating steps always run as polled async jobs (the coding can be long). */
  runsAsync(_context: AgentRunContext): boolean {
    return true
  }

  /**
   * Dispatch the implementation job to this run's container and return a handle.
   * Returns as soon as the job is accepted — the work continues in the container,
   * polled via {@link pollJob}. Idempotent: the harness re-attaches to a job
   * already running for `executionId`, so a replayed dispatch never duplicates work.
   */
  async startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    const { workspaceId, executionId } = this.requireIds(context)
    const { body, model, provider, kind, subscriptionTokenId, search, repoSummary, toolServers } =
      await this.buildJobBody(context)
    // The job's id is per-STEP (run id + agent kind), so sibling steps that share this
    // run's container never collide in the harness's per-kind job registries; the run
    // itself is addressed by the execution id, so its container is reclaimed as a unit.
    const jobId = body.jobId as string
    const ref: RunnerJobRef = { runId: executionId, jobId }
    const jobLog = containerJobLog(
      this.deps.logger,
      { workspaceId, executionId, jobId, agentKind: context.agentKind },
      this.deps.operationalMetrics,
    )
    try {
      await this.jobs.dispatch(workspaceId, ref, body, kind, this.dispatchOptions(context))
    } catch (error) {
      jobLog.dispatchFailed(error, { model, provider, kind })
      throw error
    }
    jobLog.dispatched({ model, provider, kind })
    // Capture the complete provided context for observability (best-effort, gated inside
    // the recorder). This is the only place the fully composed prompts + the injected
    // file bodies exist as one unit; proxy telemetry never sees the `.cat-context` files.
    // Awaited (not fire-and-forget): this runs AFTER the container job is already dispatched,
    // so it is off the container's critical path — the only thing it delays is the driver's
    // return of the handle, which then sleeps before its first poll regardless. A bare
    // `void promise` here would be silently dropped on the Worker: `startJob` runs inside a
    // Cloudflare Workflow step, and the isolate hibernates on the next durable `step.sleep`
    // before an un-awaited insert can land (see `http/waitUntil.ts`), so the snapshot would
    // stop recording on the primary runtime. Awaiting keeps it reliable on both facades; the
    // swallow guarantees a recorder failure still never breaks a dispatch.
    const recorder = this.deps.agentContextObservability
    if (recorder) {
      await runBestEffort(jobLog.logger, 'containerAgent.recordAgentContext', () =>
        recorder.record(
          buildAgentContextRecord(context, body, model, { workspaceId, executionId, toolServers }),
        ),
      )
    }
    // Carry the run id + workspace on the handle so the poll/stop site can re-address
    // the same per-run container (Cloudflare vs. self-hosted pool) given only the
    // handle; carry the leased subscription token id so a finished subscription job
    // can attribute its usage back to the right pool row.
    return {
      jobId,
      runId: executionId,
      model,
      provider,
      workspaceId,
      agentKind: context.agentKind,
      search,
      repo: repoSummary,
      ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
      ...(context.initiatedByUserId ? { initiatedByUserId: context.initiatedByUserId } : {}),
    }
  }

  /** Poll a dispatched job for its state, mapping the runner view into an update. */
  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const jobLog = containerJobLog(
      this.deps.logger,
      {
        workspaceId: handle.workspaceId,
        executionId: handle.runId,
        jobId: handle.jobId,
        agentKind: handle.agentKind,
      },
      this.deps.operationalMetrics,
    )
    // A poll that THROWS is as opaque as a dispatch that throws — the durable driver retries or
    // fails the step with a transport error and nothing records which job/backend it was against.
    // Logged and re-thrown; the lifecycle is unchanged.
    let view: RunnerJobView
    try {
      view = await this.jobs.poll(handle.workspaceId, refForHandle(handle))
    } catch (error) {
      jobLog.pollFailed(error)
      throw error
    }
    // The tool calls the harness drained on this poll, to the trace sink as child spans under
    // the RUN's trace (the run id is the trace id the LLM proxy's generations also use, so
    // per-step jobs share one trace) AND to the trajectory store as persisted rows. Both
    // isolated + best-effort: never affects the lifecycle. See `toolTrajectory.ts`.
    await drainToolCalls(this.deps, handle, view.spans, jobLog.logger)
    // Per-call telemetry the harness drained on this poll: record it NOW rather than waiting
    // for the terminal result. A run whose container dies mid-flight never produces one, so
    // batching to the end meant a killed run reported zero calls no matter how many tokens it
    // had spent — the exact run an operator most needs to see. Idempotent via the calls' `seq`,
    // so the terminal write below re-offers them harmlessly.
    await this.recordHarnessCalls(handle, view.callMetrics)
    // Forward-looking items the Coder streamed since the last poll (drain-on-read): surfaced
    // on both running and done so a final burst on the completion poll isn't lost. Normalise
    // the transport's optional `detail` to the engine's `StreamedFollowUp` shape.
    const streamedFollowUps = (view.followUps ?? []).map((f) => ({
      kind: f.kind,
      title: f.title,
      detail: f.detail ?? '',
      ...(f.suggestedAction ? { suggestedAction: f.suggestedAction } : {}),
    }))
    const followUps = streamedFollowUps.length > 0 ? { followUps: streamedFollowUps } : {}
    if (view.state === 'running') {
      jobLog.progress({ progress: view.progress })
      return buildRunningUpdate(view, followUps)
    }
    const failureMeta = buildFailureMeta(view)
    // Completed OR failed: a subscription harness attaches its per-call telemetry to
    // BOTH — a failed token-spending run (no changes / unusable output / unresolved
    // conflicts) is exactly what an operator needs to inspect — so record it before the
    // terminal returns below, on every terminal state.
    const result = view.result ?? {}
    await this.recordHarnessCallsOnce(handle, result)
    if (view.state === 'failed') {
      jobLog.settled('failed', { failureCause: view.failureCause, evicted: view.evicted })
      return { state: 'failed', error: view.error ?? 'Implementation job failed', ...failureMeta }
    }
    // Completed: a structured `error` (e.g. "no file changes") is still a failure. The harness
    // carries the cause on the view even for these clean-exit failures, so forward it too.
    if (result.error) {
      jobLog.settled('failed', { failureCause: view.failureCause, cleanExit: true })
      return { state: 'failed', error: `Implementation failed: ${result.error}`, ...failureMeta }
    }
    // Best-effort subscription usage attribution, split into their own methods so `pollJob` stays
    // within the complexity budget: the pool-token usage feedback + telemetry sink, and the
    // modeled quota-cycle counters. Both are idempotent (once per job id) and behaviour-neutral.
    await this.recordSubscriptionUsageOnce(handle, result)
    await this.recordSubscriptionQuotaUsageOnce(handle, result)
    const runResult = toRunResult(result, handle.agentKind)
    // The poll site can't resolve the model ref, but the dispatch captured its label
    // (`handle.model`, already used for `recordHarnessCalls`). Fold it onto the result so the
    // durable poll path's `recordStepResult` → `spend.record` records the REAL model instead of
    // 'unknown' (which `SpendService.parseModel` split into provider "unknown" / model ""). The
    // inline `run()` path folded this in itself; doing it here fixes both paths at the source.
    if (handle.model) runResult.model = handle.model
    // A subscription harness (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) bypasses
    // the LLM proxy, so its tokens aren't metered there. It's the ONLY container path that
    // emits per-call `callMetrics`, so their presence unambiguously marks a subscription
    // run: stamp its usage onto the result tagged `'subscription'` so the engine records it
    // in the durable usage ledger for the report — while the budget gate excludes it (a
    // quota plan costs nothing per token). Pi (proxy-metered) has no `callMetrics`, so its
    // usage stays off the result and the proxy remains its sole meter (no double-count).
    if (result.callMetrics && result.callMetrics.length > 0 && result.usage) {
      runResult.usage = result.usage
      runResult.usageBilling = 'subscription'
      runResult.usageVendor = handle.provider ?? providerOf(handle.model)
    }
    jobLog.settled('done', { model: handle.model })
    return { state: 'done', result: runResult, ...followUps }
  }

  /**
   * Record a batch of the subscription harness's per-call telemetry into `llm_call_metrics`
   * — the proxy-bypassing analogue of the rows the LLM proxy writes for Pi. NOT gated on a
   * pooled token id, so a personal (individual-usage) subscription run is observed too.
   *
   * Called from two places, deliberately: on EVERY poll for the calls the harness drained
   * since the last one (so a run's telemetry lands while it runs, and survives the run dying),
   * and once on the terminal state for the complete list (so a transport that forwards no live
   * drain, or a run whose last window never reached us, still records everything). The calls
   * carry a stable per-job `seq`, so the ids the recorder mints are the same in both channels
   * and the second write of an already-recorded call is a no-op at the store.
   *
   * Best-effort: an unwired recorder or an empty batch is a no-op, and a failure is swallowed
   * — telemetry is observability, never a reason to fail (or fail to complete) a run.
   */
  private async recordHarnessCalls(
    handle: AgentJobHandle,
    calls: HarnessCallMetric[] | undefined,
  ): Promise<void> {
    if (!handle.workspaceId || !calls || calls.length === 0 || !this.deps.recordHarnessCalls) {
      return
    }
    try {
      await this.deps.recordHarnessCalls({
        workspaceId: handle.workspaceId,
        executionId: handle.runId ?? null,
        agentKind: handle.agentKind ?? 'agent',
        provider: handle.provider ?? providerOf(handle.model),
        model: handle.model ?? '',
        jobId: handle.jobId,
        calls,
      })
      this.markCallSeqsRecorded(handle.jobId, calls)
    } catch {
      // Swallowed: telemetry is observability, never a reason to fail (or fail to
      // complete) a run.
    }
  }

  /**
   * Remember which `seq`s of a job landed, so {@link recordHarnessCallsOnce} can skip them.
   * Only called after the batch was written. A call with no `seq` (an older harness image,
   * which streams nothing) is not tracked: there the terminal list is the only channel.
   */
  private markCallSeqsRecorded(jobId: string, calls: HarnessCallMetric[]): void {
    const seqs = calls.map((c) => c.seq).filter((seq): seq is number => seq !== undefined)
    if (seqs.length === 0) return
    if (this.recordedCallSeqs.size >= 10_000) this.recordedCallSeqs.clear()
    const known = this.recordedCallSeqs.get(jobId) ?? new Set<number>()
    for (const seq of seqs) known.add(seq)
    this.recordedCallSeqs.set(jobId, known)
  }

  /**
   * The TERMINAL record of a job's full call list (see {@link recordHarnessCalls}). An
   * in-memory once-per-job guard skips the redundant walk within this process; the recorder
   * additionally mints deterministic per-call ids, so even a durable-driver replay in a fresh
   * isolate (empty guard) re-records idempotently rather than duplicating rows.
   *
   * Calls this process already recorded from the live drain are filtered out first: the store
   * would ignore them anyway, but only after a chain-tip read + an insert each, which on a long
   * run is hundreds of round-trips for no new rows. Anything the drain never delivered (a lost
   * poll response, a transport that forwards no drain, a replay in a fresh isolate) still goes
   * through.
   */
  private async recordHarnessCallsOnce(
    handle: AgentJobHandle,
    result: { callMetrics?: HarnessCallMetric[] },
  ): Promise<void> {
    if (this.recordedCallMetricJobs.has(handle.jobId)) return
    const recorded = this.recordedCallSeqs.get(handle.jobId)
    const pending = recorded
      ? result.callMetrics?.filter((c) => c.seq === undefined || !recorded.has(c.seq))
      : result.callMetrics
    await this.recordHarnessCalls(handle, pending)
    if (this.recordedCallMetricJobs.size >= 10_000) this.recordedCallMetricJobs.clear()
    this.recordedCallMetricJobs.add(handle.jobId)
    // The job is settled: its per-seq bookkeeping can go (the once-per-job guard covers a
    // repeat poll of the same terminal state from here on).
    this.recordedCallSeqs.delete(handle.jobId)
  }

  /**
   * Attribute a subscription harness's reported usage to its leased pool token
   * (usage-aware rotation) and the telemetry sink. Best-effort: a missing usage
   * signal or unconfigured recorder is a no-op; recorded at most once per job id
   * so a retried/replayed poll can't double-count (see `recordedUsageJobs`).
   */
  private async recordSubscriptionUsageOnce(
    handle: AgentJobHandle,
    result: RunnerJobResult,
  ): Promise<void> {
    if (
      handle.subscriptionTokenId &&
      handle.workspaceId &&
      result.usage &&
      this.deps.recordSubscriptionUsage &&
      !this.recordedUsageJobs.has(handle.jobId)
    ) {
      await this.deps.recordSubscriptionUsage(
        handle.workspaceId,
        handle.subscriptionTokenId,
        result.usage,
      )
      // Mark only AFTER a successful write: a failed record is left to retry rather
      // than silently dropped. Bound the set so a long-lived process can't grow it
      // unboundedly (clearing only risks a benign re-record on a later retry).
      if (this.recordedUsageJobs.size >= 10_000) this.recordedUsageJobs.clear()
      this.recordedUsageJobs.add(handle.jobId)
    }
  }

  /**
   * Fold the SAME subscription usage into the modeled quota-cycle counters (Part B), for
   * BOTH pooled and personal runs. A subscription run is the one reporting per-call
   * metrics (Pi is proxy-metered and has none), and the handle's provider is the vendor
   * slug. Scope = the leased pool token when present, else the run initiator (personal).
   * Best-effort, once per job id so a replayed poll can't double-count.
   */
  private async recordSubscriptionQuotaUsageOnce(
    handle: AgentJobHandle,
    result: RunnerJobResult,
  ): Promise<void> {
    const quotaVendor = handle.provider ?? providerOf(handle.model)
    if (
      result.callMetrics &&
      result.callMetrics.length > 0 &&
      result.usage &&
      this.deps.recordSubscriptionQuotaUsage &&
      isSubscriptionVendor(quotaVendor) &&
      !this.recordedQuotaJobs.has(handle.jobId)
    ) {
      const target: SubscriptionQuotaTarget | null = handle.subscriptionTokenId
        ? { scope: 'pooled', scopeId: handle.subscriptionTokenId, vendor: quotaVendor }
        : handle.initiatedByUserId
          ? { scope: 'user', scopeId: handle.initiatedByUserId, vendor: quotaVendor }
          : null
      if (target) {
        await this.deps.recordSubscriptionQuotaUsage(target, result.usage)
        if (this.recordedQuotaJobs.size >= 10_000) this.recordedQuotaJobs.clear()
        this.recordedQuotaJobs.add(handle.jobId)
      }
    }
  }

  /**
   * Stop a running job and reclaim its backing runner: resolve the same transport
   * the job dispatched to (by workspace) and `release` it — for the Cloudflare
   * backend this SIGKILLs the per-run container instead of letting it idle out.
   * Best-effort/idempotent: a transport without `release`, or an already-gone job,
   * is a no-op.
   */
  async stopJob(handle: AgentJobHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, refForHandle(handle))
  }

  /**
   * Synchronous convenience for non-durable callers (and tests): dispatch then
   * poll inline until the job finishes. The durable driver does not use this — it
   * calls {@link startJob}/{@link pollJob} so it can sleep durably between polls.
   */
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const handle = await this.startJob(context)
    for (;;) {
      const update = await this.pollJob(handle)
      if (update.state === 'done') {
        // `pollJob` already folds `handle.model` onto the result, so both paths carry it.
        return update.result
      }
      if (update.state === 'failed') throw new Error(update.error)
      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS))
    }
  }

  /**
   * Preview the model this job will run, without dispatching the container. The
   * proxyable-provider guard is deliberately left to `buildJobBody` (the dispatch
   * path) so an unservable model still fails loudly there; this only names it.
   */
  async resolveModel(context: AgentRunContext): Promise<string> {
    const ref = await this.modelRouter.resolveRef(context)
    return `${ref.provider}:${ref.model}`
  }

  /**
   * Whether this step will run on a flat-rate subscription (quota) model — it
   * resolves to a Claude Code / Codex harness (a subscription-only model, or a
   * dual-mode model auto-routed to its subscription flavour because the workspace has
   * a token). The engine's spend gate consults this so a quota run is not paused by
   * an exhausted monetary budget it never contributes to. Best-effort: without a
   * workspace id it reports false.
   */
  async isQuotaBased(context: AgentRunContext): Promise<boolean> {
    if (!context.workspaceId) return false
    const { ref } = await this.modelRouter.resolveEffectiveRef(context, context.workspaceId)
    return ref.harness === 'claude-code' || ref.harness === 'codex'
  }

  /**
   * Per-service provisioning hints for the dispatch: the cloud provider the service
   * runs on and the abstract instance size resolved to the target's concrete
   * instance-type id. Cloudflare maps the id to a Container instance type; a
   * self-hosted pool forwards it (with the provider) and provisions itself. Undefined
   * when the service pins no provider/size (the transport keeps its default).
   */
  private dispatchOptions(context: AgentRunContext): RunnerDispatchOptions | undefined {
    const provider = context.service?.cloudProvider
    const size = context.service?.instanceSize
    // The UI tester needs the heavier Playwright+browser image; every other kind uses
    // the default harness image (so the browser never bloats their cold-start).
    const image: 'ui' | undefined = context.agentKind === UI_TESTER_AGENT_KIND ? 'ui' : undefined
    if (!provider && !size && !image) return undefined
    return {
      ...(provider || size ? { instanceTypeId: resolveInstanceTypeId(provider, size) } : {}),
      ...(provider ? { provider } : {}),
      // Forward the abstract size too, so the local Docker/Podman backend can size
      // the per-job container (`--memory`/`--cpus`) without decoding the cloud id.
      ...(size ? { instanceSize: size } : {}),
      ...(image ? { image } : {}),
    }
  }

  /** Validate the ids every container job needs, narrowing them to non-empty strings. */
  private requireIds(context: AgentRunContext): {
    workspaceId: string
    executionId: string
    blockId: string
  } {
    const { workspaceId, executionId } = context
    const blockId = context.block.id
    if (!workspaceId || !executionId || !blockId) {
      throw new Error('ContainerAgentExecutor requires workspaceId, executionId and block.id')
    }
    return { workspaceId, executionId, blockId }
  }

  /**
   * Ensure the shared per-task work branch every agent in this pipeline operates on. By
   * default its name is deterministic from the block id (so a retry/replay/sweeper re-drive
   * always targets the SAME branch with no extra persistence), and once a PR is open it IS
   * this branch. Writers create it from base when absent; read-only agents only probe (a
   * missing branch ⇒ nothing to read yet ⇒ fall back to base), so a code-less pipeline never
   * orphans an empty ref. Once this block already has a PR, the branch IS that PR's branch,
   * so we skip the round-trip entirely.
   *
   * An apriori WORKING branch (an existing branch the task names as its starting point)
   * overrides the deterministic `cat-factory/<blockId>` work branch: the run builds inside
   * it, the PR opens from it, and the CI gate / merger ride it. Unlike the platform branch,
   * it must ALREADY exist — it is probed (never created), a missing branch fails the dispatch
   * loudly, and it may never be the repo's own base branch (the run would have nothing to
   * diff / no PR to open).
   */
  private async resolveWorkBranchReady(
    repo: RepoTarget,
    workBranch: string,
    aprioriWork: string | undefined,
    context: AgentRunContext,
  ): Promise<boolean> {
    if (context.block.pullRequest?.branch === workBranch) {
      return true
    }
    if (aprioriWork) {
      // Apriori working branch: probe only (create: false). It must pre-exist — a missing
      // branch is a loud dispatch failure, never a silent create off base (which would look
      // exactly like the agent ignoring the user's branch). When probing isn't wired
      // (tests / no GitHub), trust the caller and treat it as ready so the harness resumes it.
      if (this.deps.ensureWorkBranch) {
        const exists = await this.deps.ensureWorkBranch(repo, workBranch, { create: false })
        if (!exists) {
          throw new Error(
            `Apriori working branch '${workBranch}' does not exist on ` +
              `${repo.owner}/${repo.name}; push it before starting the run ` +
              `(the platform never creates an apriori branch).`,
          )
        }
      }
      return true
    }
    return this.deps.ensureWorkBranch
      ? await this.deps.ensureWorkBranch(repo, workBranch, {
          create: !isReadOnlyAgentKind(context.agentKind),
        })
      : false
  }

  /** Resolve tokens/prompts/target and assemble the harness job body for `context`. */
  private async buildJobBody(context: AgentRunContext): Promise<{
    body: Record<string, unknown>
    model: string
    provider: string
    kind: RunnerDispatchKind
    subscriptionTokenId?: string
    search: WebSearchAvailability
    /** The repo the job operates on, for the run diagnostics (owner/name/baseBranch + VCS provider). */
    repoSummary: { owner: string; name: string; baseBranch?: string; provider?: string }
    /**
     * The tool servers (MCP) resolved for this dispatch — the non-secret projection plus what
     * could not be wired. Returned so the caller can record it on the agent-context snapshot: the
     * decision is made HERE (it depends on the resolved harness) and the run context the engine
     * built does not carry it.
     */
    toolServers: ResolvedToolServers
  }> {
    const { workspaceId, executionId, blockId } = this.requireIds(context)
    // Per-STEP harness job id: unique within the run so this step's job never aliases
    // a sibling step's in the (shared) per-run container's job registries — and unique
    // per RE-dispatch round (the dispatch epoch) so a Tester re-test / fixer round never
    // re-attaches to the prior round's completed job on a container-reusing transport.
    const jobId = stepJobId(executionId, context.agentKind, context.dispatchEpoch)

    const { ref, harness, subscriptionVendor } = await this.resolveDispatchModel(
      context,
      workspaceId,
    )

    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!repo) {
      throw new ConflictError(
        `No connected GitHub repository found for workspace '${workspaceId}'. Connect the workspace to GitHub and link a repository to this service before running an agent (Settings → GitHub). See ${VCS_DOC_URLS.githubIntegration}.`,
        'github_not_connected',
      )
    }

    // The name of the shared per-task work branch (see `resolveWorkBranchReady`). Computed here
    // because the branch ensure needs the resolved name, and it is fanned out in the wave below.
    const aprioriWork = resolveAprioriWorkingBranch(context.aprioriBranches, repo.baseBranch)
    const workBranch = aprioriWork ?? `cat-factory/${blockId}`

    // These dispatch I/O steps are mutually independent once the repo target is resolved: the
    // work-branch ensure and the auxiliary-checkout resolution are repo-scoped, while auth
    // resolution, private-registry auth, tester secrets, and web-search availability are
    // workspace/block-scoped. Serialising them added ~6 round-trips of latency to EVERY step
    // dispatch (and every tester→fixer re-dispatch epoch), so fan them out in one wave instead.
    // `auth` (the proxy session token for Pi, or a leased subscription token for Claude Code /
    // Codex) is spread into every job body so the per-kind bodies can't drift on which auth
    // they forward.
    const [workBranchReady, aux, authResult, packageRegistries, resolvedTestSecrets, search] =
      await Promise.all([
        this.resolveWorkBranchReady(repo, workBranch, aprioriWork, context),
        // The auxiliary checkouts + their prompt sections: the multi-repo fan-out (coder /
        // ci-fixer), the conflict-resolver's peer targeting, the merger's combined-diff siblings,
        // and the read-only reference repos/branches. It rides the wave rather than the tail of
        // this method because the token mint below is narrowed to the repos it resolves.
        resolveAuxiliaryRepos(
          context,
          { workspaceId, blockId, repo, workBranch },
          this.deps,
          this.agentKindRegistry,
        ),
        this.resolveAuth(context, {
          harness,
          ref,
          subscriptionVendor,
          workspaceId,
          executionId,
        }),
        // Private-registry auth for the checkout's installs. Resolved per dispatch (like
        // ghToken) and spread into `common`, so every kind with a checkout gets it.
        this.deps.resolvePackageRegistries
          ? this.deps.resolvePackageRegistries(workspaceId)
          : Promise.resolve<JobPackageRegistrySpec[]>([]),
        // Sensitive test credentials for the tester kinds ONLY (mapped to env pairs below).
        isTesterKind(context.agentKind) && this.deps.resolveTestSecrets
          ? this.deps.resolveTestSecrets(workspaceId, blockId)
          : Promise.resolve<TestSecretEntry[]>([]),
        // The proxy-backed web-tools switch: web_search is offered only when the run's account
        // has a usable upstream, so the agent is never handed a tool that always fails.
        this.deps.resolveWebSearchAvailability
          ? this.deps.resolveWebSearchAvailability(workspaceId)
          : Promise.resolve<WebSearchAvailability>({ available: false, provider: null }),
      ])
    const { auth, subscriptionTokenId } = authResult

    // The clone/push credential, minted AFTER the wave because it is narrowed to the repos this
    // dispatch actually resolved (primary + fan-out peers + conflict/merger siblings + reference
    // repos) rather than to everything the installation covers. It is the one step that cannot
    // join the wave: the scope is what the wave produces. One round trip left the wave as the
    // auxiliary resolution entered it, so what changed is the ORDERING, not the work, and a warm
    // process still hits the App-token cache (keyed by scope: `installationTokenCache.ts`). A
    // PAT-backed facade ignores `repoIds` (`backend/docs/security-model.md`, Layer 3).
    const ghToken = await this.deps.mintInstallationToken(repo.installationId, {
      executionId,
      workspaceId,
      ...(context.initiatedByUserId ? { initiatedBy: context.initiatedByUserId } : {}),
      repoIds: jobTokenRepoIds(repo, aux.repoTargets),
    })

    // The fields EVERY harness job body carries, built once so the per-kind bodies
    // can't drift on which jobId/model/auth/repo/proxy fields they forward.
    // Linked-context bodies are materialised into the checkout (under CONTEXT_DIR) so a
    // container agent can read what it needs on demand; the prompt only lists them. The
    // harness can't reach Jira/GitHub itself, so everything is prepared here, up front.
    const { files: contextFiles } = buildContextFiles(context)
    // Files a registered kind's preOp prepared for the agent to read up front (e.g. the
    // `pr-reviewer` diff) — materialised into `.cat-context/` alongside the linked-doc files.
    // The preOp already bounded their size; the agent's own prompt names the paths, so they need
    // no linked-doc index entry (which is why they aren't fed through `buildContextFiles`).
    for (const injected of context.injectedContextFiles ?? [])
      contextFiles.push({
        path: injected.path,
        title: injected.path,
        url: '',
        content: injected.content,
      })
    // The dispatch's resolved skills (a `skill` step's pick and/or the running kind's declared
    // playbooks), rendered harness-aware: the payload travels as the top-level `skills` job-body
    // field (the harness materialises them — natively for claude-code, under
    // `.cat-context/skill/<name>/` for Pi/codex), and `skillSection` primes the prompt. Ambient
    // (native) claude-code takes the checkout path too — it has no isolated config home to install
    // into — so the prompt must carry the instructions rather than point at an install.
    const skillRender = renderSkillsForHarness(context.skills, harness, auth.ambientAuth === true)
    const tools = await this.resolveToolServersFor(context, {
      harness,
      ambientAuth: auth.ambientAuth === true,
      workspaceId,
      blockId,
    })
    const { testSecretEnv, generatorSecrets } = await this.resolveJobSecretEnv(context, {
      workspaceId,
      blockId,
      resolvedTestSecrets,
    })
    // Per-kind execution tuning (loosen-only progress-guard knobs) the harness applies
    // over its env/built-in defaults, so a kind whose normal pattern differs (e.g. a
    // research-heavy or retry-heavy kind) isn't killed mid-progress. Absent ⇒ defaults.
    const tuning = agentTuningFor(context.agentKind, this.agentKindRegistry)
    // Resolve the repo origin once so both the harness `RepoSpec` and the diagnostics repo
    // summary (returned below) agree on the VCS provider.
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    const common = buildCommonBody(
      context,
      {
        jobId,
        model: ref.model,
        auth,
        ghToken,
        packageRegistries,
        repoSpec: buildRepoSpec(repo, origin),
        contextFiles,
        skillsBody: skillRender.body,
        mcpServers: tools.mcpServers,
        generatorSecrets,
        // Extend the no-edit exploration allowance by the task-estimator's complexity when a
        // prior estimator step produced one (absent ⇒ the kind's tuning / harness default
        // stands — only absolute spiralling is caught). Loosen-only; see `withComplexityAllowance`.
        guardLimits: withComplexityAllowance(
          tuning?.guardLimits,
          context.block.estimate?.complexity,
        ),
      },
      this.deps,
    )
    // The prompt's linked-context summary index is rendered from the block's own docs/tasks: every
    // one of them was materialised, because `buildContextFiles` refuses a corpus that would not fit
    // rather than writing a prefix of it — so the index can never name a `.cat-context/` file the
    // agent won't find on disk.
    // Folds in the tool servers resolved above: they are a DISPATCH-level fact (the harness
    // decides what MCP is possible), so the engine cannot put them on the context — but the prompt
    // and the agent-context snapshot must both see exactly what was wired.
    const promptContext: AgentRunContext = {
      ...context,
      ...(tools.toolServers.length ? { toolServers: tools.toolServers } : {}),
      ...(tools.unavailableToolServers.length
        ? { unavailableToolServers: tools.unavailableToolServers }
        : {}),
    }
    // The proxy-backed web-tools nudge + switch, shared by the kinds that allow web access
    // (coder/mocker/ci-fixer/fixer/tester/read-only). `search` was resolved in the wave above;
    // the per-kind hint (coder/mocker/analysis/… and any custom container kind) is applied here.
    const webTools = {
      webToolsGuidance: webResearchGuidanceFor(context.agentKind, this.agentKindRegistry, {
        fetch: true,
      }),
      ...(search.available ? { webSearch: true } : {}),
    }

    const {
      peerRepos,
      multiRepoSection,
      repoSpecOverride,
      repoForKind,
      referenceRepos,
      referenceReposSection,
      referenceBranches,
      referenceBranchesSection,
    } = aux
    // The multi-repo fan-out re-roots the checkout at the repo root, and the conflict-resolver
    // swaps in a peer repo; either way only `common.repo` changes, so the override is applied
    // here rather than having the resolvers rebuild a `common` that did not exist when they ran.
    const commonForKind = repoSpecOverride ? { ...common, repo: repoSpecOverride } : common

    const { body, kind } = buildKindBody(
      promptContext,
      {
        common: commonForKind,
        webTools,
        repo: repoForKind,
        workBranch,
        workBranchReady,
        ...(testSecretEnv.length ? { testSecretEnv } : {}),
        ...(peerRepos ? { peerRepos } : {}),
        ...(multiRepoSection ? { multiRepoSection } : {}),
        ...(referenceRepos ? { referenceRepos } : {}),
        ...(referenceReposSection ? { referenceReposSection } : {}),
        ...(referenceBranches ? { referenceBranches } : {}),
        ...(referenceBranchesSection ? { referenceBranchesSection } : {}),
        ...(skillRender.section ? { skillSection: skillRender.section } : {}),
      },
      this.agentKindRegistry,
    )
    return {
      subscriptionTokenId,
      body,
      model: `${ref.provider}:${ref.model}`,
      provider: ref.provider,
      kind,
      search,
      repoSummary: {
        owner: repo.owner,
        name: repo.name,
        ...(repo.baseBranch ? { baseBranch: repo.baseBranch } : {}),
        provider: origin.provider,
      },
      toolServers: tools,
    }
  }

  /**
   * The two SECRET env channels a dispatch carries, resolved together because they are one
   * concern: `{ key, value }` pairs the harness turns into environment variables of this one
   * job's agent process, on dedicated top-level body fields the agent-context snapshot's
   * allow-list omits. Values NEVER reach a prompt or telemetry — the prompt sees only names.
   *
   * - `testSecretEnv`: the tester's sensitive credentials (already resolved by the caller); the
   *   prompt advertises their keys + descriptions through `context.testSecrets`.
   * - `generatorSecrets`: the credentials of this step's GENERATIVE BINARY INTEGRATIONS. The
   *   engine resolved WHICH ones onto the context; only their values are resolved here, where the
   *   facade's secret resolver lives. A key that does not resolve is simply absent — the agent's
   *   brief already tells it what an unset variable means, and refusing the dispatch would trade a
   *   named gap for a silent one.
   */
  private async resolveJobSecretEnv(
    context: AgentRunContext,
    args: {
      workspaceId: string
      blockId: string
      resolvedTestSecrets: { key: string; value: string }[]
    },
  ): Promise<{
    testSecretEnv: { key: string; value: string }[]
    generatorSecrets: { key: string; value: string }[]
  }> {
    const generatorSecrets = await resolveBinaryGeneratorSecrets({
      context,
      workspaceId: args.workspaceId,
      blockId: args.blockId,
      ...(this.deps.resolveToolSecrets ? { resolveToolSecrets: this.deps.resolveToolSecrets } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    })
    return {
      testSecretEnv: args.resolvedTestSecrets.map((e) => ({ key: e.key, value: e.value })),
      generatorSecrets,
    }
  }

  /**
   * Tool servers (MCP) the running kind declared: narrowed to what THIS harness/auth mode can
   * serve and whose credentials resolve, split into the prompt-facing projection (folded onto the
   * prompt context by the caller, so it reaches the prompt AND the agent-context snapshot) and the
   * job-body `mcpServers` field carrying the transports + their secrets. Never throws — an
   * unwirable server is reported to the agent as unavailable, not turned into a failed dispatch.
   *
   * A thin binding of the executor's injected deps onto the pure {@link resolveToolServers};
   * separated so `buildJobBody` stays under its complexity ceiling.
   */
  private resolveToolServersFor(
    context: AgentRunContext,
    args: { harness: HarnessKind; ambientAuth: boolean; workspaceId: string; blockId: string },
  ): Promise<ResolvedToolServers> {
    return resolveToolServers({
      context,
      agentKindRegistry: this.agentKindRegistry,
      harness: args.harness,
      ...(args.ambientAuth ? { ambientAuth: true } : {}),
      workspaceId: args.workspaceId,
      blockId: args.blockId,
      ...(this.deps.resolveToolSecrets ? { resolveToolSecrets: this.deps.resolveToolSecrets } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    })
  }

  /**
   * The model this dispatch runs and the harness that will run it, resolved together because
   * the second is a property of the first. "Subscriptions always win": a subscription-only model
   * carries its harness; a dual-mode GLM/Kimi step pinned to its Cloudflare base is auto-routed
   * to Claude Code when the workspace has a pooled token for the vendor. Shared with
   * `isQuotaBased` so the dispatch and the spend gate agree on what the step runs.
   *
   * The Pi harness reaches models through the LLM proxy, so its model must be a provider the
   * proxy can serve; locking it here stops the container choosing another. The subscription
   * harnesses (Claude Code / Codex) talk direct to the vendor with a pooled token, so the
   * proxyable guard does not apply to them.
   */
  private async resolveDispatchModel(
    context: AgentRunContext,
    workspaceId: string,
  ): Promise<{ ref: ModelRef; harness: HarnessKind; subscriptionVendor?: SubscriptionVendor }> {
    const { ref, subscriptionVendor } = await this.modelRouter.resolveEffectiveRef(
      context,
      workspaceId,
    )
    const harness: HarnessKind = ref.harness ?? 'pi'
    if (harness === 'pi' && !isProxyableProvider(ref.provider)) {
      throw new Error(
        `Container implementation needs a model the LLM proxy can serve ` +
          `(Workers AI, a direct OpenAI-compatible provider, or a local runner); ` +
          `'${ref.provider}' is not supported. Pick a Workers AI model, configure a ` +
          `provider key (QWEN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY), or add a local ` +
          `runner (Ollama / LM Studio / …) and pick that model.`,
      )
    }
    return { ref, harness, ...(subscriptionVendor ? { subscriptionVendor } : {}) }
  }

  /**
   * Resolve the per-job auth the harness carries: the proxy session token for Pi, or a
   * leased subscription token for Claude Code / Codex. Spread into every job body
   * (`common`) so the per-kind bodies can't drift on which auth they forward.
   */
  private async resolveAuth(
    context: AgentRunContext,
    args: {
      harness: HarnessKind
      ref: ModelRef
      subscriptionVendor: SubscriptionVendor | undefined
      workspaceId: string
      executionId: string
    },
  ): Promise<{ auth: Record<string, unknown>; subscriptionTokenId?: string }> {
    const { harness, ref, subscriptionVendor, workspaceId, executionId } = args
    if (harness === 'pi') {
      const accountId = this.deps.resolveAccountId
        ? await this.deps.resolveAccountId(workspaceId)
        : undefined
      const sessionToken = await this.deps.sessionService.mint({
        workspaceId,
        accountId: accountId ?? undefined,
        userId: context.initiatedByUserId,
        executionId,
        agentKind: context.agentKind,
        provider: ref.provider,
        model: ref.model,
      })
      // `proxyPhasePath` states what THIS backend serves: the phase-tagged completions route
      // the harness tags Pi's base URL with, so each call is attributed to the run phase that
      // spent it (`docs/initiatives/token-burn-instrumentation.md`). Unconditional — the route
      // is part of `llmProxyController`, so any backend running this code has it. It is the
      // harness that may be older or newer, and telling it what we serve is what keeps an
      // image pinned by a runner pool (or `LOCAL_HARNESS_IMAGE`) from posting every model call
      // to a 404. Same shape as `webSearch` below: the backend declares, the harness points.
      return {
        auth: {
          harness,
          proxyBaseUrl: this.deps.proxyBaseUrl,
          proxyPhasePath: true,
          sessionToken,
        },
      }
    }
    // Native local execution: the harness runs the developer's own CLI with its ambient
    // login, so we lease NOTHING and gate NOTHING — just flag ambient auth for the harness.
    // Passed the vendor so it can refuse a non-native vendor reusing the `claude-code`
    // harness (GLM/Kimi/DeepSeek), whose subscriptionBaseUrl ambient auth would drop.
    if (this.deps.nativeAmbientAuth?.(harness, subscriptionVendor)) {
      return { auth: { harness, ambientAuth: true } }
    }
    if (!subscriptionVendor) {
      throw new Error(
        `The ${harness} harness is not configured on this deployment; connect a ` +
          `subscription token or pick a different model.`,
      )
    }
    // Individual-usage vendors (Claude) are NOT pooled: lease the run-initiator's OWN
    // activated personal credential. Pooled vendors (GLM/Kimi/DeepSeek/Codex) lease
    // from the workspace pool. Either path hands the RAW credential to the resolved
    // runner transport (see the trust note below).
    let secret: string
    let subscriptionTokenId: string | undefined
    if (isIndividualVendor(subscriptionVendor)) {
      if (!this.deps.leasePersonalSubscriptionToken) {
        throw new Error(
          `Personal ${subscriptionVendor} subscriptions are not configured on this ` +
            `deployment (no ENCRYPTION_KEY); pick a different model.`,
        )
      }
      if (!context.initiatedByUserId) {
        // No identified initiator (auth-disabled/local dev): an individual-usage
        // credential is owned by a specific user and can't be resolved without one.
        throw new CredentialRequiredError(
          `Running a ${subscriptionVendor} model requires a signed-in user with a personal subscription.`,
          { vendor: subscriptionVendor, reason: 'no_subscription' },
        )
      }
      // Throws CredentialRequiredError(password_required) when the run has no live
      // activation — the dispatch path surfaces it as a clear, retriable failure.
      const leased = await this.deps.leasePersonalSubscriptionToken(
        executionId,
        context.initiatedByUserId,
        subscriptionVendor,
      )
      secret = leased.secret
    } else {
      if (!this.deps.leaseSubscriptionToken) {
        throw new Error(
          `The ${harness} harness is not configured on this deployment; connect a ` +
            `subscription token or pick a different model.`,
        )
      }
      const leased = await this.deps.leaseSubscriptionToken(workspaceId, subscriptionVendor)
      subscriptionTokenId = leased.tokenId
      secret = leased.secret
    }
    // SECURITY/TRUST: unlike the Pi harness (short-lived, model-locked proxy session
    // token) this hands the RAW, long-lived subscription credential — a Claude OAuth
    // token or a full ChatGPT auth.json — to the resolved runner transport. For the
    // Cloudflare backend that is an ephemeral, managed per-run container. For a
    // self-hosted runner pool it is the WORKSPACE'S OWN BYO infra (it connected the
    // pool), so the credential stays within the workspace's trust domain — but a
    // workspace should only point its subscription-harness steps at a runner pool it
    // operates, since the credential leaves the backend to reach it.
    // Non-Anthropic Claude-Code vendors (GLM/Kimi/DeepSeek) need their Anthropic-
    // compatible base URL; Anthropic itself uses the OAuth token against api.anthropic.com.
    const baseUrl = SUBSCRIPTION_VENDORS[subscriptionVendor].baseUrl
    return {
      auth: {
        harness,
        subscriptionToken: secret,
        ...(baseUrl ? { subscriptionBaseUrl: baseUrl } : {}),
      },
      ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
    }
  }
}
