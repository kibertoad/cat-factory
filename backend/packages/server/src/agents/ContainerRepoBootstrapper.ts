import type {
  BootstrapFailureKind,
  BootstrapJobHandle,
  BootstrapJobRepository,
  BootstrapJobUpdate,
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  GitHubClient,
  GitHubInstallationRepository,
  ModelRef,
  RepoBootstrapper,
  RepoEntry,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { isProxyableProvider } from '@cat-factory/agents'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

export interface ContainerRepoBootstrapperDependencies {
  /**
   * Resolve which runner backend (Cloudflare container or self-hosted pool) a
   * bootstrap job dispatches to — the same seam the implementation executor rides.
   */
  resolveTransport: ResolveRunnerTransport
  /** Resolve which GitHub installation a workspace's repos live under. */
  installationRepository: GitHubInstallationRepository
  /** Look up a job's target repo name when polling (the poll only carries a job id). */
  bootstrapJobRepository: BootstrapJobRepository
  /** Local repo projection: where the bootstrapped repo is recorded + linked to its frame. */
  repoRepository: RepoProjectionRepository
  /** Resolves/validates the pre-created target repository (existence + emptiness). */
  githubClient: GitHubClient
  /** Mints a short-lived GitHub installation token for clone + push. */
  mintInstallationToken: (installationId: number) => Promise<string>
  /** Mints the signed, model-locked LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /** Model the bootstrapper agent runs with (must be proxyable). */
  model: ModelRef
  /** Public base URL of the Worker's OpenAI-compatible LLM proxy, including `/v1`. */
  proxyBaseUrl: string
  /** GitHub REST base for creating the repo / pushing (Enterprise / api.github.com). */
  githubApiBase?: string
  /** Web base for building the created repo's URL (defaults to github.com). */
  webBaseUrl?: string
}

/** The role prompt when adapting a cloned reference architecture. */
const ADAPT_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You have a fresh clone of a reference ' +
  'architecture (a base/golden-template repository). Adapt it in place into the ' +
  'new service per the instructions: rename packages/modules, remove pieces that ' +
  'do not apply, update README and metadata, and leave the project building. Make ' +
  'focused, idiomatic changes that match the existing structure. Do not invent ' +
  'unrelated features.'

/** The role prompt when scaffolding a brand-new repository from scratch. */
const SCAFFOLD_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You are working in an empty directory and ' +
  'must scaffold a brand-new repository from scratch per the instructions. Create ' +
  'a sensible, idiomatic project layout: source files, a README, and the metadata ' +
  'and build/config files appropriate for the stack, leaving the project building. ' +
  'Keep the scope to what the instructions describe; do not invent unrelated features.'

/**
 * A {@link RepoBootstrapper} that performs the side-effecting half of a
 * "bootstrap repo" run. The empty target repository is created up front — by the
 * user (the default — cat-factory then needs no repo-creation permission) or, for
 * orgs served by the privileged App tier (ADR 0005), via the create-repo endpoint
 * behind the modal's "Create repository" button. This spins up a per-run Cloudflare
 * Container that clones the reference architecture, has the bootstrapper agent adapt
 * it per the instructions, and pushes the result as the new repo's initial commit.
 *
 * It pre-flights that the target repo exists, is reachable by the installation,
 * and is empty (the push is the first commit). Secrets never reach the container
 * image: the per-job GitHub installation token and the model-locked LLM-proxy
 * session token are minted here and handed over in the dispatch body, exactly as
 * the implementation executor does.
 */
export class ContainerRepoBootstrapper implements RepoBootstrapper {
  /** Shared backend-polymorphic dispatch/poll/release plumbing (see RunnerJobClient). */
  private readonly jobs: RunnerJobClient

  constructor(private readonly deps: ContainerRepoBootstrapperDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
  }

  /** An active (non-soft-deleted) installation means the workspace is connected. */
  async isWorkspaceConnected(workspaceId: string): Promise<boolean> {
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    return !!installation && !installation.deletedAt
  }

  /**
   * Pre-flight the target repo and dispatch the bootstrap container as a
   * background job (returns once accepted, like `/run`). Throws on a pre-flight
   * failure so the run fails fast before a board frame is created.
   */
  async startBootstrap(request: BootstrapRepoRequest): Promise<BootstrapJobHandle> {
    const log = logger.child({ jobId: request.jobId, workspaceId: request.workspaceId })
    const installation = await this.deps.installationRepository.getByWorkspace(request.workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${request.workspaceId}' is not connected to GitHub`)
    }

    if (!isProxyableProvider(this.deps.model.provider)) {
      throw new Error(
        `Repo bootstrapping needs a model the LLM proxy can serve ` +
          `(Workers AI, or a direct OpenAI-compatible provider); ` +
          `'${this.deps.model.provider}' is not supported.`,
      )
    }

    // The target repo is created up front — by the user via GitHub's new-repo page,
    // or, for privileged-tier orgs (ADR 0005), programmatically via the create-repo
    // endpoint behind the modal's "Create repository" button. Resolve it under the
    // installation account to confirm it exists, is reachable by the App, and is
    // empty — the run pushes the bootstrapped contents as the initial commit.
    const owner = installation.accountLogin
    const repoName = request.target.name
    const ref = { owner, repo: repoName }
    log.info({ target: `${owner}/${repoName}` }, 'bootstrap: pre-flighting target repo')

    let target
    try {
      target = await this.deps.githubClient.getRepo(installation.installationId, ref)
    } catch {
      throw new Error(
        `Repository ${owner}/${repoName} was not found or is not accessible to the GitHub App. ` +
          `Create a repository named "${repoName}" under ${owner} (an initial README, .gitignore ` +
          `or license is fine), make sure the App is installed on it, then run bootstrap again.`,
      )
    }

    // The repo being *readable* is not enough: bootstrapping ends in a force-push, so
    // the installation must have write access. A public repo the App can read but is
    // not granted (not in the App's selected-repos list, or the App lacks
    // contents:write) reads fine above but 403s on the container's push — pre-flight
    // it here so that case fails fast with an actionable message instead of failing
    // deep inside the run after a board frame has been created.
    if (!(await this.deps.githubClient.canPush(installation.installationId, ref))) {
      throw new Error(
        `The GitHub App can see ${owner}/${repoName} but does not have write access to it, so the ` +
          `bootstrapped commit cannot be pushed. Grant the App write access to this repository ` +
          `(GitHub → Settings → Applications → the cat-factory App → Configure → Repository access — ` +
          `add "${repoName}" or allow all repositories), or, in local mode, use a GitHub PAT that ` +
          `can push to it. Then run bootstrap again.`,
      )
    }
    // The run replaces the repo's contents with a fresh single-commit history, so
    // the target must be empty — except that GitHub's create-repo page often
    // prepopulates a README, .gitignore and/or license. Those are throwaway
    // boilerplate, so tolerate a repo that holds *only* them (the push force-
    // overwrites them); reject anything with real content to avoid clobbering work.
    const rootEntries = await this.deps.githubClient.listRootEntries(
      installation.installationId,
      ref,
    )
    const realContent = rootEntries.filter((entry) => !isBootstrapBoilerplate(entry))
    if (realContent.length > 0) {
      const sample = realContent
        .map((entry) => entry.path)
        .slice(0, 5)
        .join(', ')
      throw new Error(
        `Repository ${owner}/${repoName} already has content (${sample}). Bootstrapping replaces ` +
          `the repository's contents, so it needs an empty repository — or one prepopulated only ` +
          `with a README, .gitignore, license and/or AGENTS.md.`,
      )
    }

    const ghToken = await this.deps.mintInstallationToken(installation.installationId)
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: request.jobId,
      agentKind: 'architect',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })

    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    const targetCloneUrl = `${webBase}/${owner}/${repoName}.git`
    const defaultBranch = target.defaultBranch ?? 'main'

    // With a reference architecture the container clones + adapts it; without one
    // it scaffolds an empty repo from the freeform instructions alone.
    const reference = request.referenceRepo
      ? {
          owner: request.referenceRepo.owner,
          name: request.referenceRepo.name,
          cloneUrl: `${webBase}/${request.referenceRepo.owner}/${request.referenceRepo.name}.git`,
          baseBranch: 'main',
        }
      : undefined

    const targetSpec = { owner, name: repoName, cloneUrl: targetCloneUrl, defaultBranch }
    // The generic agent `repo` is the clone source: the reference when adapting one, or the
    // (uncloned) target placeholder when scaffolding from scratch. The real push destination
    // is always `bootstrap.target`, which the harness force-pushes a fresh history to.
    const repoSpec = reference
      ? {
          owner: reference.owner,
          name: reference.name,
          baseBranch: reference.baseBranch,
          cloneUrl: reference.cloneUrl,
        }
      : { owner, name: repoName, baseBranch: defaultBranch, cloneUrl: targetCloneUrl }

    // Bootstrap dispatches the generic, manifest-driven `agent` kind in `coding` mode with a
    // `bootstrap` spec (the divergent force-push to a separate target repo) — the SAME path
    // every other built-in coding agent takes, with NO bespoke `/bootstrap` harness handler.
    const body = {
      jobId: request.jobId,
      mode: 'coding',
      systemPrompt: reference ? ADAPT_SYSTEM_PROMPT : SCAFFOLD_SYSTEM_PROMPT,
      userPrompt:
        request.instructions ||
        (reference
          ? 'Adapt the reference architecture for the new service.'
          : 'Scaffold a new repository for the service.'),
      model: this.deps.model.model,
      // Bootstrap runs on the Pi harness only (proxy + session token); it does not
      // select a subscription harness. The job schema tolerates `harness` (shared
      // HarnessAuthFields), but bootstrap is the one container flow that always uses
      // the deployment's proxyable model rather than a workspace's pooled subscription
      // token — there is no per-block model selection on a not-yet-existing repo.
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      repo: repoSpec,
      branch: repoSpec.baseBranch,
      // Bootstrap always resets history to a single commit and force-pushes (the fresh
      // history shares no ancestor with the target repo's boilerplate); that is implicit
      // in the bootstrap flow, so no per-job flags are needed.
      bootstrap: {
        target: targetSpec,
        ...(reference ? {} : { fromScratch: true }),
      },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // Dispatch through the shared transport (keyed by job id), exactly like the
    // implementation executor: it hits the harness `POST /jobs` (kind `agent`), starts the
    // background job and returns once accepted; we then poll via the same transport.
    // Idempotent per job id — a replayed dispatch re-attaches rather than duplicating.
    log.info(
      { reference: reference ? `${reference.owner}/${reference.name}` : null },
      'bootstrap: dispatching container',
    )
    // A bootstrap is a single-job flow: its run IS its one job, so the run id and job
    // id coincide (no per-step fan-out into a shared container).
    await this.jobs.dispatch(
      request.workspaceId,
      { runId: request.jobId, jobId: request.jobId },
      body,
      'agent',
    )
    log.info('bootstrap: container accepted job')
    return { workspaceId: request.workspaceId, jobId: request.jobId }
  }

  /** Poll a dispatched bootstrap job, mapping the runner job view into an update. */
  async pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, {
      runId: handle.jobId,
      jobId: handle.jobId,
    })

    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      // The transport maps an evicted/crashed container (a 404 poll) to a failed
      // view; the harness redacts + labels watchdog kills. Classify both kinds so the
      // board surfaces a clear, actionable reason.
      const error = view.error ?? 'Bootstrap job failed'
      return {
        state: 'failed',
        // Prefer the harness's structured cause; fall back to the error-string regex (which
        // also catches the facade-emitted eviction, for which the harness sets no cause).
        failureKind:
          bootstrapFailureKindFromCause(view.failureCause) ?? classifyBootstrapFailure(error),
        error,
        detail: view.detail ?? view.error,
      }
    }
    // Completed: a structured `error` (e.g. push rejected) is still a failure.
    const result = view.result ?? {}
    if (result.error) {
      return {
        state: 'failed',
        failureKind: bootstrapFailureKindFromCause(view.failureCause) ?? 'agent',
        error: `Bootstrap failed: ${result.error}`,
        detail: view.detail ?? result.error,
      }
    }
    const outcome = await this.buildOutcome(handle, result.defaultBranch)
    return { state: 'done', outcome }
  }

  /**
   * Best-effort: reclaim the per-run container for a job. Releases through the same
   * transport the run dispatched to (keyed by job id) — for the Cloudflare backend
   * this SIGKILLs the per-run container and clears its live-inventory row. Safe to
   * call when the container is already gone — a release on a non-running instance is
   * a no-op, and any error is swallowed by the caller.
   */
  async stopBootstrap(handle: BootstrapJobHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, { runId: handle.jobId, jobId: handle.jobId })
    logger
      .child({ jobId: handle.jobId, workspaceId: handle.workspaceId })
      .info('bootstrap: stopped container')
  }

  /**
   * After a successful run: record the bootstrapped repo in the local projection
   * (a brand-new repo may not be there yet) and link it to the board frame, so
   * tasks dropped on that service resolve to (and are implemented against) it.
   */
  async linkRepoToBlock(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
    blockId: string,
  ): Promise<void> {
    const log = logger.child({ workspaceId, blockId })
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${workspaceId}' is not connected to GitHub`)
    }
    const repo = await this.deps.githubClient.getRepo(installation.installationId, {
      owner: outcome.owner,
      repo: outcome.name,
    })
    await this.deps.repoRepository.upsertMany(workspaceId, [repo])
    await this.deps.repoRepository.linkBlock(workspaceId, repo.githubId, blockId)
    log.info(
      { repo: `${outcome.owner}/${outcome.name}`, githubId: repo.githubId },
      'bootstrap: linked repo to service frame',
    )
  }

  /** Construct the success outcome from the installation + the recorded job's repo name. */
  private async buildOutcome(
    handle: BootstrapJobHandle,
    resultDefaultBranch: string | undefined,
  ): Promise<BootstrapRepoOutcome> {
    const installation = await this.deps.installationRepository.getByWorkspace(handle.workspaceId)
    if (!installation)
      throw new Error(`Workspace '${handle.workspaceId}' is not connected to GitHub`)
    const record = await this.deps.bootstrapJobRepository.get(handle.workspaceId, handle.jobId)
    if (!record) throw new Error(`Bootstrap job '${handle.jobId}' not found`)
    const owner = installation.accountLogin
    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    return {
      repoUrl: `${webBase}/${owner}/${record.repoName}`,
      owner,
      name: record.repoName,
      defaultBranch: resultDefaultBranch ?? 'main',
    }
  }
}

/**
 * Whether a repo's root entry is throwaway boilerplate GitHub commonly prepopulates
 * at create time — a README, a `.gitignore`, or a license file — or an `AGENTS.md`
 * that a prior (incomplete) bootstrap attempt left behind. The push force-overwrites
 * all of these, so tolerating them lets bootstrap re-run over a repo seeded only with
 * agent context. Only top-level files qualify (a directory means real project
 * content), and the match is case-insensitive across the usual extensions
 * (`README.md`, `LICENSE.txt`, …).
 */
function isBootstrapBoilerplate(entry: RepoEntry): boolean {
  if (entry.type !== 'file') return false
  const name = entry.path.toLowerCase()
  return (
    name === '.gitignore' ||
    name === 'readme' ||
    name.startsWith('readme.') ||
    name === 'license' ||
    name.startsWith('license.') ||
    name === 'licence' ||
    name.startsWith('licence.') ||
    name === 'agents.md'
  )
}

/**
 * Classify a failed bootstrap job's error message into a {@link BootstrapFailureKind}
 * the board can act on. The transport maps an evicted/crashed container (a 404 poll)
 * to a failed view whose message ends "(container evicted or crashed)"; the harness
 * redacts + labels its watchdog kills ("…no agent activity…", "…exceeded max
 * duration…"). Everything else is an ordinary agent fault.
 */
function classifyBootstrapFailure(error: string): BootstrapFailureKind {
  if (/evicted or crashed/i.test(error)) return 'evicted'
  if (/inactivity|no agent activity|max duration/i.test(error)) return 'timeout'
  return 'agent'
}

/**
 * Map the harness's STRUCTURED failure cause onto a {@link BootstrapFailureKind}, preferred
 * over {@link classifyBootstrapFailure}'s error-string regex when present. Returns undefined
 * for an absent/unknown cause so the caller falls back to the regex (older harness image) —
 * crucially including container eviction, which has NO harness cause (the transport emits the
 * "evicted or crashed" string), so it correctly falls through to the regex's `evicted`.
 */
function bootstrapFailureKindFromCause(
  cause: string | undefined,
): BootstrapFailureKind | undefined {
  switch (cause) {
    case 'inactivity-timeout':
    case 'max-duration':
      return 'timeout'
    case 'agent':
    case 'git':
    case 'api':
    case 'no-usable-output':
    case 'no-changes':
      return 'agent'
    default:
      return undefined
  }
}
