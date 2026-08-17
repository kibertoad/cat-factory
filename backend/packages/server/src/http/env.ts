import type { Context } from 'hono'
import type {
  AgentRunRepository,
  AuthAttemptRepository,
  ExecutionRepository,
  MachineNodeRepository,
  NotificationChannel,
  PlatformAlertSink,
  ResolveBinaryArtifactStore,
  ConsensusSessionRepository,
  ResolveRepoFilesForCoords,
  ResolveRunRepoContext,
  LocalVcsSetup,
  Logger,
  SealedSecretInventory,
  SecretCipher,
  ToolSecretResolver,
  UserRepoAccessRepository,
  VcsIdentityRegistry,
  VcsProviderRegistry,
  VcsWebhookSink,
  WorkspacePermission,
  WorkspaceRole,
} from '@cat-factory/kernel'
import type {
  ApiKeyService,
  EnvironmentBackendRegistry,
  LocalModelEndpointService,
  LocalSettingsService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  NotificationWebhookService,
  McpAuthorizationServer,
  PublicApiKeyService,
  RunnerBackendRegistry,
  TestSecretsService,
  CapabilityCredentialsService,
  McpOAuthService,
  ValidationConfigService,
  UserSecretService,
} from '@cat-factory/integrations'
import type { Core } from '@cat-factory/orchestration'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { InitiativePresetRegistry } from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import type { ListWorkspaceRunRepos } from '../agents/resolveRepoTarget.js'
import type { SessionPayload, SessionUser } from '../auth/signing.js'
import type { AppConfig } from '../config/types.js'
import type { MachineEventRelay } from '../events/machineEvents.js'
import type { PersistenceRegistry } from '../persistence/rpc.js'
import type { RuntimeGateways, WebSearchUpstream } from '../runtime/gateways.js'

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
   * A DEPLOYMENT-configured, trusted web-search upstream the search proxy falls back to when
   * a run's account has no web-search config of its own. Built by the facade from its own
   * `WEB_SEARCH_*` env (local mode defaults it on, pointing at a self-hosted SearXNG); unlike
   * the account-supplied path it may target a loopback/LAN host (it's constructed `trusted`).
   * Absent on facades that don't configure one (e.g. Cloudflare) — then the proxy behaves
   * exactly as before (account path only, else an empty result set).
   */
  defaultWebSearchUpstream?: WebSearchUpstream
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
   * The app-owned agent-kind registry (built-ins + any a deployment registered by
   * reference). The workspace snapshot reads it to project the custom-kind palette + the
   * agent-config catalog; the controllers thread the SAME instance the engine + executors
   * use. Always present — the facade attaches it alongside the backend registries.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned initiative-preset registry (built-in generic / docs-refresh / tech-migration
   * plus any a deployment registered by reference). The workspace snapshot reads its `descriptors()`
   * for the SPA's initiative picker + form; the preset-probe endpoint reads `.get(id)?.detect`. The
   * controllers thread the SAME instance the initiative services use. Always present — the facade
   * attaches it (via the `Core` spread) alongside the agent-kind registry.
   */
  initiativePresetRegistry: InitiativePresetRegistry
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
   * The BLOCK-LESS sibling of {@link resolveRunRepoContext}: the same checkout-free
   * {@link RepoFiles}, from repo coordinates a caller names.
   * `GET /api/v1/repos/:owner/:name/contents?path=` reads through it (the path is a QUERY value, not
   * a path segment: see the contract), so the public file read is scoped to what this workspace has
   * LINKED rather than to whatever the deployment's credential can reach. Present only when a VCS is
   * wired (both facades compose it with `makeResolveRepoFilesForCoords`); absent → the read is a 503.
   */
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /**
   * Resolve the repo (installation + owner/name + default branch) linked to a
   * block's enclosing service frame — the same ancestry walk the container executor
   * and the CI/merge gates use. The task-search controller uses it to scope a
   * GitHub-issue search to the service's repo (and to refuse the search when the
   * service isn't linked to a repo). Present only when GitHub is wired.
   */
  resolveRepoTarget?: ResolveRepoTarget
  /**
   * Every repository this workspace's runs would push to (its mounted services' repo links),
   * the block-free counterpart of {@link resolveRepoTarget}. Present whenever GitHub is wired,
   * built from the same repositories beside it on each facade.
   *
   * The credential check reads it for both of its questions. WHETHER to judge a stored token
   * at all: a board whose services target no GitHub repository runs nothing that would
   * authenticate with one, so a GitLab-bound or not-yet-linked workspace is told nothing about
   * a member's GitHub token rather than warned about a credential its runs never touch. And
   * WHICH repositories a fine-grained token is probed against, since only a repository a run
   * targets makes a per-repository answer worth acting on.
   */
  listWorkspaceRunRepos?: ListWorkspaceRunRepos
  /**
   * The workspace subscription-token pool (Claude Code / Codex credentials).
   * Present only when the facade wired the provider-subscription repository.
   */
  subscriptions?: ProviderSubscriptionService
  /**
   * The sensitive per-service test-credential store (sealed). Present only when the facade
   * wired the test-secrets repository (needs ENCRYPTION_KEY). Backs the test-secrets CRUD
   * controller; its resolution methods are also threaded into the engine (prompt refs) and
   * the container executor (values, injected into the Tester out of band).
   */
  testSecrets?: TestSecretsService
  /**
   * The per-workspace capability-credential store (sealed). Present only when a facade wired the
   * repository — which needs `ENCRYPTION_KEY`, like every other sealed store.
   */
  capabilityCredentials?: CapabilityCredentialsService
  /**
   * Whether the capability-credential chain this facade COMPOSED reads the deployment environment
   * behind the store above: the fact the credential checklist describes, not a default it
   * re-asserts. Projected from `buildToolSecretChain`, so the surface and the dispatch path read
   * one composition.
   *
   * Undefined is a real answer and the reason this is a tri-state: a deployment that supplied its
   * own `ToolSecretResolver` replaced the chain, and nothing here knows what it consults.
   *
   * TWO causes land on undefined and the surface must not pick between them, which is why the copy
   * it renders states only that the chain cannot be described HERE and never why. The other cause
   * is a facade that wired the store and dropped this flag, a refactor hazard rather than a
   * deployment choice (every link in that chain is optional, which is what the
   * `tool-secret-seam.coverage.*` guards pin per facade). Naming the custom resolver as the reason
   * would make the wiring bug read as a deliberate configuration and send the operator to the one
   * place that cannot explain it.
   */
  toolSecretEnvironmentFallback?: boolean
  /**
   * The composed capability-credential chain itself — the SAME `ToolSecretResolver` the container
   * executor dispatches with, from `buildToolSecretChain`.
   *
   * Surfaced on the container because the TOOL-SERVER PROBE has to resolve a credential the way a
   * dispatch does or it answers about the wrong thing: a probe that read the deployment's
   * environment directly would report one tenant's working server as every tenant's, and a probe
   * that sent no credential at all would report a rotated token as a dead endpoint. It is the one
   * read path that needs the resolver; every other consumer is an executor, which is handed it.
   *
   * Absent ⇒ this facade composed no chain, which the probe reports as `credentials_missing` for a
   * server declaring a required credential. That is the same disposition the dispatch path gives the
   * same state, rather than a probe that silently succeeds against an unauthenticated endpoint.
   */
  toolSecretResolver?: ToolSecretResolver
  /**
   * The per-workspace OAUTH GRANT store for remote (`http`) MCP tool servers (sealed). Present
   * only when a facade wired the repository, which needs `ENCRYPTION_KEY` like every other sealed
   * store.
   *
   * Backs three things: the connect/disconnect routes, the connection state the tool-server
   * inventory renders per declaration, and the dispatch-time token source the executor mints an
   * `Authorization` header from. Absent ⇒ a declaration that authenticates with OAuth has nowhere
   * to keep a grant, so the routes refuse with a 503 naming the key and a dispatch states the
   * server as `oauth_not_connected` — never a request sent without its token.
   */
  mcpOAuth?: McpOAuthService
  /**
   * The redirect URL a vendor's authorization server sends the operator's browser back to
   * (`MCP_OAUTH_REDIRECT_URL`), which must match what the deployment registered as its OAuth
   * client's redirect URI.
   *
   * Operator-configured rather than derived from the incoming request, because it is a value a
   * THIRD PARTY has on file: deriving it from a `Host` header would produce a different string
   * behind every proxy, preview URL and private hostname a deployment sits behind, and the
   * authorization server rejects the exchange when it does not match to the byte. Absent ⇒ the
   * interactive grant is refused with a 503 naming the variable; the client-credentials grant
   * needs no redirect and works without it.
   */
  mcpOAuthRedirectUrl?: string
  /**
   * This deployment acting as the AUTHORIZATION SERVER for its own hosted MCP endpoint: dynamic
   * client registration, the consent hand-off, and the token exchange that mints a public-API key.
   *
   * The mirror image of {@link mcpOAuth} above, which is this deployment as a CLIENT of someone
   * else's MCP server. Present only when the facade has both an `ENCRYPTION_KEY` (the flow seals
   * every value it carries between requests) and the public-API key store (what it issues), so a
   * deployment missing either refuses with a 503 naming both rather than serving metadata that
   * advertises endpoints nothing can complete.
   */
  mcpAuthServer?: McpAuthorizationServer
  /**
   * The SPA's own base URL (`APP_BASE_URL`), where the deployment serves it somewhere other than
   * this backend's origin. The MCP consent hand-off sends a browser here.
   *
   * Absent ⇒ the request's own origin is used, which is right for every same-origin install and is
   * why this is not required: unlike {@link mcpOAuthRedirectUrl}, no third party holds this string,
   * so a value that differs between deployments breaks nothing.
   */
  appBaseUrl?: string
  /**
   * The per-service PRE-PR VALIDATION CHECK store: the commands the harness runs against the
   * checkout before opening a PR. Present only when the facade wired the validation-config
   * repository. Backs the validation-check CRUD controller; its `resolveForBlock` is also
   * threaded into the engine so a dispatch carries the resolved commands in the job body.
   */
  validationConfig?: ValidationConfigService
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
   * The INBOUND public-API key store — the credentials external systems present to the
   * `/api/v1` surface. Present only when the facade wired the public-api-key repository (needs
   * ENCRYPTION_KEY as the HMAC pepper). Drives the key-management controller and the in-controller
   * authentication of `PublicApiController`. Absent ⇒ both surfaces 503.
   */
  publicApiKeys?: PublicApiKeyService
  /**
   * The per-workspace OUTBOUND notification-webhook configuration store. Present only when the
   * facade wired the repository (needs a SecretCipher for the signing secret). Drives the
   * management controller; the matching `WebhookNotificationChannel` reads the same rows to
   * deliver. Absent ⇒ the management surface 503s and no webhook deliveries are attempted.
   */
  notificationWebhooks?: NotificationWebhookService
  /**
   * The outbound PLATFORM-HEALTH push, built by `buildNotificationWebhookSupport` beside the
   * management service and the notification channel from the same row and cipher. The
   * platform-health sweep hands it each firing/resolved edge, which is what an on-call
   * integration is wired to. Absent ⇒ no endpoint feature is wired on this facade; the in-app
   * card is unaffected, since the sweep's own state lives in that card rather than out here.
   */
  platformAlertSink?: PlatformAlertSink
  /**
   * Whether the opt-in Cloudflare Workers AI provider lib is registered for this
   * deployment (binding on the Worker, REST account/token on Node). When false, the
   * `workers-ai` provider is unavailable and `cloudflare`-flavour catalog models are
   * not selectable.
   */
  cloudflareModelsEnabled?: boolean
  /**
   * The deployment's AWS Bedrock allow-list (`BEDROCK_MODELS`, gated on `BEDROCK_REGION`),
   * built by `bedrockAllowListFromEnv`. Spread into the per-workspace capability set, where
   * it decides which catalog entries' `bedrock` flavour is selectable. Absent ⇒ no `bedrock`
   * flavour is offered; Bedrock is a deployment-credential route, so there is nothing
   * per-workspace to resolve.
   */
  bedrockModels?: Set<string>
  /**
   * The deployment's direct-provider base-URL resolver (env override → built-in default,
   * or null when none, e.g. an unconfigured operator-hosted gateway, Bifrost or LiteLLM). The model
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
   * The deployment's sealed-secret inventory (ADR 0026 D6.2/D6.3): enumerates every
   * sealed-at-rest credential so the boot drift sweep can attempt to decrypt each, and drops a
   * specific unrecoverable one on the operator's request. Present only when the facade wired it
   * (needs ENCRYPTION_KEY-backed stores); absent ⇒ the drift sweep is skipped and the
   * `key_drift` card's drop action no-ops.
   */
  sealedSecretInventory?: SealedSecretInventory
  /**
   * Builds this deployment's own {@link SecretCipher} for an HKDF `info` tag: the seam the
   * mothership SECRET DELEGATION endpoints (`/internal/secrets/{unseal,seal}`) open and seal org
   * credentials through on a mothership-mode node's behalf. Absent, the delegation endpoints 503.
   *
   * A facade wires it only when BOTH hold: an `ENCRYPTION_KEY` (no key ⇒ nothing is sealed, so
   * there is nothing to delegate) and its own main database (⇒ this deployment is AUTHORITATIVE
   * for the org rows, rather than a mothership-mode node reading them over the RPC and holding
   * only a local key). This capability, not the `repositories` registry, is what tells the two
   * apart: a mothership-mode node populates that registry too, with the remote repos.
   *
   * Deliberately a FACTORY rather than a single cipher: each sealed source is domain-separated by
   * its own `info` tag, and handing the controller one cipher would either flatten that separation
   * or need a second seam per source. Same shape as the key-drift sweep's `cipherFor`.
   */
  secretCipherFor?: (info: string) => SecretCipher
  /**
   * The per-USER "repos my personal access token can reach" projection. Present only when the
   * facade wired GitHub (needs an installation-backed projection). Drives (a) the fail-closed
   * board redaction — a service frame backed by a `linkedVia:'user_pat'` repo is hidden from
   * members not recorded here — and (b) the repo-picker/link expansion, which records a user's
   * PAT-reachable repos when they enumerate them. See `UserRepoAccessRepository`.
   */
  userRepoAccess?: UserRepoAccessRepository
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
   * True when this deployment REQUIRES a registered ephemeral-environment provider connection for
   * env-dependent Tester runs — i.e. it has no zero-config in-container test-env default. Set by
   * the Worker and stock/remote Node (whose only test-env backend is the `environment-provider`),
   * and by local mode on a runtime that can't nest a Docker daemon (Apple `container`). Left falsy
   * on local mode's Docker-family runtimes, where `local-compose` stands the Tester's deps up with
   * no connection — so a missing provider is NOT a gap there. The infra-setup snapshot reads it so
   * the "test environment not configured" banner fires only where a provider is genuinely
   * mandatory (defaults to required when unset, preserving the hosted-facade behaviour).
   */
  ephemeralEnvironmentsRequireProvider?: boolean
  /**
   * Consumer of normalised inbound VCS webhook events (the neutral ingest route's
   * `POST /vcs/:provider/webhooks` hands verified+mapped events here). Present only when a
   * facade wires a sink; absent ⇒ the route still verifies + maps + acks but drops the event
   * (projection into provider-aware persistence is the follow-up to the GitHub-keyed tables).
   */
  vcsWebhookSink?: VcsWebhookSink
  /**
   * The app-owned VCS provider registry (the neutral webhook receiver resolves a provider
   * bundle through it). Built by the facade via `defaultVcsRegistry()` and pre-loaded with the
   * providers its config enables (e.g. `@cat-factory/gitlab`'s `registerGitLab`). Always
   * present — the facade attaches it alongside `config`/`gateways`; a provider a deployment did
   * not enable simply isn't registered, so the neutral route 503s for it exactly as before.
   */
  vcsRegistry: VcsProviderRegistry
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
   * First-run installation of the deployment's OWN source-control credential (kernel's
   * `LocalVcsSetup`). Present only on the local-mode facade, where one token is both the sign-in
   * identity and the credential every agent step clones/pushes/merges with: `/auth/pat` adopts a
   * pasted token as that credential so a developer who has just created one is not sent back to
   * `.env` and a restart. Absent on hosted facades (their credential is a GitHub App or a
   * per-workspace connection, neither of which a signed-out caller may set), and the pasted token
   * there is only ever an identity.
   */
  localVcsSetup?: LocalVcsSetup
  /**
   * The reflective repository registry the mothership-mode machine API
   * (`POST /internal/persistence`) dispatches over: repo name → repo instance. Attached by a
   * facade acting as a MOTHERSHIP (both Node + Cloudflare), so a mothership-mode local node
   * with no database can forward its org/durable repository calls here. Absent on a node that
   * is not a mothership ⇒ the persistence endpoint 503s. See `../persistence/rpc.ts`.
   */
  repositories?: PersistenceRegistry
  /**
   * Mothership-side GitHub token delegation: mints a short-lived GitHub App INSTALLATION
   * token for a machine-authed mothership-mode node (`POST /internal/github/installation-token`),
   * so the laptop's agent containers, gates, and RepoFiles ops reach GitHub while the App
   * private key never leaves the mothership. Wired by a facade whose GitHub App is configured
   * (both Node + Cloudflare — the symmetric change); absent ⇒ the endpoint 503s. See
   * docs/initiatives/mothership-mode.md.
   */
  githubTokenDelegation?: GitHubTokenDelegation
  /**
   * Mothership-side real-time UPSTREAM delivery: injects a relayed engine event from a
   * machine-authed mothership-mode node (`POST /internal/events/publish`) into THIS deployment's
   * own real-time fan-out, so a hosted teammate watching the same shared board sees the local
   * node's activity live. Wired by a facade acting as a mothership whose realtime transport is
   * enabled (both Node + Cloudflare — the symmetric change); absent ⇒ the endpoint 503s. This is
   * the OUTBOUND half of "real-time both directions"; see docs/initiatives/mothership-mode.md.
   */
  machineEventRelay?: MachineEventRelay
  /**
   * Mothership-side notification DELIVERY for a machine-authed mothership-mode node
   * (`POST /internal/notifications/deliver`): the node persists the notification row remotely but
   * holds none of the org's external delivery credentials (the Slack bot token is sealed with the
   * mothership's key, which never reaches a laptop), so the mothership re-reads the row and
   * delivers it through THIS channel. Each facade wires it with its EXTERNAL channels only — the
   * in-app push for a laptop-raised notification already rides the real-time upstream relay, so
   * routing it here too would double-push the same frame. Wired by a facade acting as a mothership
   * that has at least one external channel (both Node + Cloudflare — the symmetric change);
   * absent ⇒ the endpoint 503s. See docs/initiatives/mothership-mode.md.
   */
  machineNotificationDelivery?: NotificationChannel
  /**
   * Local-mode mothership login seam: exchange a mothership SESSION token for a machine token
   * and cache it locally, so the node can talk to the mothership without a pasted static token.
   * Wired ONLY on the local-mode facade in mothership mode; `POST /local/mothership/connect`
   * 503s when absent. See docs/initiatives/mothership-mode.md.
   */
  mothershipConnect?: MothershipConnector
  /**
   * The machine-node roster + revocation tombstones (SEC-5): recorded on every machine-token
   * mint, consulted by the shared machine gate (`verifyMachineRequest`) on every `/internal/*`
   * machine call so a revoked node is refused everywhere at once, and served to the owner via
   * `GET /auth/machine-nodes` / `POST /auth/machine-nodes/:nodeId/revoke`. Wired by both hosted
   * facades from their main DB; absent ⇒ mints go unrecorded and no revocation check runs (a
   * deployment that never acts as a mothership loses nothing).
   */
  machineNodeRepository?: MachineNodeRepository
  /**
   * The durable auth-attempt ledger behind the password-endpoint throttle (SEC-4), the
   * cross-replica window the per-isolate Map cannot be. Wired by both facades from their main
   * DB; absent (or erroring) the throttle degrades to the in-process backstop rather than
   * failing open.
   */
  authAttemptRepository?: AuthAttemptRepository
  /**
   * The transport-level client address of a request (the socket peer on Node), read by the
   * password throttle when `auth.trustProxyHeaders` is off, because a forwarded header is
   * attacker-controlled unless a trusted proxy overwrites it (SEC-4). Wired by the Node
   * facade; the Worker leaves it absent because Cloudflare injects `cf-connecting-ip` at the
   * edge, which that facade trusts instead.
   */
  resolveClientAddress?: (c: Context<AppEnv>) => string | undefined
}

/**
 * Mints a GitHub App installation token for a machine-authed mothership-mode node.
 * `repositoryIds` narrows the mint to those repos (GitHub's `repository_ids` scoping). The
 * delegation controller always passes a NON-EMPTY set drawn from the in-scope projection (the
 * installation's linked repos, intersected with whatever narrower set the node asked for), so a
 * delegated token never grants more than the mothership projects for that installation.
 */
export interface GitHubTokenDelegation {
  installationToken(
    installationId: number,
    opts?: { forceRefresh?: boolean; repositoryIds?: number[] },
  ): Promise<string>
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

/**
 * The signed-in caller's resolved workspace-RBAC access to the `:workspaceId` on the
 * route, set by the auth gate (`mountAuthGate`) after a successful resolution. Controllers
 * CONSUME this (`requirePermission`) — they never re-derive membership. Carries the
 * `workspaceId` so a helper can assert it matches the route it's called from. Absent when
 * there's no signed-in user (dev-open) or the route carries no workspace segment.
 */
export interface WorkspaceAccessContext {
  workspaceId: string
  role: WorkspaceRole
  permissions: ReadonlySet<WorkspacePermission>
}

/** Hono generics shared by the cross-runtime controllers (Variables only — no Bindings). */
export type AppEnv = {
  Variables: {
    container: ServerContainer
    /** The authenticated user, set by `requireAuth` when auth is enabled. */
    user?: SessionPayload
    /** The caller's resolved workspace access, set by the gate — see {@link WorkspaceAccessContext}. */
    workspaceAccess?: WorkspaceAccessContext
    /**
     * The `WWW-Authenticate` challenge this route answers a 401 with, set by a route serving a
     * spec whose clients DISCOVER their authorization server from the refusal itself: today the
     * hosted MCP endpoint.
     *
     * Set on the CONTEXT rather than carried on the thrown error, because the route knows what its
     * challenge is before it knows whether it will refuse, and the refusal is raised deep inside
     * shared authentication code that has no business knowing which surface it is protecting. It
     * is read by `handleError`, which stays the one producer of the response either way.
     */
    bearerChallenge?: string
    /**
     * The request's correlation id, minted or adopted by `mountRequestLogging` and echoed on
     * the response + in every error envelope. Optional because a unit test may build a bare
     * `new Hono()` with no middleware; read it through `requestIdOf(c)`.
     */
    requestId?: string
    /**
     * The request-scoped child logger (bound `requestId` / `method` / `path`), set by
     * `mountRequestLogging`. Read it through `requestLogger(c)`, which falls back to the
     * process-wide logger when the middleware isn't mounted.
     */
    log?: Logger
    /**
     * The wire error code `handleError` mapped this request's failure to, stashed so the
     * request-log line can name it. Set ONLY on the throw path — a controller returning a 4xx
     * envelope directly leaves it unset.
     */
    errorCode?: string
  }
}
