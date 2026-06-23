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
  composeBlockSystemPrompt,
  FINAL_ANSWER_IN_REPLY,
  isReadOnlyAgentKind,
  systemPromptFor,
  userPromptFor,
  webResearchGuidanceFor,
} from '@cat-factory/agents'
import { ModelRouter } from './ModelRouter.js'
import {
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

export type MintInstallationToken = (installationId: number) => Promise<string>

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
  'You maintain the PRESCRIPTIVE specification for a service. You are given the ' +
  'specification already committed to the repository (the baseline) and the ' +
  'requirements of ONE task. Apply that task as an INCREMENT onto the baseline: add ' +
  'requirements for what the task introduces, and adjust existing requirements ONLY ' +
  'where the task changes their expected behaviour. Leave every other part of the ' +
  'baseline spec untouched. Translate ONLY what the task requirements state — do NOT ' +
  'invent requirements, fill gaps, or design beyond them (missing requirements are the ' +
  'requirements step’s job, not yours). Requirements are grouped by capability, each ' +
  'phrased as "The system SHALL …" with a MoSCoW priority (must/should/could) and ' +
  'structured Given/When/Then acceptance criteria, plus cross-cutting domain rules / ' +
  'invariants. Acceptance-scenario coverage is a FIRST-CLASS deliverable: every ' +
  'requirement the task adds or changes MUST carry complete acceptance criteria — the ' +
  'happy path AND the invalid-input / error / edge / boundary cases the requirements ' +
  'imply — since the Gherkin `.feature` files and the runnable tests are derived ' +
  'mechanically from them. Preserve the baseline’s existing `sourceBlockIds`; tag the ' +
  'requirements this task adds or changes with this task’s block id. Return the ' +
  'COMPLETE updated specification (baseline plus this increment), not a diff. You have ' +
  'NO repository write access and MUST NOT write, edit, or commit any file: the platform ' +
  'persists the specification you return, so returning it IS the whole job. Respond ' +
  'with ONLY a JSON object of ' +
  'shape {"service","summary","groups":[{"name","summary","requirements":[{"id",' +
  '"title","statement","kind","priority","sourceBlockIds":[],"acceptance":[{"id",' +
  '"given","when","outcome"}]}]}],"rules":[{"id","rule","rationale","sourceBlockIds":[]}]} ' +
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
    return { state: 'done', result: toRunResult(result) }
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

    const ghToken = await this.deps.mintInstallationToken(repo.installationId)

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
    const { common, webTools, repo, workBranch, workBranchReady } = parts
    const prBranch = context.block.pullRequest?.branch
    const roleSystemPrompt = composeBlockSystemPrompt(
      systemPromptFor(context.agentKind),
      context.block,
    )

    switch (context.agentKind) {
      // The Blueprinter step commits the regenerated `blueprints/` folder onto an
      // existing branch (the earlier `coder` step's PR branch when present, else the
      // repo's default branch) — never a fresh branch / new PR. Its body targets the
      // harness `/blueprint` endpoint and returns the decomposition tree.
      case 'blueprints':
        return {
          kind: 'blueprint',
          body: {
            ...common,
            systemPrompt: BLUEPRINT_SYSTEM_PROMPT,
            instructions:
              'Map (or update) this repository into the canonical service → modules ' +
              'blueprint, anchored to real file/directory references.',
            branch: prBranch ?? repo.baseBranch,
            mode: prBranch ? 'update' : 'create',
          },
        }

      // The spec-writer commits the regenerated `spec/` folder onto the implementation
      // branch — the earlier `coder` step's PR branch when present, else the
      // deterministic `cat-factory/<blockId>` the coder WILL resume (created from base if
      // absent). It NEVER targets the base branch: the spec is a prescriptive document
      // for not-yet-landed work, so — like the feature-time blueprint — it must merge
      // together WITH the feature, never reach `main` ahead of it. Its body carries ONLY
      // this task's requirements (the block description already IS the task's reworked /
      // incorporated requirements): the writer reads the baseline spec committed on the
      // branch and applies this task as an increment, so an unmerged sibling task's work
      // never bleeds in. Targets the harness `/spec` endpoint.
      case SPEC_WRITER_AGENT_KIND:
        return {
          kind: 'spec',
          body: {
            ...common,
            systemPrompt: SPEC_WRITER_SYSTEM_PROMPT,
            instructions:
              'Apply this task as an increment onto the specification already committed to ' +
              'the repository: add requirements for what it introduces, adjust existing ' +
              'ones only where it changes their behaviour, and leave the rest untouched. ' +
              'Every requirement you add or change must carry COMPLETE acceptance-scenario ' +
              'coverage. Return the complete updated specification.',
            branch: workBranch,
            task: {
              id: context.block.id,
              title: context.block.title,
              description: context.block.description,
            },
          },
        }

      // The CI-fixer clones the PR head branch, runs the failing build/tests, fixes
      // them and pushes back to the SAME branch (no new branch / PR) so CI re-runs.
      case CI_FIXER_AGENT_KIND:
        if (!prBranch) {
          throw new Error('CI-fixer needs the implementation PR branch to push fixes to')
        }
        return {
          kind: 'ci-fix',
          body: {
            ...common,
            systemPrompt: roleSystemPrompt,
            userPrompt: userPromptFor(context),
            branch: prBranch,
            ...webTools,
          },
        }

      // The conflict-resolver clones the PR head branch, merges the base in, resolves
      // the conflicts and pushes back to the SAME branch (no new branch / PR) so the
      // PR becomes mergeable and CI re-runs. Mirrors the CI-fixer's body.
      case CONFLICT_RESOLVER_AGENT_KIND:
        if (!prBranch) {
          throw new Error(
            'Conflict-resolver needs the implementation PR branch to resolve conflicts on',
          )
        }
        return {
          kind: 'resolve-conflicts',
          body: {
            ...common,
            systemPrompt: roleSystemPrompt,
            userPrompt: userPromptFor(context),
            branch: prBranch,
          },
        }

      // The merger clones the PR head branch to assess the diff vs base; it makes no
      // commits (the engine performs the real merge through the GitHub API on its
      // verdict). Returns ONLY a JSON assessment, mapped to `mergeAssessment`.
      case MERGER_AGENT_KIND:
        return {
          kind: 'merge',
          body: {
            ...common,
            systemPrompt: MERGER_SYSTEM_PROMPT,
            instructions:
              'Assess the pull request on the head branch against the base branch and ' +
              'return the complexity / risk / impact scores + rationale as JSON.',
            branch: prBranch ?? repo.baseBranch,
            ...(context.block.pullRequest?.number !== undefined
              ? { prNumber: context.block.pullRequest.number }
              : {}),
          },
        }

      // The on-call agent investigates a post-release regression: it correlates the
      // RELEASED change with the Datadog regression evidence (handed in via priorOutputs)
      // and returns ONLY a JSON assessment — it makes NO commits and reverts nothing (the
      // engine raises a notification for a human). The gate only escalates AFTER the merger
      // step, which merges the PR and DELETES the work branch, so the head branch is gone by
      // now — clone the BASE branch (which always exists and contains the merged change) and
      // hand the agent the PR number + the now-historical head branch name so it can locate
      // the merged commit in history. Targets the harness `/on-call` endpoint.
      case ON_CALL_AGENT_KIND:
        return {
          kind: 'on-call',
          body: {
            ...common,
            systemPrompt: ON_CALL_SYSTEM_PROMPT,
            userPrompt: userPromptFor(context),
            branch: repo.baseBranch,
            ...(context.block.pullRequest?.branch
              ? { headBranch: context.block.pullRequest.branch }
              : {}),
            ...(context.block.pullRequest?.number !== undefined
              ? { prNumber: context.block.pullRequest.number }
              : {}),
          },
        }

      // The tester clones the PR head branch, stands up its dependencies (locally via
      // the service's docker-compose, or against the provisioned ephemeral env — the
      // task's `tester.environment` config picks which), runs the suite and returns a
      // structured report. It makes NO commits (the engine loops the `fixer` on a
      // withheld greenlight). Targets the harness `/test` endpoint; mapped to `testReport`.
      case TESTER_AGENT_KIND: {
        const env =
          context.block.agentConfig?.['tester.environment'] === 'local' ? 'local' : 'ephemeral'
        const service = context.service
        return {
          kind: 'test',
          body: {
            ...common,
            systemPrompt: roleSystemPrompt,
            userPrompt: userPromptFor(context),
            branch: prBranch ?? repo.baseBranch,
            // How the Tester stands up its dependencies for this run.
            test: {
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
            },
            ...webTools,
          },
        }
      }

      // The fixer clones the PR head branch, applies fixes for the concerns in the
      // Tester's report (folded into the user prompt via the prior `tester` output) and
      // pushes back to the SAME branch (no new branch / PR) so the Tester can re-run.
      // Mirrors the CI-fixer's body; targets the harness `/fix-tests` endpoint.
      case FIXER_AGENT_KIND:
        if (!prBranch) {
          throw new Error('Fixer needs the implementation PR branch to push fixes to')
        }
        return {
          kind: 'fix-tests',
          body: {
            ...common,
            systemPrompt: roleSystemPrompt,
            userPrompt: userPromptFor(context),
            branch: prBranch,
            ...webTools,
          },
        }
    }

    // Read-only agents (architect, analysis) explore a real checkout but never edit
    // it: they clone a branch, produce a prose report/proposal and return it as
    // `output`. They target the harness `/explore` endpoint — which opens no branch,
    // makes no commit, opens no PR, and (unlike `/run`) does NOT treat an edit-free
    // run as a failure. One shared body for every read-only kind. They explore the
    // shared work branch when it exists (so e.g. the architect reads the spec-writer's
    // committed `spec/` and any in-progress implementation), falling back to base when
    // it could not be ensured (no GitHub wired) and no PR branch exists yet.
    if (isReadOnlyAgentKind(context.agentKind)) {
      return {
        kind: 'explore',
        body: {
          ...common,
          kind: context.agentKind,
          systemPrompt: roleSystemPrompt,
          userPrompt: userPromptFor(context),
          branch: workBranchReady ? workBranch : (prBranch ?? repo.baseBranch),
          ...webTools,
        },
      }
    }

    // The default coder (and any other write-and-PR kind): the build-phase role plus
    // the block's selected best-practice fragments, exactly as the inline executor
    // composes (engine-resolved tenant catalog when present, else the manual ids).
    // `headBranch` is deterministic per task (block), NOT per dispatch: a retry mints a
    // fresh executionId but keeps the blockId, and a sweeper re-drive keeps both — so a
    // stable name means every re-dispatch of this task targets the SAME branch. The
    // harness checkpoints commits to it during the run and RESUMES on it if it already
    // exists, so an evicted/failed run's work survives and a retry continues on top of
    // it rather than starting over.
    return {
      kind: 'run',
      body: {
        ...common,
        systemPrompt: roleSystemPrompt,
        userPrompt: userPromptFor(context),
        headBranch: workBranch,
        pr: {
          title: `${context.block.title} (${context.pipelineName})`,
          body: prBody(context),
        },
        ...webTools,
      },
    }
  }
}

/** Map a finished runner {@link RunnerJobResult} into the engine's {@link AgentRunResult}. */
function toRunResult(result: RunnerJobResult): AgentRunResult {
  // A Blueprinter job carries a decomposition tree instead of a PR; surface it so
  // the engine can strictly validate + reconcile it onto the board.
  if (result.service !== undefined) {
    return {
      output: result.summary?.trim() || 'Service blueprint updated.',
      blueprintService: result.service,
    }
  }
  // A spec-writer job carries a prescriptive specification doc instead of a PR;
  // surface it so the engine can strictly validate + persist/surface it.
  if (result.spec !== undefined) {
    return {
      output: result.summary?.trim() || 'Service specification updated.',
      spec: result.spec,
    }
  }
  // A `merger` job carries a PR assessment instead of a PR; surface it so the
  // engine can compare it to the task's thresholds and merge-or-notify.
  if (result.assessment !== undefined) {
    return {
      output: result.summary?.trim() || 'Pull request assessed.',
      mergeAssessment: result.assessment,
    }
  }
  // An `on-call` job carries a release-regression assessment; surface it so the engine
  // can raise the `release_regression` notification + enrich any open incident.
  if (result.onCallAssessment !== undefined) {
    return {
      output: result.summary?.trim() || 'Release regression investigated.',
      onCallAssessment: result.onCallAssessment,
    }
  }
  // A `tester` job carries a structured test report instead of a PR; surface it so
  // the engine can greenlight-or-loop the fixer.
  if (result.report !== undefined) {
    return {
      output: result.summary?.trim() || 'Testing complete.',
      testReport: result.report,
    }
  }
  // A `ci-fixer` job reports whether it pushed a fix. The engine's CI gate ignores
  // this result (it just re-polls CI), but map it to a sensible output regardless.
  if (result.pushed !== undefined) {
    return {
      output:
        result.summary?.trim() ||
        (result.pushed ? 'Pushed a CI fix to the PR branch.' : 'No CI fix was produced.'),
    }
  }
  // A `conflict-resolver` job reports whether the branch is now mergeable. The
  // engine's conflicts gate re-checks mergeability regardless; map to an output.
  if (result.resolved !== undefined) {
    return {
      output:
        result.summary?.trim() ||
        (result.resolved
          ? 'Resolved merge conflicts and pushed to the PR branch.'
          : 'Could not fully resolve the merge conflicts.'),
    }
  }
  const summary = result.summary?.trim() || 'Implementation complete.'
  const output = result.prUrl ? `${summary}\n\nPR: ${result.prUrl}` : summary
  // Surface the opened PR structurally (not just in the output text) so the
  // engine can record it on the block and the board can link straight to it.
  const pullRequest = result.prUrl
    ? {
        url: result.prUrl,
        ...(prNumberFromUrl(result.prUrl) !== undefined
          ? { number: prNumberFromUrl(result.prUrl) }
          : {}),
        ...(result.branch ? { branch: result.branch } : {}),
      }
    : undefined
  // No `model` here: the proxy meters tokens and the async path doesn't carry the
  // provider ref to the poll site. `usage` is likewise omitted (metered by the proxy).
  return {
    output,
    ...(pullRequest ? { pullRequest } : {}),
  }
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
