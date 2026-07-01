import type {
  AgentRunRepository,
  ExecutionRepository,
  ResolveBinaryArtifactStore,
  ConsensusSessionRepository,
  ResolveRunRepoContext,
  VcsIdentityRegistry,
  VcsWebhookSink,
} from '@cat-factory/kernel'
import type {
  ApiKeyService,
  EnvironmentBackendRegistry,
  LocalModelEndpointService,
  LocalSettingsService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerBackendRegistry,
  UserSecretService,
} from '@cat-factory/integrations'
import type { Core } from '@cat-factory/orchestration'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import type { SessionPayload, SessionUser } from '../auth/signing.js'
import type { AppConfig } from '../config/types.js'
import type { PersistenceRegistry } from '../persistence/rpc.js'
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
   * The execution-scoped run repository (`kind='execution'`). Exposed alongside the
   * kind-spanning {@link agentRunRepository} so the cross-runtime conformance suite can
   * assert the optimistic-concurrency `compareAndSwap` parity on every facade.
   */
  executionRepository: ExecutionRepository
  /**
   * Consensus session transcripts (the optional `@cat-factory/consensus` mechanism's
   * observability surface). Present only when the facade wired the repository; the
   * consensus read endpoint 404s when absent.
   */
  consensusSessionRepository?: ConsensusSessionRepository
  /** Per-facade runtime seams (real-time delivery, …) the shared controllers use. */
  gateways: RuntimeGateways
  /**
   * Facade-owned resources to release on graceful shutdown (e.g. the local mothership
   * boot's `node:sqlite` credential-store handle). The boot path invokes it from its
   * SIGTERM/SIGINT handler; absent on facades that own no extra disposable resource.
   */
  onShutdown?: () => void | Promise<void>
  /**
   * The app-owned backend registries (kind → provider), built by the facade via
   * `createBackendRegistries()`. The workspace snapshot reads `.labelled()` off these for
   * the SPA's provider-connect backend-kind selectors (so a deployment-registered custom
   * kind shows up). Always present — the facade attaches them alongside `config`/`gateways`.
   */
  environmentBackendRegistry: EnvironmentBackendRegistry
  runnerBackendRegistry: RunnerBackendRegistry
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
   * Resolves the binary-artifact store (UI screenshots + reference design images) for a
   * workspace's account — the blob backend is configured per-account in the UI (filesystem /
   * S3 on Node/local; R2 / S3 on the Worker). Drives the artifact ingest/blob/list
   * controller, the UI-tester pre/post-ops, and the visual-confirmation gate. Absent, or
   * resolving to null (the account configured no storage) ⇒ the controller 503s and the gate
   * is a pass-through.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * True ONLY when a self-hosted runner pool is the sole execution backend for container agents
   * (an unregistered pool then means NO agent can run) — i.e. this facade has no built-in per-run
   * container runtime. Set by remote/stock Node; unset (falsy) on Cloudflare (built-in per-run
   * containers) and local mode (per-run host containers), where the wired runner surface is an
   * OPTIONAL alternate target. The infra-setup snapshot projection reads it so the "agent executor
   * not configured" banner fires only where the pool is genuinely mandatory.
   */
  agentExecutorRequiresRunnerPool?: boolean
  /**
   * Consumer of normalised inbound VCS webhook events (the neutral ingest route's
   * `POST /vcs/:provider/webhooks` hands verified+mapped events here). Present only when a
   * facade wires a sink; absent ⇒ the route still verifies + maps + acks but drops the event
   * (projection into provider-aware persistence is the follow-up to the GitHub-keyed tables).
   */
  vcsWebhookSink?: VcsWebhookSink
  /**
   * Source-control PAT-login resolvers, keyed by provider. Present only on the local-mode
   * facade (a developer logs in as the account a GitHub/GitLab PAT belongs to); hosted
   * facades leave it undefined and the `/auth/pat` endpoint 503s — they authenticate via
   * OAuth instead. Each entry carries the provider's resolver and, when the deployment set
   * a PAT in env, the token enabling one-click login. See `@cat-factory/kernel`'s
   * `VcsIdentityRegistry`.
   */
  vcsIdentity?: VcsIdentityRegistry
  /**
   * The reflective repository registry the mothership-mode machine API
   * (`POST /internal/persistence`) dispatches over: repo name → repo instance. Attached by a
   * facade acting as a MOTHERSHIP (both Node + Cloudflare), so a mothership-mode local node
   * with no database can forward its org/durable repository calls here. Absent on a node that
   * is not a mothership ⇒ the persistence endpoint 503s. See `../persistence/rpc.ts`.
   */
  repositories?: PersistenceRegistry
  /**
   * Local-mode mothership login seam: exchange a mothership SESSION token for a machine token
   * and cache it locally, so the node can talk to the mothership without a pasted static token.
   * Wired ONLY on the local-mode facade in mothership mode; `POST /local/mothership/connect`
   * 503s when absent. See docs/initiatives/mothership-mode.md.
   */
  mothershipConnect?: MothershipConnector
}

/** Exchanges a mothership session for a cached machine token (local-mode mothership login). */
export interface MothershipConnector {
  connect(
    session: string,
  ): Promise<
    | { ok: true; accountIds: string[]; exp: number; user: SessionUser }
    | { ok: false; status: number; message: string }
  >
}

/** Hono generics shared by the cross-runtime controllers (Variables only — no Bindings). */
export type AppEnv = {
  Variables: {
    container: ServerContainer
    /** The authenticated user, set by `requireAuth` when auth is enabled. */
    user?: SessionPayload
  }
}
