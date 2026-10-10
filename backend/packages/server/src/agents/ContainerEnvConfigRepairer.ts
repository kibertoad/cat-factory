import type {
  EnvConfigRepairer,
  EnvConfigRepairHandle,
  EnvConfigRepairRequest,
  EnvConfigRepairUpdate,
  EnvironmentProvider,
  GitHubInstallationRepository,
  ModelRef,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause } from '@cat-factory/kernel'
import { isProxyableProvider } from '@cat-factory/agents'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import type { MintInstallationToken } from './repoTargeting.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

// ---------------------------------------------------------------------------
// The live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2).
//
// ⚠️ This is NOT the "bootstrap repo" task. That flow (ContainerRepoBootstrapper)
// reinitialises git history and force-pushes a fresh service into an EMPTY repo. This
// flow leaves history intact: it clones an EXISTING repo at a given ref, has a coding
// agent fix the provider's malformed/partial config file (e.g. `.deploy.yml`) in place,
// and pushes the fix back onto the SAME branch — no history reset, no force-push, no PR,
// no separate target repo. It dispatches the GENERIC `coding` job with NO `bootstrap`
// block, so the harness takes its ordinary clone→edit→push path. The two flows share
// only the runner dispatch/poll plumbing (RunnerJobClient), nothing else.
//
// It implements the kernel {@link EnvConfigRepairer} port — the side-effecting half of a
// config-repair run, mirroring {@link ContainerRepoBootstrapper}'s SHAPE: `startRepair`
// pre-flights + dispatches (returns once accepted), `pollRepair` reports progress / the
// terminal outcome, `stopRepair` reclaims the container. The run is driven DURABLY by an
// EnvConfigRepairRunner (the worker's EnvConfigRepairWorkflow / Node pg-boss) and the
// engine (EnvConfigRepairService) RE-VALIDATES the repo after the agent pushes — so this
// dispatcher only pushes the fix; it never validates and never blocks the request.
// ---------------------------------------------------------------------------

/** The base coding role for a config-repair run; the provider's prompt supplies the specifics. */
const REPAIR_SYSTEM_PROMPT =
  'You are an environment-configuration fixer. You have a clone of a repository whose ' +
  'environment-provider configuration file is missing or malformed. Make the minimal, ' +
  'focused edits needed to bring that configuration into a valid state per the ' +
  'instructions, leaving the rest of the repository untouched. Commit and push your ' +
  'changes; do NOT open a pull request.'

export interface ContainerEnvConfigRepairerDependencies {
  /**
   * Resolve which runner backend (Cloudflare container or self-hosted pool) the repair
   * job dispatches to — the same seam the implementation executor + bootstrapper ride.
   */
  resolveTransport: ResolveRunnerTransport
  /** Resolve which GitHub installation a workspace's repos live under (clone + push). */
  installationRepository: Pick<GitHubInstallationRepository, 'getByWorkspace'>
  /**
   * Mints a short-lived GitHub installation token for clone + push, scoped to the single repo
   * being repaired. A repair has no run initiator, so it names no `initiatedBy` and always runs
   * on the deployment credential.
   */
  mintInstallationToken: MintInstallationToken
  /**
   * The workspace's repo projection, read to turn the request's `owner`/`repo` into the numeric
   * id the token scope is expressed in. Required rather than optional: this is the only thing
   * standing between a repair container and an installation-wide credential, and an optional
   * dependency is how a facade forgets to wire one without anything failing.
   */
  repoRepository: Pick<RepoProjectionRepository, 'list'>
  /** Mints the signed, model-locked LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /** The provider whose `describeRepairAgent` supplies the repair prompt. */
  environmentProvider: EnvironmentProvider
  /** Model the repair agent runs with (must be proxyable, like the other Pi agents). */
  model: ModelRef
  /** Public base URL of the LLM proxy, including `/v1`. */
  proxyBaseUrl: string
  /** GitHub REST base for the push (Enterprise / api.github.com). */
  githubApiBase?: string
  /** Web base for building the target repo's clone URL (defaults to github.com). */
  webBaseUrl?: string
}

/**
 * Dispatches and polls a one-shot coding agent that repairs a provider's config file
 * in an existing repo. A thin layer over the shared {@link RunnerJobClient}
 * dispatch/poll/release plumbing, mirroring {@link ContainerRepoBootstrapper}'s SHAPE — but
 * a distinct flow: ordinary coding (NO `bootstrap`/`mergeBase` block), so the harness clones
 * `gitRef`, lets the agent edit the config, and pushes back onto `gitRef` with no PR.
 */
export class ContainerEnvConfigRepairer implements EnvConfigRepairer {
  /** Shared backend-polymorphic dispatch/poll/release plumbing (see RunnerJobClient). */
  private readonly jobs: RunnerJobClient

  constructor(private readonly deps: ContainerEnvConfigRepairerDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
  }

  /**
   * Pre-flight + dispatch the repair coding agent against `request.gitRef`, returning once
   * the container accepts the job (the fix is pushed back onto that branch by the run).
   * Throws on a missing GitHub connection, a non-proxyable model, or an absent
   * `describeRepairAgent` — so the run fails fast instead of reporting a phantom success.
   */
  async startRepair(request: EnvConfigRepairRequest): Promise<EnvConfigRepairHandle> {
    const { workspaceId, jobId, owner, repo, gitRef } = request
    const log = logger.child({ jobId, workspaceId, repo: `${owner}/${repo}`, branch: gitRef })

    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${workspaceId}' is not connected to GitHub`)
    }
    if (!isProxyableProvider(this.deps.model.provider)) {
      throw new Error(
        `Environment config repair needs a model the LLM proxy can serve ` +
          `(Workers AI, or a direct OpenAI-compatible provider); ` +
          `'${this.deps.model.provider}' is not supported.`,
      )
    }
    // An explicit prompt override (the custom-manifest generate/fix flow) wins over the
    // connection provider's `describeRepairAgent` — its prompt comes from the custom-manifest-type
    // definition, not the provider.
    const spec =
      request.promptOverride ??
      this.deps.environmentProvider.describeRepairAgent?.({
        issues: request.issues,
        ...(request.inputs ? { inputs: request.inputs } : {}),
        repoOwner: owner,
        repoName: repo,
      })
    if (!spec) {
      throw new Error('The environment provider does not support agent-based config repair.')
    }

    // The token is scoped to the one repo the agent clones, edits and pushes back onto. The
    // request names it by owner/name, so the numeric id comes off the workspace's projection;
    // a repo the projection has not caught up with yields an EMPTY scope, which widens the mint
    // installation-wide and says so, rather than failing a repair over a stale read.
    const repoIds = await this.resolveRepoScope(workspaceId, owner, repo)
    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: jobId,
      workspaceId,
      repoIds,
    })
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId,
      executionId: jobId,
      agentKind: 'coder',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })
    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    const cloneUrl = `${webBase}/${owner}/${repo}.git`
    const systemPrompt = spec.systemPromptAddendum
      ? `${REPAIR_SYSTEM_PROMPT}\n\n${spec.systemPromptAddendum}`
      : REPAIR_SYSTEM_PROMPT

    // A plain `coding` job: clone `gitRef`, edit, push back to `gitRef`. NO `bootstrap`
    // block (that would force-push a reinitialised history), NO `pr` (push only), and a
    // no-op is a clean non-event (the config may already be acceptable).
    const body = {
      jobId,
      // The run's correlation ids, matching `buildCommonBody` — a repair dispatches the same
      // `agent` kind, so its container lines join to the backend's on `executionId` like any
      // other. As with bootstrap, the job id IS the run id here (no separate execution row),
      // which is what `sessionService.mint` is handed above.
      workspaceId,
      executionId: jobId,
      mode: 'coding',
      systemPrompt,
      userPrompt: spec.prompt,
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      // This backend serves the phase-tagged completions route (see `ContainerAgentExecutor`),
      // so this flow's calls are attributed rather than landing in the unattributed slice.
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      repo: { owner, name: repo, baseBranch: gitRef, cloneUrl },
      branch: gitRef,
      commitMessage: request.manifestPath
        ? `chore: generate/fix ${request.manifestPath}`
        : 'chore: repair environment provider config',
      noChangesIsError: false,
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // A single-job flow: its run IS its one job, so run id and job id coincide.
    const ref = { runId: jobId, jobId }
    log.info('env-config-repair: dispatching container')
    await this.jobs.dispatch(workspaceId, ref, body, 'agent')
    log.info('env-config-repair: container accepted job')
    return { workspaceId, jobId }
  }

  /** Poll a dispatched repair job, mapping the runner view into a progress/terminal update. */
  async pollRepair(handle: EnvConfigRepairHandle): Promise<EnvConfigRepairUpdate> {
    const ref = { runId: handle.jobId, jobId: handle.jobId }
    const view = await this.jobs.poll(handle.workspaceId, ref)

    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      const error = view.error ?? 'Environment config repair job failed'
      return {
        state: 'failed',
        // Prefer the transport's STRUCTURED eviction verdict, then the harness's structured
        // `failureCause` (via the kernel's shared mapper); default to the coarse `agent` when
        // neither is present (the watchdog-phrase string fallback is gone — current images always
        // emit a cause). Both eviction kinds (`crash` / `transient`) collapse to the single
        // `evicted` failure kind on purpose — env-config repair has no transient-vs-crash recovery
        // budget (only the run driver's `recoverContainerEviction` splits them), so the
        // distinction is meaningless here.
        failureKind: view.evicted
          ? 'evicted'
          : (failureKindFromHarnessCause(view.failureCause) ?? 'agent'),
        error,
        detail: view.error,
      }
    }
    // Completed: a structured `error` (e.g. push rejected) is still a failure. Prefer the
    // harness's structured cause (e.g. a `git` push fault) over the flat `agent` default.
    const result = view.result ?? {}
    if (result.error) {
      return {
        state: 'failed',
        failureKind: failureKindFromHarnessCause(view.failureCause) ?? 'agent',
        error: `Environment config repair failed: ${result.error}`,
        detail: result.error,
      }
    }
    return { state: 'done' }
  }

  /**
   * Best-effort: reclaim the per-run container for a job. Releases through the same
   * transport the run dispatched to; idempotent (a release on a gone instance is a no-op,
   * and any error is swallowed by the caller).
   */
  async stopRepair(handle: EnvConfigRepairHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, { runId: handle.jobId, jobId: handle.jobId })
  }

  /**
   * The repo the repair token may reach, as the neutral id the mint's scope speaks in.
   *
   * A repair request identifies its target by `owner`/`repo` because that is what the bootstrap
   * flow that raises it has, so the numeric id is read off the workspace's own projection. An
   * empty result is returned rather than thrown: the projection lagging behind a just-linked repo
   * is a reason to widen the token and report it (`buildDispatchTokenMint`), not to refuse a
   * repair the operator asked for.
   */
  private async resolveRepoScope(
    workspaceId: string,
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const projected = await this.deps.repoRepository.list(workspaceId)
    const match = projected.find(
      (row) =>
        row.owner.toLowerCase() === owner.toLowerCase() &&
        row.name.toLowerCase() === repo.toLowerCase(),
    )
    return match ? [String(match.githubId)] : []
  }
}
