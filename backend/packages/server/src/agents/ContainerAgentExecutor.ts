import {
  type AgentContextFile,
  type AgentContextFragment,
  type AgentContextRecorder,
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type HarnessCallMetric,
  type HarnessKind,
  type LlmTraceSink,
  type ModelRef,
  type RecordAgentContextInput,
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  type SubscriptionQuotaTarget,
  type SubscriptionVendor,
  type TestSecretEntry,
  type WebSearchAvailability,
} from '@cat-factory/kernel'
import {
  CONTEXT_BUDGET,
  CredentialRequiredError,
  renderTaskContext,
  SUBSCRIPTION_VENDORS,
  isIndividualVendor,
  isSubscriptionVendor,
} from '@cat-factory/kernel'
import { resolveAprioriWorkingBranch, resolveInstanceTypeId } from '@cat-factory/contracts'
import {
  type AgentKindRegistry,
  type AgentRouting,
  agentTuningFor,
  DOC_WRITER_KIND,
  defaultAgentKindRegistry,
  isProxyableProvider,
  isReadOnlyAgentKind,
  webResearchGuidanceFor,
} from '@cat-factory/agents'
import { ModelRouter } from './ModelRouter.js'
import { toRunResult } from './containerAgentResult.js'
import {
  buildKindBody,
  renderMergerMultiRepoSection,
  renderMultiRepoWorkspaceSection,
  renderReferenceReposSection,
} from './jobBody.js'
import {
  CONFLICT_RESOLVER_AGENT_KIND,
  MERGER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
  isTesterKind,
  type HarnessCallsRecordInput,
} from '@cat-factory/orchestration'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import type { RepoCheckout, ResolveRepoTargets } from './resolveRepoTarget.js'

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
 * One private package-registry entry as it rides the harness job body: the decrypted
 * token plus the registry host (derived backend-side from the fixed vendor set — the
 * harness hard-allowlists the hosts it will send a token to). Ecosystem-discriminated
 * so later ecosystems (pip/maven/cargo) are additive. Deliberately a dedicated
 * top-level body field, NEVER a context file: the agent-context snapshot copies
 * `contextFiles` content verbatim, while unknown top-level fields are omitted by its
 * allow-list projection.
 */
export interface JobPackageRegistrySpec {
  ecosystem: 'npm'
  host: string
  scopes: string[]
  token: string
}

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
 * polling gate's helper retry) carries a non-zero `dispatchEpoch` so each round gets a
 * distinct id. The harness re-attaches to an EXISTING job id rather than re-running (replay
 * idempotency), and a container-reusing transport (a warm local pool / a self-hosted runner
 * pool) keeps that registry alive across rounds — reclaiming a pooled member does NOT
 * destroy it — so without the epoch a re-test would replay the first round's stale report
 * (the bug where the Tester appeared to "pass regardless" and never actually re-ran). Epoch
 * 0 (a step dispatched once) keeps the original unsuffixed id, so single-dispatch steps are
 * unaffected. See {@link AgentRunContext.dispatchEpoch}.
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
 * Strip any embedded `user:pass@` userinfo from a URL before it is stored in an
 * observability snapshot. The allow-list promises "never a credential-bearing URL", but
 * the injected-doc URLs and a tester's ephemeral `environmentUrl` are operator-supplied
 * and could carry credentials in their userinfo, so defang them here. Non-URL strings
 * (and URLs with no userinfo) pass through unchanged.
 */
export function stripUrlCredentials(value: string): string {
  if (!value) return value
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return value
  }
}

/**
 * Redact credential-bearing URLs from the tester's `infra` spec before it is stored.
 * An `ephemeral` run carries the provisioned `environmentUrl`; the env's access
 * credentials live on a separate field that is never copied, but the URL itself is
 * operator-mapped and could embed userinfo, so strip it. Returns the value untouched
 * when it is not an `infra` object.
 */
function redactInfra(infra: unknown): unknown {
  if (!infra || typeof infra !== 'object' || Array.isArray(infra)) return infra
  const copy = { ...(infra as Record<string, unknown>) }
  if (typeof copy.environmentUrl === 'string') {
    copy.environmentUrl = stripUrlCredentials(copy.environmentUrl)
  }
  return copy
}

/**
 * Build the redacted agent-context snapshot from a dispatched job body + run context.
 * Deliberately an ALLOW-LIST: it copies the composed prompts, the folded-in fragment
 * bodies and the injected context files, plus a handful of structural fields — and
 * NEVER any credential (the GitHub token, the proxy session token, a leased
 * subscription token, or the clone/environment URL that embeds them).
 */
function buildAgentContextRecord(
  context: AgentRunContext,
  body: Record<string, unknown>,
  model: string,
  ids: { workspaceId: string; executionId: string },
): RecordAgentContextInput {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const repo = (body.repo ?? {}) as Record<string, unknown>
  const contextFiles = Array.isArray(body.contextFiles)
    ? (body.contextFiles as unknown[]).map((f): AgentContextFile => {
        const file = (f ?? {}) as Record<string, unknown>
        return {
          path: str(file.path),
          title: str(file.title),
          url: stripUrlCredentials(str(file.url)),
          content: str(file.content),
        }
      })
    : []
  const fragments: AgentContextFragment[] = (context.block.resolvedFragments ?? []).map((fr) => ({
    id: fr.id,
    body: fr.body,
  }))
  return {
    workspaceId: ids.workspaceId,
    executionId: ids.executionId,
    agentKind: context.agentKind,
    stepIndex: context.stepIndex,
    model,
    // Record the harness the body actually carried; don't guess. A body without an
    // explicit harness records `null` rather than mislabelling a codex / claude-code
    // dispatch as `pi`.
    harness: typeof body.harness === 'string' ? body.harness : null,
    systemPrompt: str(body.systemPrompt),
    userPrompt: str(body.userPrompt),
    fragments,
    contextFiles,
    extras: {
      pipelineName: context.pipelineName,
      mode: body.mode,
      repo: { owner: str(repo.owner), name: str(repo.name), baseBranch: str(repo.baseBranch) },
      branch: body.branch,
      serviceDirectory: repo.serviceDirectory,
      webSearch: body.webSearch ?? false,
      infra: redactInfra(body.infra),
      decisions: context.decisions,
      ...(context.revision
        ? { revision: { feedback: context.revision.feedback, hadPriorProposal: true } }
        : {}),
    },
  }
}

/**
 * The {@link RunnerJobRef} a job handle addresses: the run (for the per-run container)
 * plus the per-step job id. Falls back to the job id as the run id for a handle minted
 * before run ids were carried (or a single-job flow where the two coincide).
 */
function refForHandle(handle: AgentJobHandle): RunnerJobRef {
  return { runId: handle.runId ?? handle.jobId, jobId: handle.jobId }
}

/** The git origin a run's repo is reached at: the clone URL plus the VCS provider. */
export interface RepoOrigin {
  cloneUrl: string
  provider: 'github' | 'gitlab'
}

/**
 * Resolve the clone URL + VCS provider for a run's repo. The repo projection carries NO host
 * (it stores only `owner`/`name`), so the origin is a deployment-level fact supplied here.
 * Defaults to GitHub (`https://github.com/<owner>/<name>.git`); a GitLab deployment (local
 * mode) injects a builder that emits the configured GitLab host + `gitlab`, so the harness
 * clones the right host AND opens a merge request instead of a pull request. Without this the
 * clone URL would always point at github.com, so a GitLab repo could never be cloned.
 */
export type ResolveRepoOrigin = (repo: RepoTarget) => RepoOrigin

const githubRepoOrigin: ResolveRepoOrigin = (repo) => ({
  cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
  provider: 'github',
})

function buildRepoSpec(repo: RepoTarget, origin: RepoOrigin) {
  return {
    owner: repo.owner,
    name: repo.name,
    baseBranch: repo.baseBranch,
    cloneUrl: origin.cloneUrl,
    provider: origin.provider,
    ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
  }
}

/**
 * The built-in implementer ("Coder") kind. The multi-repo coding fan-out
 * (service-connections phase 3) started ONLY on this kind: it is the step that makes the
 * cross-service change.
 */
const IMPLEMENTER_AGENT_KIND = 'coder'

/**
 * The PRE-REGISTRY built-in kinds that fan out across the task's connected repos as sibling
 * checkouts (service-connections phases 3–4). The `coder` opens the PRs; the `ci-fixer` resumes
 * those SAME work branches to fix red CI across every repo in one container (a cross-repo
 * contract break is exactly what a single-repo fixer can't fix). The conflict-resolver stays
 * SINGLE-repo (a git conflict is per-repo textual — handled by targeting the conflicted repo,
 * not fan-out).
 *
 * These two are not yet migrated to the agent-kind registry, so they can't declare
 * `fanOutMultiRepo` on a definition — hence this small allow-list. Registry-backed kinds (the
 * read-only `bug-investigator`, and any custom cross-service explore kind a deployment registers)
 * opt in via {@link AgentKindRegistry.fansOutMultiRepo} instead of being added here — so a new
 * fan-out kind is a registry flag, not another entry in this Set.
 */
const MULTI_REPO_FANOUT_BUILTIN_KINDS: ReadonlySet<string> = new Set([
  IMPLEMENTER_AGENT_KIND,
  'ci-fixer',
])

/**
 * The kinds that consume a task's read-only `referenceRepos` — cloned as READ-ONLY sibling
 * checkouts the agent may read (to reuse existing solutions) but never write to. Deliberately
 * a SEPARATE gate from {@link MULTI_REPO_FANOUT_BUILTIN_KINDS}: reference repos are not involved
 * services (never writable, no branch/PR, don't need to be board services), so they must not be
 * folded into the fan-out path. Only the document writer reads them today.
 */
const REFERENCE_REPO_KINDS: ReadonlySet<string> = new Set([DOC_WRITER_KIND])

/** A safe, collision-free `<base>.md` filename for a materialised context file. */
function contextFileName(base: string, used: Set<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'context'
  let name = `${slug}.md`
  for (let i = 2; used.has(name); i++) name = `${slug}-${i}.md`
  used.add(name)
  return name
}

type ContextDoc = NonNullable<AgentRunContext['block']['contextDocs']>[number]
type ContextTask = NonNullable<AgentRunContext['block']['contextTasks']>[number]

/**
 * Materialise the block's linked context (docs + tracker issues) into files the harness
 * writes under CONTEXT_DIR in the checkout, so a container agent reads them on demand.
 * Each file is prefixed with its title + source URL (the zero-cost slice of Anthropic's
 * contextual-retrieval). Bounded by {@link CONTEXT_BUDGET.maxContextFileBytes} so a large
 * corpus can't bloat the job body; items past the cap are dropped.
 *
 * Returns both the files AND the docs/tasks that actually fit (`contextDocs`/`contextTasks`),
 * so the caller can render the prompt's summary index from exactly the materialised set —
 * the prompt never names a file the agent won't find on disk.
 */
function buildContextFiles(context: AgentRunContext): {
  files: { path: string; title: string; url: string; content: string }[]
  contextDocs: ContextDoc[]
  contextTasks: ContextTask[]
} {
  const { contextDocs, contextTasks } = context.block
  const files: { path: string; title: string; url: string; content: string }[] = []
  const keptDocs: ContextDoc[] = []
  const keptTasks: ContextTask[] = []
  if (!contextDocs?.length && !contextTasks?.length)
    return { files, contextDocs: keptDocs, contextTasks: keptTasks }
  const used = new Set<string>()
  let bytes = 0
  // Write the file when it fits the byte budget; report back whether it was kept so the
  // caller can keep the prompt index in lock-step with what's on disk.
  const fit = (title: string, url: string, baseName: string, raw: string): boolean => {
    const content = `# ${title}\nSource: ${url}\n\n${raw}`
    const size = new TextEncoder().encode(content).length
    if (bytes + size > CONTEXT_BUDGET.maxContextFileBytes) return false
    bytes += size
    files.push({ path: contextFileName(baseName, used), title, url, content })
    return true
  }
  for (const doc of contextDocs ?? [])
    if (fit(doc.title, doc.url, doc.title, doc.body || doc.excerpt)) keptDocs.push(doc)
  for (const task of contextTasks ?? [])
    if (fit(`[${task.key}] ${task.title}`, task.url, task.key, renderTaskContext(task)))
      keptTasks.push(task)
  return { files, contextDocs: keptDocs, contextTasks: keptTasks }
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
    const { body, model, provider, kind, subscriptionTokenId, search, repoSummary } =
      await this.buildJobBody(context)
    // The job's id is per-STEP (run id + agent kind), so sibling steps that share this
    // run's container never collide in the harness's per-kind job registries; the run
    // itself is addressed by the execution id, so its container is reclaimed as a unit.
    const jobId = body.jobId as string
    const ref: RunnerJobRef = { runId: executionId, jobId }
    await this.jobs.dispatch(workspaceId, ref, body, kind, this.dispatchOptions(context))
    // Capture the complete provided context for observability (best-effort, gated inside
    // the recorder). This is the only place the fully composed prompts + the injected
    // file bodies exist as one unit; proxy telemetry never sees the `.cat-context` files.
    if (this.deps.agentContextObservability) {
      try {
        await this.deps.agentContextObservability.record(
          buildAgentContextRecord(context, body, model, { workspaceId, executionId }),
        )
      } catch {
        // Swallowed: observability never breaks a dispatch.
      }
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
      // Forward the latest subtask counts (if any) so the engine can surface live
      // "N/M done" progress on the step; the shapes match field-for-field. Also forward
      // the container's current lifecycle phase (clone / agent / push, from the harness)
      // and its identity/address (id + url, from the transport) so the engine can show
      // what the container is doing and where it lives — not just a blank "working".
      const containerMeta = {
        ...(view.phase ? { phase: view.phase } : {}),
        ...(view.container ? { container: view.container } : {}),
        ...(view.backend ? { backend: view.backend } : {}),
      }
      return view.progress
        ? { state: 'running', subtasks: view.progress, ...followUps, ...containerMeta }
        : { state: 'running', ...followUps, ...containerMeta }
    }
    // The harness's structured failure cause + extended diagnostic, forwarded so the engine
    // classifies the failure without regex-matching `error`. Absent on an older image.
    const failureMeta = {
      ...(view.failureCause ? { failureCause: view.failureCause } : {}),
      ...(view.detail ? { detail: view.detail } : {}),
      ...(view.backend ? { backend: view.backend } : {}),
    }
    // Completed OR failed: a subscription harness attaches its per-call telemetry to
    // BOTH — a failed token-spending run (no changes / unusable output / unresolved
    // conflicts) is exactly what an operator needs to inspect — so record it before the
    // terminal returns below, on every terminal state.
    const result = view.result ?? {}
    await this.recordHarnessCallsOnce(handle, result)
    if (view.state === 'failed') {
      return { state: 'failed', error: view.error ?? 'Implementation job failed', ...failureMeta }
    }
    // Completed: a structured `error` (e.g. "no file changes") is still a failure. The harness
    // carries the cause on the view even for these clean-exit failures, so forward it too.
    if (result.error) {
      return { state: 'failed', error: `Implementation failed: ${result.error}`, ...failureMeta }
    }
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
    // Fold the SAME subscription usage into the modeled quota-cycle counters (Part B), for
    // BOTH pooled and personal runs. A subscription run is the one reporting per-call
    // metrics (Pi is proxy-metered and has none), and the handle's provider is the vendor
    // slug. Scope = the leased pool token when present, else the run initiator (personal).
    // Best-effort, once per job id so a replayed poll can't double-count.
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
    const runResult = toRunResult(result, handle.agentKind)
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
    return { state: 'done', result: runResult, ...followUps }
  }

  /**
   * Record the subscription harness's per-call telemetry into `llm_call_metrics` — the
   * proxy-bypassing analogue of the rows the LLM proxy writes for Pi. NOT gated on a
   * pooled token id, so a personal (individual-usage) subscription run is observed too.
   * Runs on every terminal state (success and failure alike). Best-effort: an unwired
   * recorder or an empty metric list is a no-op. An in-memory once-per-job guard skips
   * the redundant DB round-trip within this process; the recorder additionally mints
   * deterministic per-call ids off the job id, so even a durable-driver replay in a
   * fresh isolate (empty guard) re-records idempotently rather than duplicating rows.
   */
  private async recordHarnessCallsOnce(
    handle: AgentJobHandle,
    result: { callMetrics?: HarnessCallMetric[] },
  ): Promise<void> {
    if (
      !handle.workspaceId ||
      !result.callMetrics ||
      result.callMetrics.length === 0 ||
      !this.deps.recordHarnessCalls ||
      this.recordedCallMetricJobs.has(handle.jobId)
    ) {
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
        calls: result.callMetrics,
      })
      if (this.recordedCallMetricJobs.size >= 10_000) this.recordedCallMetricJobs.clear()
      this.recordedCallMetricJobs.add(handle.jobId)
    } catch {
      // Swallowed: telemetry is observability, never a reason to fail (or fail to
      // complete) a run.
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
  }> {
    const { workspaceId, executionId, blockId } = this.requireIds(context)
    // Per-STEP harness job id: unique within the run so this step's job never aliases
    // a sibling step's in the (shared) per-run container's job registries — and unique
    // per RE-dispatch round (the dispatch epoch) so a Tester re-test / fixer round never
    // re-attaches to the prior round's completed job on a container-reusing transport.
    const jobId = stepJobId(executionId, context.agentKind, context.dispatchEpoch)

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

    // The shared per-task work branch every agent in this pipeline operates on. By default
    // its name is deterministic from the block id (so a retry/replay/sweeper re-drive always
    // targets the SAME branch with no extra persistence), and once a PR is open it IS this
    // branch. Ensure it up front (mechanical, idempotent) so even the read-only design agents
    // clone the branch the earlier writers committed to — e.g. the spec-writer's in-repo
    // `spec/`. Writers create it from base when absent; read-only agents only probe (a missing
    // branch ⇒ nothing to read yet ⇒ fall back to base), so a code-less pipeline never
    // orphans an empty ref. Once this block already has a PR, the branch IS that PR's
    // branch, so we skip the round-trip entirely.
    // An apriori WORKING branch (an existing branch the task names as its starting point)
    // overrides the deterministic `cat-factory/<blockId>` work branch: the run builds inside
    // it, the PR opens from it, and the CI gate / merger ride it. Unlike the platform branch,
    // it must ALREADY exist — it is probed (never created), a missing branch fails the
    // dispatch loudly, and it may never be the repo's own base branch (the run would have
    // nothing to diff / no PR to open).
    const aprioriWork = resolveAprioriWorkingBranch(context.aprioriBranches, repo.baseBranch)
    const workBranch = aprioriWork ?? `cat-factory/${blockId}`
    let workBranchReady: boolean
    if (context.block.pullRequest?.branch === workBranch) {
      workBranchReady = true
    } else if (aprioriWork) {
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
      workBranchReady = true
    } else {
      workBranchReady = this.deps.ensureWorkBranch
        ? await this.deps.ensureWorkBranch(repo, workBranch, {
            create: !isReadOnlyAgentKind(context.agentKind),
          })
        : false
    }

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
    // Linked-context bodies are materialised into the checkout (under CONTEXT_DIR) so a
    // container agent can read what it needs on demand; the prompt only lists them. The
    // harness can't reach Jira/GitHub itself, so everything is prepared here, up front.
    const {
      files: contextFiles,
      contextDocs: keptDocs,
      contextTasks: keptTasks,
    } = buildContextFiles(context)
    // The UI tester uploads its captured screenshots back to the backend from inside the
    // container. It reuses the SAME container session token it already carries for the LLM
    // proxy (auth.sessionToken), POSTing to the harness ingest route that shares the proxy
    // base URL — so no extra credential and no extra public-URL dependency. Only the
    // `tester-ui` kind gets it; every other kind never sees an upload seam.
    const artifactUpload =
      context.agentKind === UI_TESTER_AGENT_KIND &&
      typeof auth.proxyBaseUrl === 'string' &&
      typeof auth.sessionToken === 'string'
        ? { url: `${auth.proxyBaseUrl}/artifacts/ingest`, token: auth.sessionToken }
        : undefined
    // Per-kind execution tuning (loosen-only progress-guard knobs) the harness applies
    // over its env/built-in defaults, so a kind whose normal pattern differs (e.g. a
    // research-heavy or retry-heavy kind) isn't killed mid-progress. Absent ⇒ defaults.
    const tuning = agentTuningFor(context.agentKind, this.agentKindRegistry)
    // Private-registry auth for the checkout's installs. Resolved per dispatch (like
    // ghToken) and spread into `common`, so every kind with a checkout gets it.
    const packageRegistries = (await this.deps.resolvePackageRegistries?.(workspaceId)) ?? []
    // Sensitive test credentials for the tester kinds ONLY: decrypt the service frame's sealed
    // secrets and carry them as `{ key, value }` env pairs on a dedicated top-level body field
    // (like `packageRegistries`), which the agent-context snapshot allow-list omits. The harness
    // injects each as an env var; the prompt only advertises the keys+descriptions (from
    // `context.testSecrets`). Values NEVER reach a prompt or the telemetry snapshot.
    const testSecretEnv =
      isTesterKind(context.agentKind) && this.deps.resolveTestSecrets
        ? (await this.deps.resolveTestSecrets(workspaceId, blockId)).map((e) => ({
            key: e.key,
            value: e.value,
          }))
        : []
    // Resolve the repo origin once so both the harness `RepoSpec` and the diagnostics repo
    // summary (returned below) agree on the VCS provider.
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    const common = {
      jobId,
      model: ref.model,
      ...auth,
      ghToken,
      ...(packageRegistries.length ? { packageRegistries } : {}),
      repo: buildRepoSpec(repo, origin),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      ...(contextFiles.length ? { contextFiles } : {}),
      ...(artifactUpload ? { artifactUpload } : {}),
      ...(tuning?.guardLimits ? { guardLimits: tuning.guardLimits } : {}),
    }
    // Render the prompt's linked-context summary index from exactly the items that were
    // materialised (some may have been dropped at the byte cap), so the agent is never
    // pointed at a `.cat-context/` file that doesn't exist.
    const promptContext: AgentRunContext = contextFiles.length
      ? { ...context, block: { ...context.block, contextDocs: keptDocs, contextTasks: keptTasks } }
      : context
    // The proxy-backed web-tools nudge + switch, shared by the kinds that allow web
    // access (coder/mocker/ci-fixer/fixer/tester/read-only). `web_search` is offered only
    // when the run's account actually has a usable upstream (keys are per-account now), so
    // the agent is never handed a tool that always fails. Per-kind hint (coder/mocker/
    // analysis/… and any custom container kind resolves its own).
    const search: WebSearchAvailability = (await this.deps.resolveWebSearchAvailability?.(
      workspaceId,
    )) ?? { available: false, provider: null }
    const webTools = {
      webToolsGuidance: webResearchGuidanceFor(context.agentKind, this.agentKindRegistry, {
        fetch: true,
      }),
      ...(search.available ? { webSearch: true } : {}),
    }

    // Multi-repo coding (service-connections phases 3–4): when the implementer OR the ci-fixer
    // runs on a task with connected involved services, resolve every involved repo and fan the
    // work out — peer repos as sibling checkouts plus a prompt section naming the layout. The
    // coder opens one PR per changed repo; the ci-fixer resumes those same work branches to fix
    // red CI across all of them (jobBody drops the peer `pr` on the fixer path). A service
    // co-located in the primary's own repo (same monorepo) has no separate checkout; it rides
    // the own-service PR and is named in the section so the agent edits its subtree. Any involved
    // service present ⇒ the agent works at the repo ROOT (not just its own service subdir) so it
    // can reach every involved subtree; `commonForKind` swaps `repo`.
    let peerRepos:
      | { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
      | undefined
    let multiRepoSection: string | undefined
    let commonForKind = common
    // The repo target the per-kind body builds against — the task's own service by default, but
    // swapped to a PEER repo when the conflicts gate targets the conflict-resolver at a connected
    // service (see the conflict-resolver block below).
    let repoForKind = repo
    const involvedServices = context.involvedServices ?? []
    const fansOutMultiRepo =
      MULTI_REPO_FANOUT_BUILTIN_KINDS.has(context.agentKind) ||
      this.agentKindRegistry.fansOutMultiRepo(context.agentKind)
    if (fansOutMultiRepo && involvedServices.length > 0 && this.deps.resolveRepoTargets) {
      // Reuse the primary repo already resolved above (line ~889) so the plural resolver skips
      // re-reading the installation and re-walking the primary block's ancestry — it only needs
      // to resolve + dedupe the involved peers on top of it.
      const { checkouts } = await this.deps.resolveRepoTargets(
        workspaceId,
        blockId,
        involvedServices.map((s) => s.frameId),
        repo,
      )
      const primaryCheckout = checkouts.find((c) => c.primary)
      const peerCheckouts = checkouts.filter((c) => !c.primary)
      // Multi-service iff there is a distinct peer repo OR an involved service co-located in
      // the primary's monorepo (both need the root-cwd + the prompt section).
      const coLocated = primaryCheckout?.involved ?? []
      if (peerCheckouts.length > 0 || coLocated.length > 0) {
        const origin = this.deps.resolveRepoOrigin ?? githubRepoOrigin
        if (peerCheckouts.length > 0) {
          peerRepos = peerCheckouts.map((c: RepoCheckout) => ({
            repo: buildRepoSpec(c.target, origin(c.target)),
            ...(c.involved[0]?.frameId ? { frameId: c.involved[0].frameId } : {}),
          }))
        }
        multiRepoSection = renderMultiRepoWorkspaceSection(checkouts, involvedServices)
        // Work at the repo ROOT: drop the primary's own-service subdir scoping so the agent
        // can edit every involved subtree in the (mono)repo. The layout section names which
        // subdirectory each service lives in.
        if (primaryCheckout) {
          const { serviceDirectory: _drop, ...rootTarget } = primaryCheckout.target
          commonForKind = {
            ...common,
            repo: buildRepoSpec(rootTarget, origin(rootTarget)),
          }
        }
      }
    }

    // Conflict-resolver PEER targeting (service-connections phase 4 follow-up): when the
    // conflicts gate detected the conflict on a connected involved service's repo, it hands the
    // resolver `context.conflictTarget`. Point the (single-repo) resolver at that PEER repo —
    // resolve its target and swap `repo`/`common.repo` — instead of the task's own service. The
    // resolver clones the peer's PR (work) branch and merges the peer's base in (jobBody pins the
    // branch to the shared work branch and reads `mergeBase` off this swapped target). An own-repo
    // conflict carries no `frameId`, so this is a no-op and the resolver targets the own service.
    const conflictFrameId =
      context.agentKind === CONFLICT_RESOLVER_AGENT_KIND
        ? context.conflictTarget?.frameId
        : undefined
    if (conflictFrameId && this.deps.resolveRepoTargets) {
      const { checkouts } = await this.deps.resolveRepoTargets(
        workspaceId,
        blockId,
        [conflictFrameId],
        repo,
      )
      const peer = checkouts.find(
        (c) => !c.primary && c.involved.some((i) => i.frameId === conflictFrameId),
      )
      // Fail fast if the tagged peer can't be resolved (e.g. a stale/missing repo projection row):
      // falling through would silently point the resolver at the OWN repo, which has no conflict, so
      // every re-probe would re-dispatch until the whole attempt budget is spent on the wrong repo
      // and the run gives up misattributing the failure. A loud dispatch error surfaces the
      // inconsistency immediately instead.
      if (!peer) {
        throw new Error(
          `Conflict-resolver could not resolve the conflicted peer repo (frame '${conflictFrameId}') ` +
            `for block '${blockId}' — its repo projection may be missing or unlinked.`,
        )
      }
      const origin = this.deps.resolveRepoOrigin ?? githubRepoOrigin
      repoForKind = peer.target
      commonForKind = { ...common, repo: buildRepoSpec(peer.target, origin(peer.target)) }
    }

    // Merger combined-diff (service-connections phase 4 follow-up): a multi-repo task opened one PR
    // per changed repo. The merger scores the COMBINED change by cloning EVERY PR's repo as a
    // read-only sibling at its PR branch (the read-only explore fan-out) and diffing each vs its
    // base. Driven by the PRs that actually exist (`block.peerPullRequests`), not the involved-
    // services set — a peer with no change opened no PR, so there is nothing to score there. The
    // own-service PR rides the primary checkout (the merger clones `pr` full); the peers are added
    // here with their own PR branch to check out, plus a section naming the sibling diff commands.
    const peerPrs = context.block.peerPullRequests ?? []
    if (
      context.agentKind === MERGER_AGENT_KIND &&
      peerPrs.length > 0 &&
      this.deps.resolveRepoTargets
    ) {
      const frameIds = peerPrs.map((p) => p.frameId).filter((f): f is string => !!f)
      if (frameIds.length > 0) {
        const { checkouts } = await this.deps.resolveRepoTargets(
          workspaceId,
          blockId,
          frameIds,
          repo,
        )
        const origin = this.deps.resolveRepoOrigin ?? githubRepoOrigin
        const legs: {
          spec: Record<string, unknown>
          frameId: string
          cloneBranch: string
          target: RepoTarget
        }[] = []
        for (const pr of peerPrs) {
          if (!pr.frameId) continue
          const checkout = checkouts.find(
            (c) => !c.primary && c.involved.some((i) => i.frameId === pr.frameId),
          )
          if (!checkout) continue
          legs.push({
            spec: buildRepoSpec(checkout.target, origin(checkout.target)),
            frameId: pr.frameId,
            cloneBranch: pr.ref.branch ?? workBranch,
            target: checkout.target,
          })
        }
        if (legs.length > 0) {
          peerRepos = legs.map((l) => ({
            repo: l.spec,
            frameId: l.frameId,
            cloneBranch: l.cloneBranch,
          }))
          // The own service rides the primary checkout at its PR head (clone `pr`, or base when the
          // own service had no change); list it first so the section names its diff command too.
          multiRepoSection = renderMergerMultiRepoSection([
            { owner: repo.owner, name: repo.name, baseBranch: repo.baseBranch },
            ...legs.map((l) => ({
              owner: l.target.owner,
              name: l.target.name,
              baseBranch: l.target.baseBranch,
            })),
          ])
        }
      }
    }

    // Read-only reference repos (document-authoring tasks): independent of the fan-out above —
    // the doc-writer clones each attached repo as a READ-ONLY sibling checkout it may read but
    // never writes to. The spec carries NO branch/PR fields, so it is structurally unpushable;
    // the harness clones it at its own default branch and skips it in the push phase. Auth reuses
    // the run's already-resolved `ghToken` (the run initiator's own token when they have one, per
    // `mintInstallationToken`), so no extra token mint. A reference repo may be outside the
    // workspace projection, so its clone identity comes straight from the persisted attachment.
    // Provider-neutral: the clone URL + provider come from `resolveRepoOrigin` (the same
    // deployment-level seam the primary rides), so a GitLab deployment clones from GitLab.
    let referenceRepos: { repo: Record<string, unknown> }[] | undefined
    let referenceReposSection: string | undefined
    const attachedReferenceRepos = context.referenceRepos ?? []
    if (attachedReferenceRepos.length > 0 && REFERENCE_REPO_KINDS.has(context.agentKind)) {
      const origin = this.deps.resolveRepoOrigin ?? githubRepoOrigin
      // Dedup against the primary and each other by the harness's sibling-checkout key
      // (`owner/name`, case-insensitive — it maps to the `owner__name` clone directory): two legs
      // claiming the same directory would make the second `git clone` fail into a non-empty dir.
      // A reference pointing at the doc task's OWN repo is therefore dropped (it is already the
      // primary checkout), and duplicate attachments collapse to one.
      const siblingKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase()
      const seen = new Set<string>([siblingKey(repo.owner, repo.name)])
      const targets: RepoTarget[] = []
      for (const r of attachedReferenceRepos) {
        const key = siblingKey(r.owner, r.name)
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({
          installationId: r.connectionId ?? repo.installationId,
          owner: r.owner,
          name: r.name,
          baseBranch: r.defaultBranch,
        })
      }
      if (targets.length > 0) {
        referenceRepos = targets.map((t) => ({ repo: buildRepoSpec(t, origin(t)) }))
        referenceReposSection = renderReferenceReposSection(repo, targets)
      }
    }

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
    }
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
