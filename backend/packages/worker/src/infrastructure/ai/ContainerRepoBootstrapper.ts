import type {
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  GitHubClient,
  GitHubInstallationRepository,
  ModelRef,
  RepoBootstrapper,
} from '@cat-factory/core'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from '../containers/ImplementationContainer'
import type { ContainerSessionService } from '../containers/ContainerSessionService'

export interface ContainerRepoBootstrapperDependencies {
  /** The Durable Object namespace backing the per-run container instances. */
  container: DurableObjectNamespace<ImplementationContainer>
  /** Resolve which GitHub installation a workspace's repos live under. */
  installationRepository: GitHubInstallationRepository
  /** Creates the new repository (under the installation account). */
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

/** The role prompt the bootstrapper agent runs under inside the container. */
const BOOTSTRAP_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You have a fresh clone of a reference ' +
  'architecture (a base/golden-template repository). Adapt it in place into the ' +
  'new service per the instructions: rename packages/modules, remove pieces that ' +
  'do not apply, update README and metadata, and leave the project building. Make ' +
  'focused, idiomatic changes that match the existing structure. Do not invent ' +
  'unrelated features.'

/** The /bootstrap response from the harness. */
interface BootstrapContainerResult {
  defaultBranch?: string
  summary?: string
  error?: string
}

/**
 * A {@link RepoBootstrapper} that performs the side-effecting half of a
 * "bootstrap repo" run: it creates the new GitHub repository, then spins up a
 * per-run Cloudflare Container that clones the reference architecture, has the
 * bootstrapper agent adapt it per the instructions, and pushes the result as the
 * new repo's initial commit.
 *
 * Secrets never reach the container image: the per-job GitHub installation token
 * and the model-locked LLM-proxy session token are minted here and handed over in
 * the dispatch body, exactly as the implementation executor does.
 */
export class ContainerRepoBootstrapper implements RepoBootstrapper {
  constructor(private readonly deps: ContainerRepoBootstrapperDependencies) {}

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

    // Create the new repository under the installation account.
    const owner = installation.accountLogin
    const created = await this.deps.githubClient.createRepo(installation.installationId, {
      owner,
      ownerType: installation.targetType,
      name: request.target.name,
      description: request.target.description,
      private: request.target.private,
      // Push the bootstrapped contents as the first commit, so start empty.
      autoInit: false,
    })

    const ghToken = await this.deps.mintInstallationToken(installation.installationId)
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: request.jobId,
      agentKind: 'architect',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })

    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    const referenceCloneUrl = `${webBase}/${request.referenceRepo.owner}/${request.referenceRepo.name}.git`
    const targetCloneUrl = `${webBase}/${owner}/${created.name}.git`
    const defaultBranch = created.defaultBranch ?? 'main'

    const body = {
      systemPrompt: BOOTSTRAP_SYSTEM_PROMPT,
      instructions: request.instructions || 'Adapt the reference architecture for the new service.',
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      reference: {
        owner: request.referenceRepo.owner,
        name: request.referenceRepo.name,
        cloneUrl: referenceCloneUrl,
        baseBranch: 'main',
      },
      target: {
        owner,
        name: created.name,
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
    })
    if (!res.ok) {
      throw new Error(`Bootstrap container failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    const result = (await res.json()) as BootstrapContainerResult
    if (result.error) throw new Error(`Bootstrap failed: ${result.error}`)

    return {
      repoUrl: `${webBase}/${owner}/${created.name}`,
      owner,
      name: created.name,
      defaultBranch: result.defaultBranch ?? defaultBranch,
    }
  }
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
