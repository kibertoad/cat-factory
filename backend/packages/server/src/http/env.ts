import type {
  AgentRunRepository,
  BinaryArtifactStore,
  ConsensusSessionRepository,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import type {
  ApiKeyService,
  LocalModelEndpointService,
  LocalSettingsService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  UserSecretService,
} from '@cat-factory/integrations'
import type { Core } from '@cat-factory/orchestration'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import type { SessionPayload } from '../auth/signing.js'
import type { AppConfig } from '../config/types.js'
import type { RuntimeGateways } from '../runtime/gateways.js'

// The runtime-neutral request context shared by every controller. A facade builds a
// `ServerContainer` per request (the domain `Core` plus the resolved config and the
// kind-spanning agent-run repository) and stashes it on the Hono context; controllers
// resolve their services from `c.get('container')`. The facade's own Hono app may add
// runtime `Bindings` (e.g. the Worker's `Env`) on top of these Variables.

export interface ServerContainer extends Core {
  config: AppConfig
  /** Kind-spanning view over agent_runs (retry dispatch + the cron sweeper). */
  agentRunRepository: AgentRunRepository
  /**
   * Consensus session transcripts (the optional `@cat-factory/consensus` mechanism's
   * observability surface). Present only when the facade wired the repository; the
   * consensus read endpoint 404s when absent.
   */
  consensusSessionRepository?: ConsensusSessionRepository
  /** Per-facade runtime seams (real-time delivery, …) the shared controllers use. */
  gateways: RuntimeGateways
  /**
   * Resolve a block's run repo (installation + repo + default branch) bound to a
   * checkout-free {@link RepoFiles}. The engine uses it to run a registered kind's
   * pre/post-ops; the shared service-spec read controller reuses it to read the sharded
   * `spec/` artifact off the default branch. Present only when GitHub is wired (the same
   * composition both facades already build via `makeResolveRunRepoContext`); absent → the
   * spec endpoint returns an empty view.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Resolve the repo (installation + owner/name + default branch) linked to a
   * block's enclosing service frame — the same ancestry walk the container executor
   * and the CI/merge gates use. The task-search controller uses it to scope a
   * GitHub-issue search to the service's repo (and to refuse the search when the
   * service isn't linked to a repo). Present only when GitHub is wired.
   */
  resolveRepoTarget?: ResolveRepoTarget
  /**
   * The workspace subscription-token pool (Claude Code / Codex credentials).
   * Present only when the facade wired the provider-subscription repository.
   */
  subscriptions?: ProviderSubscriptionService
  /**
   * The per-user individual-usage subscription store (Claude). Present only when the
   * facade wired the personal-subscription repositories (needs ENCRYPTION_KEY). Drives
   * the personal-credential controller + the run activation the executor leases.
   */
  personalSubscriptions?: PersonalSubscriptionService
  /**
   * The direct-provider API-key pool (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot),
   * scoped account/workspace/user. Present only when the facade wired the
   * provider-api-key repository (needs ENCRYPTION_KEY). Drives the API-key
   * controller, the per-scope model-provider resolver, and the LLM proxy's key lease.
   */
  apiKeys?: ApiKeyService
  /**
   * Whether the opt-in Cloudflare Workers AI provider lib is registered for this
   * deployment (binding on the Worker, REST account/token on Node). When false, the
   * `workers-ai` provider is unavailable and `cloudflare`-flavour catalog models are
   * not selectable.
   */
  cloudflareModelsEnabled?: boolean
  /**
   * The deployment's direct-provider base-URL resolver (env override → built-in default,
   * or null when none — e.g. an unconfigured operator-hosted LiteLLM gateway). The model
   * catalog uses it to gate selectability: an OpenAI-compatible provider is only
   * selectable once its base URL resolves, mirroring what the dispatch path requires.
   */
  baseUrlFor?: (provider: string) => string | null | undefined
  /**
   * The per-USER locally-run model endpoints store (Ollama / LM Studio / llama.cpp /
   * vLLM / custom OpenAI-compatible runners). Present only when the facade wired the
   * local-model repository (needs ENCRYPTION_KEY). Drives the local-runner controller,
   * the per-user model catalog, and the LLM proxy's base-URL/key resolution for a
   * locally-run model — resolved by the run initiator.
   */
  localModelEndpoints?: LocalModelEndpointService
  /**
   * The per-USER generic secret store (a GitHub PAT today; future repository/provider
   * tokens as new kinds). Present only when the facade wired the user-secret repository
   * (needs ENCRYPTION_KEY). Drives the user-secret controller and `ResolveUserGitHubToken`.
   */
  userSecrets?: UserSecretService
  /**
   * The per-WORKSPACE OpenRouter dynamic-catalog store. Present only when the facade wired
   * the OpenRouter-catalog repository + the API-key pool (needs ENCRYPTION_KEY). Drives the
   * OpenRouter catalog controller (browse/enable), the per-workspace model catalog's dynamic
   * OpenRouter entries, and the spend price overlay for those models.
   */
  openRouterCatalog?: OpenRouterCatalogService
  /**
   * The local-mode operational settings (warm-container-pool sizing + per-repo checkout
   * reuse), a per-deployment singleton that replaced the `LOCAL_POOL_*` / `HARNESS_*` env
   * vars. Present ONLY on the local-mode facade (where the Docker-family runner can pool);
   * the dedicated local-mode settings panel reads/writes it through the local-settings
   * controller, and the local runner transport resolves its pool config from it. Absent on
   * the Worker / stock Node facades, so the controller 503s there.
   */
  localSettings?: { service: LocalSettingsService }
  /**
   * The binary-artifact store (UI screenshots + reference design images) backing the
   * visual-confirmation gate. Present only when the facade configured blob storage
   * (R2 on the Worker; a Postgres-`bytea`/S3 backend on Node/local). Drives the
   * artifact ingest/blob/list controller, the UI-tester pre/post-ops, and the gate.
   * Absent ⇒ the controller 503s and the gate is a pass-through.
   */
  binaryArtifactStore?: BinaryArtifactStore
}

/** Hono generics shared by the cross-runtime controllers (Variables only — no Bindings). */
export type AppEnv = {
  Variables: {
    container: ServerContainer
    /** The authenticated user, set by `requireAuth` when auth is enabled. */
    user?: SessionPayload
  }
}
