import type {
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
} from '@cat-factory/core'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from '../containers/ImplementationContainer'
import type { ContainerSessionService } from '../containers/ContainerSessionService'
import { logger } from '../observability/logger'

// `/bootstrap` and `/jobs/{id}` are quick (start a background job / read its
// state), like `/run`: the long bootstrap work is bounded container-side by the
// job's inactivity + max-duration watchdogs, so these get a short timeout.
const DISPATCH_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 30_000

export interface ContainerRepoBootstrapperDependencies {
  /** The Durable Object namespace backing the per-run container instances. */
  container: DurableObjectNamespace<ImplementationContainer>
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

/** The /bootstrap response from the harness. */
interface BootstrapContainerResult {
  defaultBranch?: string
  summary?: string
  error?: string
}

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
  constructor(private readonly deps: ContainerRepoBootstrapperDependencies) {}

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

    const body = {
      jobId: request.jobId,
      systemPrompt: reference ? ADAPT_SYSTEM_PROMPT : SCAFFOLD_SYSTEM_PROMPT,
      instructions:
        request.instructions ||
        (reference
          ? 'Adapt the reference architecture for the new service.'
          : 'Scaffold a new repository for the service.'),
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      ...(reference ? { reference } : {}),
      target: {
        owner,
        name: repoName,
        cloneUrl: targetCloneUrl,
        defaultBranch,
      },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // One container instance per job (keyed by job id), mirroring the per-run
    // implementation container. POST /bootstrap starts the background job and
    // returns immediately; we then poll GET /jobs/{id}. The base Container.fetch
    // proxies to the harness.
    const stub = this.deps.container.get(this.deps.container.idFromName(request.jobId))
    log.info(
      { reference: reference ? `${reference.owner}/${reference.name}` : null },
      'bootstrap: dispatching container',
    )
    const res = await stub.fetch('http://container/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(
        `Bootstrap container dispatch failed (HTTP ${res.status}): ${await safeText(res)}`,
      )
    }
    log.info('bootstrap: container accepted job')
    return { workspaceId: request.workspaceId, jobId: request.jobId }
  }

  /** Poll a dispatched bootstrap job, mapping the harness job view into an update. */
  async pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate> {
    const stub = this.deps.container.get(this.deps.container.idFromName(handle.jobId))
    const res = await stub.fetch(`http://container/jobs/${encodeURIComponent(handle.jobId)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    })
    if (res.status === 404) {
      // The job/container vanished (eviction or crash): report failed so the run
      // stops with a clear, classified reason the board can act on.
      return {
        state: 'failed',
        failureKind: 'evicted',
        error: 'Bootstrap job not found (container evicted or crashed)',
      }
    }
    if (!res.ok) {
      throw new Error(`Bootstrap job poll failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    const view = (await res.json()) as {
      state: 'running' | 'done' | 'failed'
      progress?: { completed: number; inProgress: number; total: number }
      result?: BootstrapContainerResult
      error?: string
    }

    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      // The harness redacts + labels watchdog kills ("…no agent activity…",
      // "…exceeded max duration…"); classify those as `timeout`, the rest `agent`.
      const error = view.error ?? 'Bootstrap job failed'
      const failureKind = /inactivity|no agent activity|max duration/i.test(error)
        ? ('timeout' as const)
        : ('agent' as const)
      return { state: 'failed', failureKind, error, detail: view.error }
    }
    // Completed: a structured `error` (e.g. push rejected) is still a failure.
    const result = view.result ?? {}
    if (result.error) {
      return {
        state: 'failed',
        failureKind: 'agent',
        error: `Bootstrap failed: ${result.error}`,
        detail: result.error,
      }
    }
    const outcome = await this.buildOutcome(handle, result.defaultBranch)
    return { state: 'done', outcome }
  }

  /**
   * Best-effort: reclaim the per-run container for a job. Addresses the same
   * Durable Object instance the run used (keyed by job id) and asks it to shut its
   * container down. Safe to call when the container is already gone — a stop on a
   * non-running instance is a no-op, and any error is swallowed by the caller.
   */
  async stopBootstrap(handle: BootstrapJobHandle): Promise<void> {
    const stub = this.deps.container.get(this.deps.container.idFromName(handle.jobId))
    await stub.shutdown()
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

/** Providers the LLM proxy can serve (mirrors ContainerAgentExecutor). */
function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'workers-ai' ||
    provider === 'qwen' ||
    provider === 'deepseek' ||
    provider === 'moonshot' ||
    provider === 'openai'
  )
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}
