import type {
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  GitHubClient,
  GitHubInstallationRepository,
  ModelRef,
  RepoBootstrapper,
  RepoEntry,
} from '@cat-factory/core'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from '../containers/ImplementationContainer'
import type { ContainerSessionService } from '../containers/ContainerSessionService'

// Synchronous request/response (unlike `/run`); cap the Worker's wait so a wedged
// container can't block forever. The harness's shared git timeouts bound the
// underlying git operations too.
const CONTAINER_SYNC_TIMEOUT_MS = 30 * 60_000

export interface ContainerRepoBootstrapperDependencies {
  /** The Durable Object namespace backing the per-run container instances. */
  container: DurableObjectNamespace<ImplementationContainer>
  /** Resolve which GitHub installation a workspace's repos live under. */
  installationRepository: GitHubInstallationRepository
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

  async bootstrap(request: BootstrapRepoRequest): Promise<BootstrapRepoOutcome> {
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
          `with a README, .gitignore and/or license.`,
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
    // implementation container. The base Container.fetch proxies to the harness.
    const stub = this.deps.container.get(this.deps.container.idFromName(request.jobId))
    const res = await stub.fetch('http://container/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTAINER_SYNC_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Bootstrap container failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    const result = (await res.json()) as BootstrapContainerResult
    if (result.error) throw new Error(`Bootstrap failed: ${result.error}`)

    return {
      repoUrl: `${webBase}/${owner}/${repoName}`,
      owner,
      name: repoName,
      defaultBranch: result.defaultBranch ?? defaultBranch,
    }
  }
}

/**
 * Whether a repo's root entry is throwaway boilerplate GitHub commonly prepopulates
 * at create time — a README, a `.gitignore`, or a license file. Only top-level
 * files qualify (a directory means real project content), and the match is
 * case-insensitive across the usual extensions (`README.md`, `LICENSE.txt`, …).
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
    name.startsWith('licence.')
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
