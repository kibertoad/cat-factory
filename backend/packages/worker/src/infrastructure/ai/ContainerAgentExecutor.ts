import {
  type AgentExecutor,
  type AgentRouting,
  type AgentRunContext,
  type AgentRunResult,
  type ModelRef,
  composeSystemPrompt,
  resolveAgentConfig,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/core'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { ImplementationContainer } from '../containers/ImplementationContainer'
import type { ContainerSessionService } from '../containers/ContainerSessionService'
// The GitHub repo a run should be implemented against, resolved from the
// workspace's installation + connected repos (see container.ts).
export interface RepoTarget {
  installationId: number
  owner: string
  name: string
  baseBranch: string
}

export type ResolveRepoTarget = (workspaceId: string, blockId: string) => Promise<RepoTarget | null>

export type MintInstallationToken = (installationId: number) => Promise<string>

export interface ContainerAgentExecutorDependencies {
  /** The Durable Object namespace backing the per-run container instances. */
  container: DurableObjectNamespace<ImplementationContainer>
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref (direct flavour). */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  /** Resolve which repo (and installation) a run targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Mint a short-lived GitHub installation token for cloning + opening the PR. */
  mintInstallationToken: MintInstallationToken
  /** Mints the signed LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /**
   * Public base URL of the Worker's OpenAI-compatible LLM proxy, including the
   * `/v1` suffix — Pi posts to `${proxyBaseUrl}/chat/completions`.
   */
  proxyBaseUrl: string
}

/** The result the harness returns from `POST /run`. */
interface RunResult {
  prUrl?: string
  branch?: string
  summary?: string
  error?: string
}

/**
 * An {@link AgentExecutor} that performs implementation work in a real sandbox:
 * it spins up a per-run Cloudflare Container running the Pi coding agent, feeds
 * it the block's composed prompt fragments as context, and has it clone the
 * repo, implement the block, push a branch and open a PR.
 *
 * Secrets never reach the container image. Provider keys stay in the Worker; the
 * container reaches models only through the Worker's LLM proxy using a
 * short-lived, model-locked session token, and clones/pushes with a short-lived
 * GitHub installation token — both handed over per job. Token usage is metered
 * by the proxy (the single metering point), so this executor reports no `usage`
 * to avoid double-counting in the execution engine.
 */
export class ContainerAgentExecutor implements AgentExecutor {
  constructor(private readonly deps: ContainerAgentExecutorDependencies) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const { workspaceId, executionId } = context
    const blockId = context.block.id
    if (!workspaceId || !executionId || !blockId) {
      throw new Error('ContainerAgentExecutor requires workspaceId, executionId and block.id')
    }

    // Lock the model to a direct OpenAI-compatible provider — the proxy only
    // forwards those, and locking it here stops the container choosing another.
    const config = resolveAgentConfig(this.deps.agentRouting, context.agentKind)
    const ref = this.deps.resolveBlockModel(context.block.modelId) ?? config.ref
    if (!isProxyableProvider(ref.provider)) {
      throw new Error(
        `Container implementation needs a direct OpenAI-compatible model; ` +
          `'${ref.provider}' is not supported. Configure a provider key ` +
          `(QWEN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY) and pick that model on the block.`,
      )
    }

    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!repo) {
      throw new Error(`No connected GitHub repository found for workspace '${workspaceId}'`)
    }

    const ghToken = await this.deps.mintInstallationToken(repo.installationId)
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId,
      executionId,
      agentKind: context.agentKind,
      provider: ref.provider,
      model: ref.model,
    })

    // The "extra context" Pi runs with: the build-phase role plus the block's
    // selected best-practice fragments, exactly as the inline executor composes.
    const systemPrompt = composeSystemPrompt(
      systemPromptFor(context.agentKind),
      context.block.fragmentIds,
    )
    const userPrompt = userPromptFor(context)
    const headBranch = `cat-factory/${blockId}-${shortId()}`

    const body = {
      systemPrompt,
      userPrompt,
      model: ref.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      repo: {
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
      },
      headBranch,
      pr: {
        title: `${context.block.title} (${context.pipelineName})`,
        body: prBody(context),
      },
    }

    // Address the container instance dedicated to this run (one Durable Object id
    // per execution → one container), then dispatch the job. The base
    // Container.fetch proxies the request to the harness on its default port.
    const stub = this.deps.container.get(this.deps.container.idFromName(executionId))
    const res = await stub.fetch('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new Error(`Implementation container failed (HTTP ${res.status}): ${detail}`)
    }
    const result = (await res.json()) as RunResult
    if (result.error) throw new Error(`Implementation failed: ${result.error}`)

    const summary = result.summary?.trim() || 'Implementation complete.'
    const output = result.prUrl ? `${summary}\n\nPR: ${result.prUrl}` : summary
    return { output, model: `${ref.provider}:${ref.model}` }
  }
}

/** Providers the LLM proxy can forward to (OpenAI Chat Completions-compatible). */
function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'qwen' ||
    provider === 'deepseek' ||
    provider === 'moonshot' ||
    provider === 'openai'
  )
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8)
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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(no body)'
  }
}
