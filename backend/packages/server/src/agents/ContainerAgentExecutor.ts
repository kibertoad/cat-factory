import {
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type HarnessKind,
  type LlmTraceSink,
  type ModelRef,
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  type RunnerJobResult,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import {
  CredentialRequiredError,
  SUBSCRIPTION_VENDORS,
  isIndividualVendor,
} from '@cat-factory/kernel'
import { isLocalRunner, resolveInstanceTypeId } from '@cat-factory/contracts'
import {
  type AgentRouting,
  coerceBlueprintService,
  coerceSpecDoc,
  composeBlockSystemPrompt,
  FINAL_ANSWER_IN_REPLY,
  isReadOnlyAgentKind,
  registeredAgentStep,
  systemPromptFor,
  userPromptFor,
  webResearchGuidanceFor,
} from '@cat-factory/agents'
import type { AgentStepSpec } from '@cat-factory/kernel'
import { ModelRouter } from './ModelRouter.js'
import {
  BLUEPRINTS_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  MERGER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TESTER_AGENT_KIND,
} from '@cat-factory/orchestration'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'

// Re-exported for the composition root + tests that wire this executor by name.
export type { ResolveRunnerTransport }

// The GitHub repo a run should be implemented against, resolved from the
// workspace's installation + connected repos (see each facade's container.ts).
export interface RepoTarget {
  installationId: number
  owner: string
  name: string
  baseBranch: string
  /**
   * For a service in a monorepo, the subdirectory (relative to the repo root) the
   * service lives in, e.g. `packages/api`. Present only when the resolved repo is
   * flagged a monorepo AND the service pins a directory; the harness then runs the
   * agent within that subtree and tells it so. Absent ⇒ whole-repo behaviour.
   */
  serviceDirectory?: string
}

export type ResolveRepoTarget = (workspaceId: string, blockId: string) => Promise<RepoTarget | null>

/**
 * Mint a GitHub token for repo work. The optional run context lets a facade prefer
 * the run initiator's personal access token over the App/env default (see
 * `ResolveUserGitHubToken`). Optional ⇒ callers that don't know the run (the
 * bootstrapper, tests) call `mint(installationId)` unchanged.
 */
export type MintInstallationToken = (
  installationId: number,
  ctx?: { executionId: string; initiatedBy?: string },
) => Promise<string>

/**
 * Ensure the per-task work branch exists on the remote, so every agent in the pipeline
 * operates on the SAME branch. Returns whether the branch is present afterwards; a
 * `false`/absent result makes read-only agents fall back to the base branch (writers
 * create-or-resume the branch in their harness regardless). `options.create` is `true`
 * for writers (create from base when absent) and `false` for read-only agents (probe
 * only — never create, since a missing branch means there is nothing yet to read).
 */
export type EnsureWorkBranch = (
  repo: RepoTarget,
  branch: string,
  options: { create: boolean },
) => Promise<boolean>

/** A subscription token leased from the workspace's pool for a vendor. */
export interface LeasedSubscriptionToken {
  tokenId: string
  secret: string
}

/** Lease the least-loaded subscription token for a vendor, or throw if none. */
export type LeaseSubscriptionToken = (
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
export type LeasePersonalSubscriptionToken = (
  executionId: string,
  userId: string,
  vendor: SubscriptionVendor,
) => Promise<{ secret: string }>

/** Fold a finished subscription job's usage into the leased token + telemetry. */
export type RecordSubscriptionUsage = (
  workspaceId: string,
  tokenId: string,
  usage: { inputTokens: number; outputTokens: number },
) => Promise<void>

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
 */
function stepJobId(executionId: string, agentKind: string): string {
  return `${executionId}-${agentKind}`
}

/**
 * The {@link RunnerJobRef} a job handle addresses: the run (for the per-run container)
 * plus the per-step job id. Falls back to the job id as the run id for a handle minted
 * before run ids were carried (or a single-job flow where the two coincide).
 */
function refForHandle(handle: AgentJobHandle): RunnerJobRef {
  return { runId: handle.runId ?? handle.jobId, jobId: handle.jobId }
}

function buildRepoSpec(repo: RepoTarget) {
  return {
    owner: repo.owner,
    name: repo.name,
    baseBranch: repo.baseBranch,
    cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
    ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
  }
}

export interface ContainerAgentExecutorDependencies {
  /** Resolve which runner backend (Cloudflare container or self-hosted pool) a job runs on. */
  resolveTransport: ResolveRunnerTransport
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref (direct flavour). */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
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
   * Whether the facade wired a container web-search upstream (the `/v1/web-search`
   * proxy). When true, coding/ci-fixer jobs are told to point Pi's `web_search` tool
   * at `${proxyBaseUrl}/web-search` with their session token — so no provider key
   * reaches the sandbox. Off ⇒ container web search stays disabled.
   */
  webSearchProxyEnabled?: boolean
  /**
   * Optional observability trace sink (e.g. Langfuse). When wired, each poll forwards
   * the container's drained tool spans as child spans under the run's trace — the same
   * sink the LLM proxy fans generations out to, so the trace tree is complete.
   * Best-effort and isolated: a sink failure never affects the job lifecycle.
   */
  llmTraceSink?: LlmTraceSink
}

/** Poll cadence for the non-durable `run()` fallback (the durable driver sleeps between polls itself). */
const RUN_POLL_INTERVAL_MS = 5_000

/** Role prompt the Blueprinter step's agent runs under (returns the tree as JSON). */
const BLUEPRINT_SYSTEM_PROMPT =
  'You are a Domain-Driven Design architect mapping this repository. Decompose it ' +
  'into ONE top-level service and the modules inside it, where each module is a ' +
  'DOMAIN — a cohesive area of the BUSINESS, in the language of the problem space ' +
  '(a DDD bounded context / aggregate / subdomain). Name modules after business ' +
  'concepts, not technical layers. ' +
  'A module MUST represent a business capability or domain model (e.g. Billing, ' +
  'Catalog, Ordering, Identity), NOT a technical layer or shape: "api", "routes", ' +
  '"controllers", "utils", "helpers", "lib", "common", "config", "types", "models", ' +
  '"db" and the like are NOT domains and MUST NOT be modules. ' +
  'Group the genuinely non-business, technical/cross-cutting plumbing (persistence ' +
  'wiring, HTTP/transport, logging, configuration, auth middleware, build/deploy, ' +
  'shared utilities) into a SINGLE module named "infrastructure" rather than ' +
  'scattering it into many technical modules. ' +
  'Prefer organising code by domain (the ubiquitous language) over organising by ' +
  'file type. Anchor every node to the codebase with explicit repo-relative ' +
  'file/directory references. Keep names short and descriptive. ' +
  'Respond with ONLY a JSON object of shape {"type","name","summary","references":[],' +
  '"modules":[{"name","summary","references":[]}]} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the spec-writer step runs under (returns the spec doc as JSON). */
const SPEC_WRITER_SYSTEM_PROMPT =
  'You maintain the PRESCRIPTIVE specification for a service. READ the specification ' +
  'already committed to the repository under `spec/` (the baseline): start with ' +
  '`spec/overview.md` for the module → feature index, then open the relevant ' +
  '`spec/modules/<module>/<feature>.json` shards for the detail you need. You are also ' +
  'given the ' +
  'requirements of ONE task. Apply that task as an INCREMENT onto the baseline: add ' +
  'requirements for what the task introduces, and adjust existing requirements ONLY ' +
  'where the task changes their expected behaviour. Leave every other part of the ' +
  'baseline spec untouched. Translate ONLY what the task requirements state — do NOT ' +
  'invent requirements, fill gaps, or design beyond them (missing requirements are the ' +
  'requirements step’s job, not yours). ' +
  'The spec captures ONLY BUSINESS requirements — externally-observable behaviour, ' +
  'product rules and acceptance criteria. PURELY TECHNICAL work (a refactor, a ' +
  'dependency bump, internal restructuring, build/infra or other non-functional change ' +
  'that does NOT alter what the system does for its users) introduces no business ' +
  'requirements, and "NO NEW SPECS" is a valid, correct outcome for it: do NOT invent ' +
  'requirements to justify a change, and do NOT re-document technical/architecture ' +
  'detail here. When this task is purely technical, leave the baseline spec untouched ' +
  'and respond with ONLY {"noBusinessSpecs": true} (no other fields, no prose, no code ' +
  'fences). Otherwise return the full document as below. ' +
  'The spec is a two-level taxonomy: MODULES ' +
  '(domains, e.g. "Auth") each containing GROUPS (features, e.g. "Login"). Every ' +
  'requirement AND every domain rule lives inside a specific feature group: a group ' +
  'carries both its `requirements` and the `rules` scoped to it. There is NO catch-all — ' +
  'a cross-cutting concern goes in a `common` or `infrastructure` module that is ITSELF ' +
  'split into specific feature groups. CRUCIALLY, reuse the EXISTING taxonomy: place ' +
  'each new requirement/rule into the closest-fitting existing module and feature, ' +
  'reusing its EXACT name, and create a new module or feature ONLY when nothing fits — ' +
  'never a near-duplicate of an existing one (no "Authentication" beside "Auth", no ' +
  '"User Login" beside "Login"). Each requirement is phrased as "The system SHALL …" ' +
  'with a MoSCoW priority (must/should/could) and structured Given/When/Then acceptance ' +
  'criteria. Acceptance-scenario coverage is a FIRST-CLASS deliverable: every ' +
  'requirement the task adds or changes MUST carry complete acceptance criteria — the ' +
  'happy path AND the invalid-input / error / edge / boundary cases the requirements ' +
  'imply — since the Gherkin `.feature` files and the runnable tests are derived ' +
  'mechanically from them. Preserve the baseline’s existing `sourceBlockIds`; tag the ' +
  'requirements this task adds or changes with this task’s block id. Return the ' +
  'COMPLETE updated specification (baseline plus this increment), not a diff. You have ' +
  'NO repository write access and MUST NOT write, edit, or commit any file: the platform ' +
  'persists the specification you return, so returning it IS the whole job. Respond ' +
  'with ONLY a JSON object of ' +
  'shape {"service","summary","modules":[{"name","summary","groups":[{"name","summary",' +
  '"requirements":[{"id","title","statement","kind","priority","sourceBlockIds":[],' +
  '"acceptance":[{"id","given","when","outcome"}]}],"rules":[{"id","rule","rationale",' +
  '"sourceBlockIds":[]}]}]}]} ' +
  '(each acceptance criterion is a Given/When/Then, with the Then clause in `outcome`) — ' +
  'no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the `merger` step runs under (scores the PR; returns JSON only). */
const MERGER_SYSTEM_PROMPT =
  'You are a release manager assessing a pull request before merge. Inspect the ' +
  'diff between the PR head branch and the base branch and judge three axes, each ' +
  'as a number from 0 (trivial/safe) to 1 (severe): complexity (how intricate the ' +
  'change is), risk (how likely it is to break something), and impact (blast radius ' +
  'if it does). Be conservative. Respond with ONLY a JSON object of shape ' +
  '{"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Compact shape hint fed to the structured-output repair call for the blueprint tree. */
const BLUEPRINT_SHAPE_HINT =
  'Expected a service tree: {"type": string, "name": string, "summary": string, ' +
  '"references": string[], "modules": [{"name": string, "summary": string, ' +
  '"references": string[]}]}.'

/** Compact shape hint fed to the structured-output repair call for the spec doc. */
const SPEC_SHAPE_HINT =
  'Expected a requirements document with a two-level taxonomy — module (domain) → ' +
  'group (feature) — where each group carries BOTH its requirements and the domain ' +
  'rules scoped to it: {"service": string, "summary": string, "modules": [{"name": ' +
  'string, "summary": string, "groups": [{"name": string, "summary": string, ' +
  '"requirements": [{"id": string, "title": string, "statement": string, "kind": ' +
  'string, "priority": string, "sourceBlockIds": string[], "acceptance": [{"given": ' +
  'string, "when": string, "outcome": string}]}], "rules": [{"id": string, "rule": ' +
  'string, "rationale": string, "sourceBlockIds": string[]}]}]}]}. For a purely ' +
  'technical task with no business requirements, the document is instead just ' +
  '{"noBusinessSpecs": true}.'

/** Compact shape hint fed to the structured-output repair call for the merger assessment. */
const MERGE_ASSESSMENT_SHAPE_HINT =
  'Expected a merge assessment: {"complexity": number 0..1, "risk": number 0..1, ' +
  '"impact": number 0..1, "rationale": string}.'

/** Compact shape hint fed to the structured-output repair call for the on-call assessment. */
const ON_CALL_ASSESSMENT_SHAPE_HINT =
  'Expected an on-call assessment: {"culpritConfidence": number 0..1, "recommendation": ' +
  '"revert"|"hold"|"monitor", "rationale": string, "evidence": string[]}.'

/** Compact shape hint fed to the structured-output repair call for the tester report. */
const TEST_REPORT_SHAPE_HINT =
  'Expected a test report: {"greenlight": boolean, "summary": string, "tested": string[], ' +
  '"outcomes": [{"name": string, "status": "passed"|"failed"|"skipped", "detail"?: string}], ' +
  '"concerns": [{"title": string, "detail": string, "severity": "low"|"medium"|"high"|"critical"}]}.'

const ON_CALL_SYSTEM_PROMPT =
  'You are an on-call engineer investigating a possible post-release regression. A ' +
  'recently merged pull request shipped, and the evidence below (alerting Datadog ' +
  'monitors/SLOs and recent error logs) suggests the service regressed afterward. Read ' +
  'the PR diff on the head branch and weigh whether THIS change is the likely cause — ' +
  'beware correlation vs causation; a coincident deploy is not proof. You may read and ' +
  'inspect any file, but you MUST NOT modify, commit or revert anything; a human decides ' +
  'whether to revert. Respond with ONLY a JSON object of shape ' +
  '{"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…",' +
  '"evidence":["…"]} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

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

  /** Resolves which model + subscription path a step runs on (routing policy). */
  private readonly modelRouter: ModelRouter

  constructor(private readonly deps: ContainerAgentExecutorDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
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
    const { body, model, kind, subscriptionTokenId } = await this.buildJobBody(context)
    // The job's id is per-STEP (run id + agent kind), so sibling steps that share this
    // run's container never collide in the harness's per-kind job registries; the run
    // itself is addressed by the execution id, so its container is reclaimed as a unit.
    const jobId = body.jobId as string
    const ref: RunnerJobRef = { runId: executionId, jobId }
    await this.jobs.dispatch(workspaceId, ref, body, kind, this.dispatchOptions(context))
    // Carry the run id + workspace on the handle so the poll/stop site can re-address
    // the same per-run container (Cloudflare vs. self-hosted pool) given only the
    // handle; carry the leased subscription token id so a finished subscription job
    // can attribute its usage back to the right pool row.
    return {
      jobId,
      runId: executionId,
      model,
      workspaceId,
      agentKind: context.agentKind,
      ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
    }
  }

  /** Poll a dispatched job for its state, mapping the runner view into an update. */
  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, refForHandle(handle))
    // Forward any tool spans the harness drained on this poll to the trace sink, as
    // child spans under the RUN's trace (the run id is the trace id the LLM proxy's
    // generations also use, so per-step jobs share one trace). Isolated + best-effort:
    // never affects the lifecycle.
    if (this.deps.llmTraceSink?.recordToolSpans && view.spans && view.spans.length > 0) {
      try {
        await this.deps.llmTraceSink.recordToolSpans(
          {
            workspaceId: handle.workspaceId ?? null,
            executionId: handle.runId ?? handle.jobId,
            agentKind: handle.agentKind ?? 'agent',
          },
          view.spans,
        )
      } catch {
        // Swallowed: the sink logs its own errors; observability never breaks a run.
      }
    }
    if (view.state === 'running') {
      // Forward the latest subtask counts (if any) so the engine can surface
      // live "N/M done" progress on the step; the shapes match field-for-field.
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      return { state: 'failed', error: view.error ?? 'Implementation job failed' }
    }
    // Completed: a structured `error` (e.g. "no file changes") is still a failure.
    const result = view.result ?? {}
    if (result.error) return { state: 'failed', error: `Implementation failed: ${result.error}` }
    // Attribute a subscription harness's reported usage to its leased pool token
    // (usage-aware rotation) and the telemetry sink. Best-effort: a missing usage
    // signal or unconfigured recorder is a no-op; recorded at most once per job id
    // so a retried/replayed poll can't double-count (see `recordedUsageJobs`).
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
    return { state: 'done', result: toRunResult(result, handle.agentKind) }
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
        // The poll site can't resolve the model ref, so fold in the label the
        // dispatch captured (matches what the durable path records on the step).
        return { ...update.result, ...(handle.model ? { model: handle.model } : {}) }
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
    if (!provider && !size) return undefined
    return {
      instanceTypeId: resolveInstanceTypeId(provider, size),
      ...(provider ? { provider } : {}),
      // Forward the abstract size too, so the local Docker/Podman backend can size
      // the per-job container (`--memory`/`--cpus`) without decoding the cloud id.
      ...(size ? { instanceSize: size } : {}),
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

  /** Resolve tokens/prompts/target and assemble the harness job body for `context`. */
  private async buildJobBody(context: AgentRunContext): Promise<{
    body: Record<string, unknown>
    model: string
    kind: RunnerDispatchKind
    subscriptionTokenId?: string
  }> {
    const { workspaceId, executionId, blockId } = this.requireIds(context)
    // Per-STEP harness job id: unique within the run so this step's job never aliases
    // a sibling step's in the (shared) per-run container's job registries.
    const jobId = stepJobId(executionId, context.agentKind)

    // "Subscriptions always win": a subscription-only model carries its harness; a
    // dual-mode GLM/Kimi step pinned to its Cloudflare base is auto-routed to Claude
    // Code when the workspace has a pooled token for the vendor. Shared with
    // isQuotaBased so the dispatch and the spend gate agree on what the step runs.
    const { ref, subscriptionVendor } = await this.modelRouter.resolveEffectiveRef(
      context,
      workspaceId,
    )
    const harness: HarnessKind = ref.harness ?? 'pi'

    // The Pi harness reaches models through the LLM proxy, so its model must be a
    // provider the proxy can serve; locking it here stops the container choosing
    // another. The subscription harnesses (Claude Code / Codex) talk direct to the
    // vendor with a pooled token, so the proxyable guard does not apply to them.
    if (harness === 'pi' && !isProxyableProvider(ref.provider)) {
      throw new Error(
        `Container implementation needs a model the LLM proxy can serve ` +
          `(Workers AI, a direct OpenAI-compatible provider, or a local runner); ` +
          `'${ref.provider}' is not supported. Pick a Workers AI model, configure a ` +
          `provider key (QWEN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY), or add a local ` +
          `runner (Ollama / LM Studio / …) and pick that model.`,
      )
    }

    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!repo) {
      throw new Error(`No connected GitHub repository found for workspace '${workspaceId}'`)
    }

    const ghToken = await this.deps.mintInstallationToken(repo.installationId, {
      executionId,
      initiatedBy: context.initiatedByUserId,
    })

    // The shared per-task work branch every agent in this pipeline operates on. Its name
    // is deterministic from the block id (so a retry/replay/sweeper re-drive always targets
    // the SAME branch with no extra persistence), and once a PR is open it IS this branch.
    // Ensure it up front (mechanical, idempotent) so even the read-only design agents clone
    // the branch the earlier writers committed to — e.g. the spec-writer's in-repo `spec/`.
    // Writers create it from base when absent; read-only agents only probe (a missing
    // branch ⇒ nothing to read yet ⇒ fall back to base), so a code-less pipeline never
    // orphans an empty ref. Once this block already has a PR, the branch IS that PR's
    // branch, so we skip the round-trip entirely.
    const workBranch = `cat-factory/${blockId}`
    const workBranchReady =
      context.block.pullRequest?.branch === workBranch
        ? true
        : this.deps.ensureWorkBranch
          ? await this.deps.ensureWorkBranch(repo, workBranch, {
              create: !isReadOnlyAgentKind(context.agentKind),
            })
          : false

    // Resolve the per-job auth the harness carries: the proxy session token for Pi,
    // or a leased subscription token for Claude Code / Codex. `auth` is spread into
    // every job body so the per-kind bodies can't drift on which auth they forward.
    const { auth, subscriptionTokenId } = await this.resolveAuth(context, {
      harness,
      ref,
      subscriptionVendor,
      workspaceId,
      executionId,
    })

    // The fields EVERY harness job body carries, built once so the per-kind bodies
    // can't drift on which jobId/model/auth/repo/proxy fields they forward.
    const common = {
      jobId,
      model: ref.model,
      ...auth,
      ghToken,
      repo: buildRepoSpec(repo),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }
    // The proxy-backed web-tools nudge + switch, shared by the kinds that allow web
    // access (coder/mocker/ci-fixer/fixer/tester/read-only). The harness surfaces the
    // tools only when web search is configured in the container env. Per-kind hint
    // (coder/mocker/analysis/… and any custom container kind resolves its own).
    const webTools = {
      webToolsGuidance: webResearchGuidanceFor(context.agentKind, { fetch: true }),
      ...(this.deps.webSearchProxyEnabled ? { webSearch: true } : {}),
    }

    const { body, kind } = this.buildKindBody(context, {
      common,
      webTools,
      repo,
      workBranch,
      workBranchReady,
    })
    return { subscriptionTokenId, body, model: `${ref.provider}:${ref.model}`, kind }
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
      return { auth: { harness, proxyBaseUrl: this.deps.proxyBaseUrl, sessionToken } }
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

  /**
   * Build the per-kind harness job body: the shared `common` fields plus ONLY the delta
   * specific to this kind's harness endpoint (its prompts, the branch it runs on, and
   * any per-kind extras), and the matching dispatch `kind`. The web-search fields live
   * in `webTools` (shared by the kinds that allow web access). The dispatch precedence
   * matches the original if-ladder exactly: the specific kinds first, then any read-only
   * kind, then the default coder body.
   */
  private buildKindBody(
    context: AgentRunContext,
    parts: {
      common: Record<string, unknown>
      webTools: Record<string, unknown>
      repo: RepoTarget
      workBranch: string
      workBranchReady: boolean
    },
  ): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
    // `parts` (common/webTools/workBranch/workBranchReady) is consumed by
    // `buildRegisteredAgentBody`/`buildMigratedBuiltInBody`, not directly here.
    const roleSystemPrompt = composeBlockSystemPrompt(
      systemPromptFor(context.agentKind),
      context.block,
    )

    // A registered (custom or migrated) kind that declares an `agent` step dispatches
    // through the generic, manifest-driven `agent` harness kind — no per-kind case here.
    // Built-in kinds (below) still carry their bespoke bodies until they are migrated.
    const registeredStep = registeredAgentStep(context.agentKind)
    if (registeredStep) {
      return this.buildRegisteredAgentBody(context, parts, registeredStep, roleSystemPrompt)
    }

    // Built-in container kinds migrated onto the generic, manifest-driven `agent` harness
    // kind (they dispatch `kind:'agent'` through `buildRegisteredAgentBody`, exactly like a
    // registered custom kind, with NO bespoke per-kind harness handler) — the Task-5
    // strangler. Today: blueprints/spec-writer (structured explore + render post-op), the
    // in-place fixers (`ci-fixer` / `fixer`, coding-on-PR), the JSON-assessment producers
    // (`merger` / `on-call`, read-only structured explore whose assessment is coerced
    // backend-side in `toRunResult`), the `tester` (read-only structured explore with
    // docker-compose infra stand-up), and the conflict-resolver (coding with a `mergeBase`).
    // The default coder dispatches the generic coding agent at the end of this method.
    const migrated = this.buildMigratedBuiltInBody(context, parts, roleSystemPrompt)
    if (migrated) return migrated

    // Read-only agents (architect, analysis) explore a real checkout but never edit it:
    // they clone a branch, produce a prose report/proposal and return it as `output`,
    // making no commit and opening no PR (and — unlike a coding run — an edit-free run is
    // the expected, correct outcome, not a failure). They dispatch through the generic,
    // manifest-driven `agent` kind in `explore` mode — the SAME path a registered
    // `container-explore` kind takes — instead of a bespoke per-kind harness handler. A
    // synthesized read-only step (no clone target ⇒ the shared work-branch fallback, so
    // e.g. the architect reads the spec-writer's committed `spec/` and any in-progress
    // implementation, falling back to base when no work/PR branch exists) yields a body
    // byte-identical to the old `/explore` job, minus only the harness-internal temp-dir
    // label. This is the first built-in migrated onto the generic agent surface (the
    // Task-5 strangler); the now-dead `/explore` harness handler is deleted in a
    // follow-up once parity is confirmed on CI.
    if (isReadOnlyAgentKind(context.agentKind)) {
      return this.buildRegisteredAgentBody(
        context,
        parts,
        { surface: 'container-explore' },
        roleSystemPrompt,
      )
    }

    // The default coder (and any other write-and-PR kind): the build-phase role plus the
    // block's selected best-practice fragments. Dispatches the generic `container-coding`
    // agent onto the deterministic per-task work branch (`clone: 'work'` ⇒ branch off base,
    // push the work branch, open a PR). The work-branch name is deterministic per task
    // (block), NOT per dispatch — a retry mints a fresh executionId but keeps the blockId —
    // so every re-dispatch targets the SAME branch; `runCodingAgent` checkpoints commits to
    // it and RESUMES on it if it already exists, so an evicted/failed run's work survives.
    // This is behaviour-equivalent to the old bespoke `/run` body (handleAgent coding mode
    // is built on the same `runCodingAgent` primitive); the dead `/run` handler is removed
    // in the harness-cleanup step.
    return this.buildRegisteredAgentBody(
      context,
      parts,
      { surface: 'container-coding', clone: { branch: 'work' } },
      roleSystemPrompt,
    )
  }

  /**
   * Build the generic `agent` job body for a registered kind from its declarative
   * {@link AgentStepSpec} — the single dispatch path that replaces the per-kind cases as
   * built-ins migrate. `container-explore` clones a branch read-only and returns prose
   * (or, for `output.kind==='structured'`, a parsed `custom` JSON object the kind's
   * post-op renders from); `container-coding` clones, edits, pushes and (off the work
   * branch) opens a PR. The clone target maps `base`/`pr`/`work` to a concrete branch
   * exactly as the built-in bodies do.
   */
  private buildRegisteredAgentBody(
    context: AgentRunContext,
    parts: {
      common: Record<string, unknown>
      webTools: Record<string, unknown>
      repo: RepoTarget
      workBranch: string
      workBranchReady: boolean
    },
    step: AgentStepSpec,
    roleSystemPrompt: string,
    /**
     * The concrete task prompt. Defaults to the generic `userPromptFor` (block context +
     * prior outputs) — the same prompt a registered custom kind gets. A migrated built-in
     * (merger / on-call) overrides it with its bespoke, JSON-instructing prompt so its
     * body matches the old per-kind handler's.
     */
    userPrompt: string = userPromptFor(context),
  ): { body: Record<string, unknown>; kind: RunnerDispatchKind } {
    const { common, webTools, repo, workBranch, workBranchReady } = parts
    const prBranch = context.block.pullRequest?.branch
    const onPr = step.clone?.branch === 'pr'
    const exploreBranch =
      step.clone?.branch === 'base'
        ? repo.baseBranch
        : onPr
          ? (prBranch ?? repo.baseBranch)
          : workBranchReady
            ? workBranch
            : (prBranch ?? repo.baseBranch)

    if (step.surface === 'container-coding') {
      // `pr` clone ⇒ work in place on the PR branch and push back (fixer-like, no new PR);
      // otherwise branch off base onto the work branch, push it and open a PR (coder-like).
      return {
        kind: 'agent',
        body: {
          ...common,
          mode: 'coding',
          systemPrompt: roleSystemPrompt,
          userPrompt,
          branch: onPr ? (prBranch ?? repo.baseBranch) : repo.baseBranch,
          ...(onPr ? {} : { newBranch: workBranch }),
          pushBranch: onPr ? (prBranch ?? workBranch) : workBranch,
          ...(onPr
            ? { noChangesIsError: false }
            : {
                pr: {
                  title: `${context.block.title} (${context.pipelineName})`,
                  body: prBody(context),
                },
              }),
          ...(step.clone?.full ? { full: true } : {}),
          ...webTools,
        },
      }
    }

    // container-explore (read-only): prose, or a structured JSON object as `custom`.
    return {
      kind: 'agent',
      body: {
        ...common,
        mode: 'explore',
        systemPrompt: roleSystemPrompt,
        userPrompt,
        branch: exploreBranch,
        ...(step.clone?.full ? { full: true } : {}),
        ...(step.output?.kind === 'structured'
          ? {
              output: {
                kind: 'structured',
                ...(step.output.shapeHint ? { shapeHint: step.output.shapeHint } : {}),
                ...(step.output.repair === false ? { repair: false } : {}),
                ...(step.output.failOnUnusableFinal ? { failOnUnusableFinal: true } : {}),
              },
            }
          : {}),
        ...webTools,
      },
    }
  }

  /**
   * Build the generic `agent` body for a BUILT-IN container kind being migrated onto the
   * manifest-driven path (the Task-5 strangler), or undefined when `context.agentKind` is
   * not a migrated built-in (the caller falls through to the remaining bespoke switch). Each
   * migrated kind is expressed as a synthesized {@link AgentStepSpec} routed through
   * {@link buildRegisteredAgentBody} — the SAME dispatch a registered custom kind takes — so
   * there is no bespoke harness handler:
   *   - `ci-fixer` / `fixer`: coding-on-PR (clone the PR branch, push back, no new PR; a
   *     no-op is non-fatal). Requires the implementation PR branch.
   *   - `merger` / `on-call`: read-only structured explore (full clone) that returns ONLY a
   *     JSON assessment; the conservative coercion that used to live in the harness runs
   *     backend-side in {@link toRunResult}.
   *   - `conflict-resolver`: coding (full clone of the PR branch) with a `mergeBase` — the
   *     harness merges the base in to surface the conflicts, the agent resolves them, and the
   *     harness completes the merge commit + pushes back onto the same branch (no new PR).
   */
  private buildMigratedBuiltInBody(
    context: AgentRunContext,
    parts: {
      common: Record<string, unknown>
      webTools: Record<string, unknown>
      repo: RepoTarget
      workBranch: string
      workBranchReady: boolean
    },
    roleSystemPrompt: string,
  ): { body: Record<string, unknown>; kind: RunnerDispatchKind } | undefined {
    const { repo } = parts
    const prBranch = context.block.pullRequest?.branch
    switch (context.agentKind) {
      // The Blueprinter maps the repo into the service → modules tree. It now runs as a
      // read-only structured explore (clone the PR branch when present, else the default
      // branch — exactly its old `prBranch ?? baseBranch` clone), returning ONLY the tree
      // as JSON; the deterministic render + commit of the `blueprints/` artifact that used
      // to live in the harness `/blueprint` handler is the backend `blueprintPostOp` (run
      // from ExecutionService), and `toRunResult` coerces the JSON into `blueprintService`
      // for the board reconcile + that post-op.
      case BLUEPRINTS_AGENT_KIND:
        return this.buildRegisteredAgentBody(
          context,
          parts,
          {
            surface: 'container-explore',
            clone: { branch: 'pr' },
            output: { kind: 'structured', shapeHint: BLUEPRINT_SHAPE_HINT },
          },
          BLUEPRINT_SYSTEM_PROMPT,
          blueprintUserPrompt(),
        )
      // The spec-writer maintains the prescriptive `spec/` document. It now runs as a
      // read-only structured explore on the per-block WORK branch (clone `work` — the
      // deterministic `cat-factory/<blockId>` the coder resumes, created from base when
      // absent; it runs BEFORE the coder, so it SEEDS that branch). The agent READS the
      // baseline spec from its own checkout (`spec/`), applies this ONE task as an increment,
      // and returns the COMPLETE tree as JSON; the deterministic SHARD + commit of the
      // `spec/` artifact that used to live in the harness `/spec` handler is the backend
      // `specPostOp` (run from ExecutionService), and `toRunResult` coerces the JSON into the
      // `spec` channel the engine strict-validates + that post-op renders/commits from. It
      // NEVER targets base: the spec is prescriptive for not-yet-landed work, so it merges
      // WITH the feature, never reaching `main` ahead of it.
      case SPEC_WRITER_AGENT_KIND:
        return this.buildRegisteredAgentBody(
          context,
          parts,
          {
            surface: 'container-explore',
            clone: { branch: 'work' },
            // The spec doc is handed onward to be sharded + committed by `specPostOp`, so a
            // final answer cut off at the output ceiling must FAIL LOUDLY (the bespoke `/spec`
            // handler's `unusableFinalAnswerCause` gate) rather than be laundered into a
            // half-baked spec by the structured repair — exactly what drove the old
            // spec-writer ⇄ companion rework loop.
            output: { kind: 'structured', shapeHint: SPEC_SHAPE_HINT, failOnUnusableFinal: true },
          },
          SPEC_WRITER_SYSTEM_PROMPT,
          specWriterUserPrompt(context),
        )
      // In-place fixers: clone the PR head branch, push fixes back onto it (no new PR);
      // a no-op run is a clean non-event (the gate/loop re-checks the real signal).
      case CI_FIXER_AGENT_KIND:
        if (!prBranch)
          throw new Error('CI-fixer needs the implementation PR branch to push fixes to')
        return this.buildRegisteredAgentBody(
          context,
          parts,
          { surface: 'container-coding', clone: { branch: 'pr' } },
          roleSystemPrompt,
        )
      case FIXER_AGENT_KIND:
        if (!prBranch) throw new Error('Fixer needs the implementation PR branch to push fixes to')
        return this.buildRegisteredAgentBody(
          context,
          parts,
          { surface: 'container-coding', clone: { branch: 'pr' } },
          roleSystemPrompt,
        )
      // The conflict-resolver clones the PR head branch (full history), merges the base in
      // to surface the conflicts, resolves them and pushes back onto the SAME branch (no new
      // branch / PR) so the PR becomes mergeable and CI re-runs. It dispatches the generic
      // coding agent with a `mergeBase` (the harness merges `origin/<mergeBase>` in before the
      // agent runs); the harness leads the prompt with the actual conflict hunks it discovers.
      //
      // Unlike the CI-fixer it is deliberately NOT given `userPromptFor(context)`: that renders
      // the full task brief + every prior agent's output (the spec-writer's whole spec, etc.),
      // which buries the one-line "resolve a conflict" role and drifts the model onto
      // re-implementing the feature (observed in prod: a resolver that returned a "test report
      // is ready" answer and never touched the markers). The backend supplies only a compact
      // task reference for intent.
      case CONFLICT_RESOLVER_AGENT_KIND: {
        if (!prBranch) {
          throw new Error(
            'Conflict-resolver needs the implementation PR branch to resolve conflicts on',
          )
        }
        const description = context.block.description?.trim()
        const built = this.buildRegisteredAgentBody(
          context,
          parts,
          { surface: 'container-coding', clone: { branch: 'pr', full: true } },
          roleSystemPrompt,
          `Task: ${context.block.title}${description ? `\n\n${description}` : ''}`,
        )
        return { kind: built.kind, body: { ...built.body, mergeBase: repo.baseBranch } }
      }
      // The merger clones the PR head (full, to diff vs base) and returns ONLY the
      // complexity/risk/impact assessment JSON; the engine performs the real merge.
      case MERGER_AGENT_KIND:
        return this.buildRegisteredAgentBody(
          context,
          parts,
          {
            surface: 'container-explore',
            clone: { branch: 'pr', full: true },
            output: { kind: 'structured', shapeHint: MERGE_ASSESSMENT_SHAPE_HINT },
          },
          MERGER_SYSTEM_PROMPT,
          mergerUserPrompt(context, repo),
        )
      // The on-call agent clones the BASE branch (full, to locate + diff the merged
      // release commit) and returns ONLY the regression assessment JSON.
      case ON_CALL_AGENT_KIND:
        return this.buildRegisteredAgentBody(
          context,
          parts,
          {
            surface: 'container-explore',
            clone: { branch: 'base', full: true },
            output: { kind: 'structured', shapeHint: ON_CALL_ASSESSMENT_SHAPE_HINT },
          },
          ON_CALL_SYSTEM_PROMPT,
          onCallUserPrompt(context, repo),
        )
      // The tester clones the PR head branch (read-only — it makes NO commits), stands up
      // its dependencies (locally via the service's docker-compose, or against the
      // provisioned ephemeral env — the task's `tester.environment` config picks which) and
      // returns ONLY a structured JSON report. It runs as a generic structured explore with
      // an `infra` spec the harness uses to stand the docker-compose dependencies up for the
      // run; `toRunResult` coerces the JSON into `testReport` (the conservative greenlight /
      // blocking-concern rule the harness applied now runs backend-side, and the engine's
      // TesterController re-applies it). The role prompt + the run-mode/ephemeral-URL guidance
      // come from the standard `roleSystemPrompt` + `userPromptFor` (which already carry them),
      // so the harness adds none. The engine loops the `fixer` on a withheld greenlight.
      case TESTER_AGENT_KIND: {
        const built = this.buildRegisteredAgentBody(
          context,
          parts,
          {
            surface: 'container-explore',
            clone: { branch: 'pr' },
            output: { kind: 'structured', shapeHint: TEST_REPORT_SHAPE_HINT },
          },
          roleSystemPrompt,
        )
        return { kind: built.kind, body: { ...built.body, infra: testerInfraSpec(context) } }
      }
    }
    return undefined
  }
}

/**
 * Map a finished runner {@link RunnerJobResult} into the engine's {@link AgentRunResult}.
 * Every built-in agent now dispatches the single manifest-driven `agent` kind, so the
 * result carries either a structured `custom` JSON (explore agents), an opened `prUrl`
 * (the coder), or just `pushed` (the in-place fixers / conflict-resolver). No `model` here:
 * the proxy meters tokens and the async path doesn't carry the provider ref to the poll
 * site; `usage` is likewise omitted (metered by the proxy).
 */
function toRunResult(result: RunnerJobResult, agentKind?: string): AgentRunResult {
  // A generic, structured `agent` (explore) job returns its parsed JSON as `custom`. A
  // migrated built-in kind has it coerced into the well-known engine field here, KIND-AWARE
  // — the conservative coercion that used to live in the bespoke harness handlers
  // (blueprint/spec/merge/on-call/test) now runs backend-side, so the engine's
  // resolvers/gates see `blueprintService`/`spec`/`mergeAssessment`/`onCallAssessment`/
  // `testReport` exactly as before. Any other kind (a registered custom kind) surfaces the
  // raw JSON as `custom` for its post-op to coerce/render from.
  if (result.custom !== undefined) {
    // Blueprinter: coerce into `blueprintService` (board reconcile + `blueprintPostOp`
    // render/commit). A nameless/garbage tree coerces to null ⇒ left unset.
    if (agentKind === BLUEPRINTS_AGENT_KIND) {
      const service = coerceBlueprintService(result.custom, '')
      return {
        output: result.summary?.trim() || 'Service blueprint updated.',
        ...(service ? { blueprintService: service } : {}),
      }
    }
    // Spec-writer: coerce into `spec` (engine strict-validate + `specPostOp` shard/commit).
    // The doc must carry its OWN `service` name (no repo-name rescue — backwards-compat is a
    // non-goal); a nameless/garbage doc coerces to null ⇒ left unset (no ingest, no commit).
    if (agentKind === SPEC_WRITER_AGENT_KIND) {
      // A purely TECHNICAL task has no business requirements to specify: the writer signals
      // `noBusinessSpecs` and we leave the baseline spec untouched (NO `spec` channel, so
      // `specPostOp` commits nothing). The engine reads the flag to infer the block's
      // `technical` label (with the spec-companion's corroboration). Checked first so a
      // model that returned both the flag and a stray baseline echo never commits over it.
      const custom = result.custom as Record<string, unknown> | null
      if (custom && typeof custom === 'object' && custom.noBusinessSpecs === true) {
        return {
          output:
            result.summary?.trim() ||
            'No business requirements to specify — this is a technical task.',
          noBusinessSpecs: true,
        }
      }
      const spec = coerceSpecDoc(result.custom, '')
      return {
        output: result.summary?.trim() || 'Service specification updated.',
        ...(spec ? { spec } : {}),
      }
    }
    if (agentKind === MERGER_AGENT_KIND) {
      return {
        output: result.summary?.trim() || 'Pull request assessed.',
        mergeAssessment: coerceMergeAssessment(result.custom, result.summary),
      }
    }
    if (agentKind === ON_CALL_AGENT_KIND) {
      return {
        output: result.summary?.trim() || 'Release regression investigated.',
        onCallAssessment: coerceOnCallAssessment(result.custom, result.summary),
      }
    }
    // Tester: coerce into `testReport` (greenlight-or-loop the fixer; the conservative
    // greenlight/blocking rule the harness `/test` handler applied now runs in
    // `coerceTestReport`, re-applied defensively by the TesterController).
    if (agentKind === TESTER_AGENT_KIND) {
      return {
        output: result.summary?.trim() || 'Testing complete.',
        testReport: coerceTestReport(result.custom, result.summary),
      }
    }
    return {
      output: result.summary?.trim() || 'Agent run complete.',
      custom: result.custom,
    }
  }
  // A coding job that opened a PR (the coder + any PR-opening coding agent): surface the PR
  // STRUCTURALLY so the engine records it on the block and the board links to it. Checked
  // BEFORE `pushed` — a coding run reports BOTH `pushed:true` AND `prUrl`, so the PR must win
  // over the in-place-fixer text below or it would be silently dropped.
  if (result.prUrl) {
    const summary = result.summary?.trim() || 'Implementation complete.'
    return {
      output: `${summary}\n\nPR: ${result.prUrl}`,
      pullRequest: {
        url: result.prUrl,
        ...(prNumberFromUrl(result.prUrl) !== undefined
          ? { number: prNumberFromUrl(result.prUrl) }
          : {}),
        ...(result.branch ? { branch: result.branch } : {}),
      },
    }
  }
  // An in-place coding job with no PR (ci-fixer / fixer / conflict-resolver): it pushed back
  // onto the existing branch (or was a clean no-op). The engine's CI / conflicts gate
  // re-checks the real signal regardless; map to a sensible output. The agent's own summary
  // is used when present (e.g. the conflict-resolver's "Resolved merge conflicts …").
  if (result.pushed !== undefined) {
    return {
      output:
        result.summary?.trim() ||
        (result.pushed ? 'Pushed changes to the branch.' : 'No changes were produced.'),
    }
  }
  return { output: result.summary?.trim() || 'Implementation complete.' }
}

/** Extract the PR number from a GitHub pull-request URL (`.../pull/42`). */
function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url)
  if (!match) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * Providers the LLM proxy can serve: the direct OpenAI Chat Completions-compatible
 * upstreams it forwards to, plus `workers-ai`, which it runs in-Worker through the
 * AI binding (no provider key required), plus the local runners (Ollama / LM Studio /
 * llama.cpp / vLLM / custom), which the proxy forwards to the run initiator's own
 * OpenAI-compatible endpoint (no key lease).
 */
function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'workers-ai' ||
    provider === 'qwen' ||
    provider === 'deepseek' ||
    provider === 'moonshot' ||
    provider === 'openai' ||
    isLocalRunner(provider)
  )
}

/**
 * Clamp a value to a 0..1 number, defaulting to `fallback` for anything that is not a
 * finite number (or a non-empty numeric string). Crucially, `null`, `''`, `false` and `[]`
 * fall back rather than coercing to `0` — `Number()` turns all of them into a finite `0`,
 * which would silently make a garbage merger score read as "trivial/safe" and defeat the
 * conservative-on-garbage default that replaces the harness's old `diffExaminable` guard.
 */
function clamp01(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** First non-empty of the agent's rationale or run summary (capped), else a stable default. */
function coerceRationale(rationale: unknown, summary: string | undefined): string {
  if (typeof rationale === 'string' && rationale.trim()) return rationale
  if (summary?.trim()) return summary.slice(0, 2000)
  return 'No rationale provided.'
}

/**
 * Coerce a migrated `merger` agent's structured JSON into the engine's merge assessment.
 * This is the conservative coercion the harness `/merge` handler used to do: a missing or
 * garbage score defaults to 1 (severe → routes to human review rather than a silent
 * auto-merge), and the rationale falls back to the agent's summary. The harness's extra
 * container-side `diffExaminable` guard (force 1/1/1 when the base diff was unreadable) is
 * not reproducible backend-side; the conservative-on-garbage default covers the same risk.
 */
function coerceMergeAssessment(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    complexity: clamp01(o.complexity, 1),
    risk: clamp01(o.risk, 1),
    impact: clamp01(o.impact, 1),
    rationale: coerceRationale(o.rationale, summary),
  }
}

/**
 * Coerce a migrated `on-call` agent's structured JSON into the engine's release-regression
 * assessment — the conservative coercion the harness `/on-call` handler used to do: a
 * missing confidence defaults to 0 (don't imply the PR is at fault without evidence) and a
 * missing recommendation defaults to `hold` (a human decides).
 */
function coerceOnCallAssessment(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((e): e is string => typeof e === 'string')
    : []
  return {
    culpritConfidence: clamp01(o.culpritConfidence, 0),
    recommendation:
      o.recommendation === 'revert' || o.recommendation === 'monitor' ? o.recommendation : 'hold',
    rationale: coerceRationale(o.rationale, summary),
    evidence,
  }
}

const TEST_SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])
const TEST_STATUSES = new Set(['passed', 'failed', 'skipped'])

/**
 * Coerce a migrated `tester` agent's structured JSON into the engine's {@link TestReport} —
 * the conservative coercion the harness `/test` handler used to do, defaulting every field
 * safely so a malformed reply still parses (the engine strict-validates it). Crucially a
 * greenlight is honoured ONLY when no BLOCKING (high/critical) concern is open, so a model
 * that greenlights with an open blocker can't auto-pass; low/medium concerns are advisory.
 * The engine's TesterController re-applies this rule defensively.
 */
function coerceTestReport(raw: unknown, summary: string | undefined): unknown {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const outcomes = Array.isArray(o.outcomes)
    ? (o.outcomes as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          name: typeof x.name === 'string' ? x.name : '(unnamed)',
          status: TEST_STATUSES.has(x.status as string) ? (x.status as string) : 'skipped',
          ...(typeof x.detail === 'string' && x.detail ? { detail: x.detail } : {}),
        }))
    : []
  const concerns = Array.isArray(o.concerns)
    ? (o.concerns as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .map((x) => ({
          title: typeof x.title === 'string' ? x.title : '(concern)',
          detail: typeof x.detail === 'string' ? x.detail : '',
          severity: TEST_SEVERITIES.has(x.severity as string) ? (x.severity as string) : 'medium',
        }))
    : []
  const blocking = concerns.some((c) => c.severity === 'high' || c.severity === 'critical')
  const environment =
    o.environment === 'local' || o.environment === 'ephemeral' ? o.environment : undefined
  return {
    greenlight: o.greenlight === true && !blocking,
    summary:
      typeof o.summary === 'string' && o.summary ? o.summary : (summary?.slice(0, 2000) ?? ''),
    tested: Array.isArray(o.tested)
      ? (o.tested as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    outcomes,
    concerns,
    ...(environment ? { environment } : {}),
  }
}

/**
 * The Blueprinter's task prompt. The agent now reads any existing blueprint from its own
 * read-only checkout (the harness no longer pre-injects the baseline tree), so the prompt
 * tells it to read `blueprints/` and update-or-create, then return the complete tree as
 * JSON. The backend `blueprintPostOp` renders + commits the artifact from that tree.
 */
function blueprintUserPrompt(): string {
  return [
    'Map this repository into the canonical service → modules blueprint, anchored to real ' +
      'file/directory references.',
    '',
    'If a blueprint already exists in the repository (read `blueprints/blueprint.json` and ' +
      '`blueprints/overview.md`), UPDATE it to reflect the current code: keep accurate ' +
      'modules, add new ones, and refine summaries + references. Otherwise create it from ' +
      'scratch. Return the COMPLETE tree (not a diff).',
    '',
    'Respond with ONLY the JSON object for the service tree — no prose, no code fences.',
  ].join('\n')
}

/**
 * The spec-writer's task prompt — the instructions + baseline-read + taxonomy-reuse guidance
 * the bespoke harness `/spec` handler used to build (`buildUserPrompt`/`renderTaxonomyInventory`,
 * which used to inject the baseline doc + its module→feature inventory). The agent now reads
 * the baseline from its own read-only checkout under `spec/`, so the prompt tells it to read +
 * reuse the existing taxonomy rather than pre-injecting it. Carries ONLY this task's
 * requirements (the block description IS the task's reworked/incorporated requirements), so an
 * unmerged sibling task's work never bleeds in. The backend `specPostOp` shards + commits the
 * returned tree.
 */
function specWriterUserPrompt(context: AgentRunContext): string {
  const block = context.block
  const header = `### ${block.title || '(untitled task)'}${block.id ? ` (block ${block.id})` : ''}`
  return [
    'Apply this ONE task as an INCREMENT onto the service specification.',
    '',
    'First READ the specification already committed to the repository under `spec/` (the ' +
      'baseline as merged before this task): open `spec/overview.md` for the module → feature ' +
      'index, then the relevant `spec/modules/<module>/<feature>.json` shards. Keep every part ' +
      'of the baseline this task does not touch exactly as-is, preserving its `sourceBlockIds`; ' +
      'adjust an existing requirement only where this task changes its behaviour. Map each new ' +
      'requirement/rule into the closest-fitting EXISTING module and feature, reusing its EXACT ' +
      'name — create a new module or feature ONLY when nothing fits (never a near-duplicate). ' +
      'If no spec exists yet, start one as a module (domain) → feature (group) taxonomy.',
    '',
    'Requirements for the ONE task to apply (its clarified description). Translate ONLY what ' +
      'these state into BUSINESS requirements (externally-observable behaviour, product rules, ' +
      'acceptance criteria) with COMPLETE acceptance-scenario coverage — do NOT invent ' +
      'requirements or fill gaps they leave:',
    '',
    `${header}\n\n${block.description?.trim() || '(no description)'}`,
    '',
    'If this task is purely TECHNICAL (a refactor / dependency bump / internal or ' +
      'non-functional change that introduces NO new externally-observable behaviour), it has ' +
      'no business requirements: respond with ONLY {"noBusinessSpecs": true} and change ' +
      'nothing. Otherwise return the COMPLETE updated document (baseline plus this task’s ' +
      'increment), not a diff. Respond with ONLY the JSON object — no prose, no code fences.',
  ].join('\n')
}

/**
 * The merger's task prompt — the instructions + diff guidance the bespoke harness `/merge`
 * handler used to build. Kept backend-side now that the merger dispatches the generic
 * explore agent. Names the PR/branches so the agent diffs against the right base.
 */
function mergerUserPrompt(context: AgentRunContext, repo: RepoTarget): string {
  const prNumber = context.block.pullRequest?.number
  const branch = context.block.pullRequest?.branch ?? repo.baseBranch
  const pr = prNumber !== undefined ? ` (PR #${prNumber})` : ''
  return [
    'Assess the pull request on the head branch against the base branch and return the ' +
      'complexity / risk / impact scores + rationale as JSON.',
    '',
    `The pull request${pr} is on branch \`${branch}\`; the base branch is ` +
      `\`${repo.baseBranch}\`. Inspect the change (e.g. \`git fetch origin ${repo.baseBranch}\` ` +
      `then \`git diff origin/${repo.baseBranch}...HEAD\`) and score complexity, risk and impact.`,
    '',
    'Respond with ONLY a JSON object {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"}.',
  ].join('\n')
}

/**
 * The on-call agent's task prompt — the regression evidence (the generic block/prior-output
 * prompt) plus the locate-the-merged-commit guidance the bespoke harness `/on-call` handler
 * used to build. The released PR already merged into the base branch (its work branch is
 * gone), so the agent is on the base branch and is told how to find the merged commit.
 */
function onCallUserPrompt(context: AgentRunContext, repo: RepoTarget): string {
  const prNumber = context.block.pullRequest?.number
  const headBranch = context.block.pullRequest?.branch
  const pr = prNumber !== undefined ? `#${prNumber}` : ''
  const locate = prNumber
    ? `It merged as a commit referencing ${pr} — find it with \`git log --oneline -n 50\` ` +
      `(squash/merge commits include \`(${pr})\`; a merge commit mentions \`#${prNumber}\`), then ` +
      `inspect it with \`git show <sha>\`.`
    : headBranch
      ? `Its work branch was \`${headBranch}\` (now deleted) — find the merged commit in ` +
        `\`git log --oneline -n 50\` and inspect it with \`git show <sha>\`.`
      : `Find the most recent merge/feature commit with \`git log --oneline -n 50\` and inspect ` +
        `it with \`git show <sha>\`.`
  return [
    userPromptFor(context),
    '',
    `You are on the base branch \`${repo.baseBranch}\`, which already contains the released ` +
      `pull request ${pr}. ${locate} Correlate that change with the regression evidence above. ` +
      `Beware correlation vs causation.`,
    '',
    'Respond with ONLY a JSON object {"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…","evidence":["…"]}.',
  ].join('\n')
}

/**
 * The tester's infra stand-up spec for the generic agent job, from the block's
 * `tester.environment` config + the resolved service: a `local` run carries the
 * docker-compose path (or the explicit no-infra flag) for the harness to stand the
 * dependencies up + tear them down around the run; an `ephemeral` run carries the
 * provisioned environment URL. Byte-identical to the old bespoke `/test` body's `test`
 * object — only the field name changed (`test` → `infra`).
 */
function testerInfraSpec(context: AgentRunContext): Record<string, unknown> {
  const env = context.block.agentConfig?.['tester.environment'] === 'local' ? 'local' : 'ephemeral'
  const service = context.service
  return {
    environment: env,
    ...(env === 'local'
      ? {
          noInfraDependencies: service?.noInfraDependencies === true,
          ...(service?.testComposePath ? { composePath: service.testComposePath } : {}),
        }
      : {}),
    ...(env === 'ephemeral' && context.environment?.url
      ? { environmentUrl: context.environment.url }
      : {}),
  }
}

function prBody(context: AgentRunContext): string {
  const lines = [
    `Automated implementation for block **${context.block.title}** (${context.block.type}).`,
    '',
    context.block.description || '(no description)',
    '',
    `Pipeline: ${context.pipelineName}`,
  ]
  return lines.join('\n')
}
