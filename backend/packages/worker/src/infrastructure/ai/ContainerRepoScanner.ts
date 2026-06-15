import {
  boardScanLogic,
  type GitHubInstallationRepository,
  type ModelRef,
  type RepoScanner,
  type ScanRepoRequest,
  type ScannedBlueprint,
} from '@cat-factory/core'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from '../containers/ImplementationContainer'
import type { ContainerSessionService } from '../containers/ContainerSessionService'

// Unlike `/run`, scan/bootstrap stay synchronous request/response. This caps how
// long the Worker will wait so a wedged container can't block the caller forever;
// the harness's shared git timeouts bound the underlying git operations too.
const CONTAINER_SYNC_TIMEOUT_MS = 30 * 60_000

export interface ContainerRepoScannerDependencies {
  /** The Durable Object namespace backing the per-run container instances. */
  container: DurableObjectNamespace<ImplementationContainer>
  /** Resolve which GitHub installation a workspace's repos live under. */
  installationRepository: GitHubInstallationRepository
  /** Mints a short-lived GitHub installation token for the read-only clone. */
  mintInstallationToken: (installationId: number) => Promise<string>
  /** Mints the signed, model-locked LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /** Model the scanner agent runs with (must be proxyable). */
  model: ModelRef
  /** Public base URL of the Worker's OpenAI-compatible LLM proxy, including `/v1`. */
  proxyBaseUrl: string
  /** GitHub REST base for resolving the repo (Enterprise / api.github.com). */
  githubApiBase?: string
  /** Web base for building the repo clone URL (defaults to github.com). */
  webBaseUrl?: string
}

/** The role prompt the scanner agent runs under inside the container. */
const SCAN_SYSTEM_PROMPT =
  'You are a software architect mapping an existing repository. You have a fresh, ' +
  'read-only clone. Decompose it into ONE top-level service, the modules inside it, ' +
  'and the features within each module. Anchor every node to the codebase with ' +
  'explicit repo-relative file/directory references. Keep names short and ' +
  'descriptive; group by domain, not by file type. Respond with ONLY a JSON object ' +
  'of shape {"type","name","summary","references":[],"modules":[{"name","summary",' +
  '"references":[],"features":[{"title","summary","references":[]}]}]} — no prose, ' +
  'no code fences.'

/** The /scan response from the harness: the raw blueprint JSON (or an error). */
interface ScanContainerResult {
  service?: unknown
  error?: string
}

/**
 * A {@link RepoScanner} that performs the side-effecting half of a "scan
 * repository" run: it spins up a per-run Cloudflare Container that clones the
 * repository read-only, has the scanner agent decompose it into the canonical
 * service → modules → features blueprint (with codebase references), and returns
 * that structure. The agent's JSON is coerced into a well-formed tree here.
 *
 * Secrets never reach the container image: the per-run GitHub installation token
 * and the model-locked LLM-proxy session token are minted here and handed over in
 * the dispatch body, exactly as the implementation executor and bootstrapper do.
 */
export class ContainerRepoScanner implements RepoScanner {
  constructor(private readonly deps: ContainerRepoScannerDependencies) {}

  async scan(request: ScanRepoRequest): Promise<ScannedBlueprint> {
    const installation = await this.deps.installationRepository.getByWorkspace(request.workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${request.workspaceId}' is not connected to GitHub`)
    }

    if (!isProxyableProvider(this.deps.model.provider)) {
      throw new Error(
        `Repository scanning needs a model the LLM proxy can serve ` +
          `(Workers AI, or a direct OpenAI-compatible provider); ` +
          `'${this.deps.model.provider}' is not supported.`,
      )
    }

    const ghToken = await this.deps.mintInstallationToken(installation.installationId)
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: `scan-${request.repo.owner}-${request.repo.name}`,
      agentKind: 'architect',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })

    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    const cloneUrl = `${webBase}/${request.repo.owner}/${request.repo.name}.git`

    const body = {
      systemPrompt: SCAN_SYSTEM_PROMPT,
      instructions: request.instructions || 'Map the repository into the blueprint structure.',
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      repo: {
        owner: request.repo.owner,
        name: request.repo.name,
        cloneUrl,
      },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // One container instance per repo scan (keyed by owner/name), mirroring the
    // per-run implementation and bootstrap containers.
    const key = `scan-${request.repo.owner}/${request.repo.name}`
    const stub = this.deps.container.get(this.deps.container.idFromName(key))
    const res = await stub.fetch('http://container/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTAINER_SYNC_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Scan container failed (HTTP ${res.status}): ${await safeText(res)}`)
    }
    const result = (await res.json()) as ScanContainerResult
    if (result.error) throw new Error(`Scan failed: ${result.error}`)

    const service = boardScanLogic.coerceService(result.service, request.repo.name)
    if (!service) {
      throw new Error('Scan produced no usable blueprint')
    }
    return { source: 'llm', service }
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
