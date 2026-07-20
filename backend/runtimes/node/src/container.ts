import {
  type AgentKindRegistry,
  defaultAgentKindRegistry,
  defaultInitiativePresetRegistry,
} from '@cat-factory/agents'
// Opt-in AWS EKS backends (runner + environment), registered by reference below (the Worker
// facade registers the same pair, keeping the runtimes symmetric with the native `kubernetes`
// backend these extend). They are pass-throughs until a workspace actually connects an `eks`
// backend, and carry NO runtime AWS SDK dependency (the token is minted with WebCrypto), so this
// adds no cost to a deployment that never uses EKS.
import { eksEnvironmentBackend, eksRunnerBackend } from '@cat-factory/eks'
import {
  ConfluenceProvider,
  FigmaProvider,
  ZeplinProvider,
  GitHubDocsProvider,
  LinearDocumentProvider,
  createBackendRegistries,
  type BackendRegistries,
  HttpRunnerPoolProvider,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  createEmailSender,
  TicketTrackerService,
  type DeployJobClient,
} from '@cat-factory/integrations'
import {
  type Clock,
  type DocumentSourceProvider,
  type EmailSender,
  type DeployCloneTarget,
  type GitHubClient,
  type GitHubInstallationRepository,
  type LocalModelEndpointRepository,
  type ModelProviderResolver,
  type PersonalSubscriptionRepository,
  type SubscriptionVendor,
  type ProviderApiKeyRepository,
  type ProviderSubscriptionTokenRepository,
  type RunnerPoolProvider,
  type SubscriptionActivationRepository,
  DEFAULT_MODEL_PRESET_ID,
  defaultProviderRegistry,
  defaultVcsRegistry,
} from '@cat-factory/kernel'
import {
  type CoreDependencies,
  createCore,
  defaultStepResolverRegistry,
  type GateRegistry,
  type StepResolverRegistry,
  resolvePresetModelForKind,
} from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ResolveRepoOrigin,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerSessionService,
  GitHubAppAuth,
  GitHubAppRegistry,
  GitHubIdentityResolver,
  runWithInitiator,
  WebCryptoPasswordHasher,
  WebCryptoSecretCipher,
  buildInfrastructureCapabilities,
  testEnvHasZeroConfigDefault,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  makePreviewJobBuilder,
  type PersistenceRegistry,
  logger,
  resolveUrlSafetyPolicy,
  resolveWorkspaceCapabilities,
} from '@cat-factory/server'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`
// below, then wires each gate's provider.
import {
  type GateProviderOverrides,
  applyGateProviders,
  gateRegistryWithBuiltins,
  warnUnwiredGates,
} from '@cat-factory/gates'
import {
  buildGitLabEngineClient,
  GitLabIdentityResolver,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import type {
  AppCaches,
  InitiativePresetRegistry,
  PipelineRegistry,
  PreviewTransport,
  ProviderRegistry,
  VcsIdentityRegistry,
  VcsProviderRegistry,
} from '@cat-factory/kernel'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import { selectNodeGitHubDeps } from './container-github-deps.js'
import { buildNodeModelDeps } from './container-model-deps.js'
import { buildNodeRunServices } from './container-run-services-deps.js'
import { buildNodeBootstrapper, buildNodeTransportDeploy } from './container-transport-deps.js'
import { buildNodeAccountDeps } from './container-account-deps.js'
import { buildNodeRealtimeDeps } from './container-realtime-deps.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossBootstrapRunner } from './execution/bootstrapRunner.js'
import { PgBossEnvConfigRepairRunner } from './execution/envConfigRepairRunner.js'
import { PgBossEnvironmentTestRunner } from './execution/envTestRunner.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { baseUrlForNode } from './modelProvider.js'
import { LocalMachineEventRelay } from './machineEventRelay.js'
import type { LocalEventSink } from './realtime.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
} from './repositories/containerExecution.js'
import { DrizzleRepoProjectionRepository } from './repositories/github.js'
import { DrizzleSubscriptionActivationRepository } from './repositories/personalSubscription.js'
import { DrizzleUserRepoAccessRepository } from './repositories/userRepoAccess.js'
import { createDrizzleRepositories, createDrizzleSandboxDeps } from './repositories/drizzle.js'
import type { ContentStorageBackend } from '@cat-factory/contracts'
import { DrizzleReferenceArchitectureRepository } from './repositories/bootstrap.js'
import { DrizzleEnvConfigRepairJobRepository } from './repositories/envConfigRepair.js'
import { DrizzleEnvironmentTestRunRepository } from './repositories/environmentTest.js'
import {
  DrizzleDocumentConnectionRepository,
  DrizzleDocumentRepository,
} from './repositories/documents.js'
import {
  DrizzleEnvironmentConnectionRepository,
  DrizzleEnvironmentRegistryRepository,
} from './repositories/environments.js'
import { DrizzleCustomManifestTypeRepository } from './repositories/customManifestType.js'
import { DrizzleNotificationRepository } from './repositories/notifications.js'
import {
  selectNodeFragmentLibraryDeps,
  selectNodeSkillLibraryDeps,
} from './container-content-library-deps.js'
import {} from './repositories/slack.js'
import {} from './repositories/tasks.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'
import {} from './wireCredentialServices.js'
// The container-agent-executor wiring (transport resolver, provisioning-log wrapper, container
// executor + bootstrapper + env-config repairer, GitHub-issue filer, trace-sink builder), lifted
// into a sibling module so this composition root stays within the file-size budget.
import {
  RUNNERS_CIPHER_INFO,
  buildNodeContainerExecutor,
  buildTraceSink,
  selectNodeEnvConfigRepairer,
} from './container-executor-deps.js'

// Re-export the public seams the local facade + tests still import from `./container.js`.
export {
  buildNodeResolveTransport,
  missingContainerExecutorPrereqs,
  withProvisioningLog,
} from './container-executor-deps.js'

/**
 * Source one org/durable repository that a standard build constructs directly from the Drizzle
 * `db`. In mothership mode (no Postgres) `remote` is the full-surface remote registry — a
 * `Proxy` (`createRemoteRepositoryRegistry`) that forwards any repo name to the hosted
 * mothership over the `/internal/persistence` RPC — so the repo comes from THERE instead of the
 * absent db; otherwise `build()` constructs the Drizzle repo over `db` as before. This is the
 * Phase-3 `db: undefined` audit seam: every direct-db store on the board-load + run path routes
 * through it. Routing is orthogonal to the server-side allow-list — an un-allow-listed remote
 * method still returns a clean `unknown_method`, never a `db`-undefined `TypeError`. Mirrors the
 * credential-repo override seam (`providerApiKeyRepository`), which keeps credentials local while
 * org state goes remote. See docs/initiatives/mothership-mode.md (Phase 3, part 1).
 */
export function pickRepoSource<T>(
  remote: Record<string, unknown> | undefined,
  name: string,
  build: () => T,
): T {
  return remote ? (remote[name] as T) : build()
}

// Memoised per object so a container build shares ONE model provider (hence one inline
// trace sink) across the agent executor, requirements reviewer, doc planner and
// fragment selector, and ONE core trace sink — instead of each call constructing its
// own. Mirrors the Worker's `buildModelProvider` memoisation. Memoisation matters more for
// OTel than Langfuse: the SDK sink owns batch processors/exporters, so it must be built
// once per config, not per wiring site.
/**
 * Wire account invitations + per-account email senders for the Node facade (parity
 * with the Worker's `selectEmailInvitationDeps`). Invitations are always available (an
 * invite link works without email); the email-connection store + cipher are wired only
 * when EMAIL is enabled, so an account can onboard a SendGrid/Resend key in the UI and
 * have invites emailed. The provider key is sealed with the shared ENCRYPTION_KEY.
 */
function selectNodeEmailInvitationDeps(
  config: AppConfig,
  repos: ReturnType<typeof createDrizzleRepositories>,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    invitationRepository: repos.invitationRepository,
    // Password reset works without email (the link is logged in dev); the system sender
    // below upgrades it to real delivery when configured.
    passwordResetTokenRepository: repos.passwordResetTokenRepository,
    resolveSystemEmailSender: buildSystemEmailSender(config),
    appBaseUrl: config.email.appBaseUrl || undefined,
    logger,
  }
  if (config.email.enabled && config.email.encryptionKey) {
    deps.emailConnectionRepository = repos.emailConnectionRepository
    deps.emailSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.email.encryptionKey,
      info: EMAIL_CIPHER_INFO,
    })
  }
  return deps
}

/**
 * Build the deployment-level system email sender (auth emails like password reset) from
 * the env-driven `email.system` config, or undefined when not configured.
 */
function buildSystemEmailSender(
  config: AppConfig,
): (() => Promise<EmailSender | null>) | undefined {
  const system = config.email.system
  if (!system) return undefined
  const sender = createEmailSender({
    provider: system.provider,
    from: system.from,
    sendgrid: system.provider === 'sendgrid' ? { apiKey: system.apiKey } : undefined,
    resend: system.provider === 'resend' ? { apiKey: system.apiKey } : undefined,
  })
  if (!sender) return undefined
  return async () => sender
}

/**
 * Rate-limit accounting is best-effort telemetry the Worker persists to D1; the Node
 * facade has no such table, so it drops the snapshots (exactly like the local facade).
 */
/**
 * The workspace-spanning GitHub App registry, built once and shared by everything that
 * needs an App credential: the container executor's push-token mint, the tech-debt
 * issue filer, and the CI / merge / mergeability gate client. Returns undefined when
 * the App isn't configured (`github.enabled` + `GITHUB_APP_PRIVATE_KEY`), so each
 * caller degrades the way it always has.
 */
function buildNodeAppRegistry(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
): GitHubAppRegistry | undefined {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!config.github.enabled || !privateKeyPem) return undefined
  const makeAuth = (appId: string, key: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem: key,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  // Privileged App tier (ADR 0005): the second App carries `Administration: write`
  // for repo provisioning. Activates only when both its config id and key are
  // present, mirroring the Worker's `buildAppRegistry`.
  const privilegedKey = env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY?.trim()
  const privileged =
    config.github.privilegedApp && privilegedKey
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, privilegedKey),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, privateKeyPem),
    },
    privileged,
    installationRepository,
  })
}

/**
 * The hosted PAT-login registry: lets a user sign in by pasting their OWN source-control PAT,
 * which the shared `/auth/pat` flow resolves to the account it belongs to (and holds to the
 * server's login/org/domain allowlist — see `AuthController`). GitHub is always available;
 * GitLab is added when a GitLab connection is configured. Unlike local mode there is NO
 * `configuredToken` — a remote deployment is multi-user, so there's no shared one-click env
 * token; each user supplies their own PAT.
 */
function buildNodeVcsIdentityRegistry(config: AppConfig): VcsIdentityRegistry {
  const registry: VcsIdentityRegistry = {
    github: { resolver: new GitHubIdentityResolver({ apiBase: config.github.apiBase, logger }) },
  }
  if (config.gitlab?.enabled) {
    registry.gitlab = {
      resolver: new GitLabIdentityResolver({ apiBase: config.gitlab.apiBase, logger }),
    }
  }
  return registry
}

/**
 * The subscription-credential lease seams `buildNodeContainer` hands to
 * {@link NodeContainerOptions.wrapModelProviderResolver}. Present only when the corresponding
 * subscription service is configured (ENCRYPTION_KEY + a token store). The local facade's
 * inline-harness wrap uses them to lease a credential for an inline subscription call run in a
 * warm container — the personal per-run activation for an individual vendor, the pooled token
 * otherwise — mirroring `ContainerAgentExecutor.resolveAuth`.
 */
export interface ModelProviderResolverWrapDeps {
  leasePersonalSubscriptionToken?: (
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
  leaseSubscriptionToken?: (
    workspaceId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
}

export interface NodeContainerOptions {
  /**
   * The Drizzle/Postgres client (the single persistence layer). OPTIONAL: a mothership-mode
   * local node runs with NO Postgres (`db` undefined) and supplies {@link repos} (org/durable
   * state served remotely) plus the credential-repo seams below instead. When `db` is
   * undefined, `repos` is REQUIRED.
   *
   * Mothership-mode service matrix (what `db: undefined` turns off vs. routes remotely):
   *   - Org/durable stores that were built directly from `db` (notifications, bootstrap,
   *     env-config-repair, GitHub projections, …) are routed through the {@link pickRepoSource}
   *     seam, so they come from the remote registry ({@link repos}) instead of the absent db — the
   *     board-load + run paths are covered (the Phase-3 merge gate, MET; see
   *     docs/initiatives/mothership-mode.md). An org method the server-side allow-list does not yet
   *     expose returns a clean `unknown_method`, never an undefined-db `TypeError`.
   *   - The per-user Postgres-only services that still lack a local-sqlite bucket turn themselves
   *     OFF: user secrets + OpenRouter catalog. See {@link buildNodeUserSecretService} et al.
   *   - The credential + subscription stores stay ON via the local `node:sqlite` override seams
   *     below ({@link providerApiKeyRepository} / {@link localModelEndpointRepository} /
   *     {@link providerSubscriptionTokenRepository} / {@link personalSubscriptionRepository} /
   *     {@link subscriptionActivationRepository}) — laptop-local, leased + decrypted by the LOCAL
   *     container executor, so they are NOT in the "off without db" set above. Local-mode settings
   *     likewise come from the local `node:sqlite` singleton (wired in the local facade). See the
   *     local-sqlite bucket pattern in the initiative doc.
   */
  db?: DrizzleDb
  /**
   * Pre-built repositories; defaults to building them from {@link db}. Lets the caller
   * (e.g. {@link start}) share one set with the retention sweeper rather than rebuild.
   * REQUIRED when {@link db} is undefined (mothership mode), where it is the composite of
   * the remote (RPC-backed) org repos + the local credential repos.
   */
  repos?: ReturnType<typeof createDrizzleRepositories>
  /**
   * The catalog id of the built-in model preset a fresh workspace is seeded with as its
   * DEFAULT. Node deploy defaults to `mdp_kimi` (Cloudflare-runnable on the bare baseline);
   * the local facade passes `mdp_claude`. Applied only at first seed, so a user's later
   * manual default choice is always preserved.
   */
  defaultModelPresetId?: string
  /**
   * Override the direct-vendor API-key pool's repository. When provided it REPLACES the
   * default Drizzle one, so a sibling facade can back the key pool with a different store
   * (mothership mode injects the local `node:sqlite` credential store, since agent/model
   * credentials stay on the laptop). Undefined → the Drizzle repo over {@link db} (and the
   * whole API-key service turns off when neither a db nor this override is present).
   */
  providerApiKeyRepository?: ProviderApiKeyRepository
  /**
   * Override the per-user locally-run model-endpoint repository (the symmetric local-sqlite
   * credential seam to {@link providerApiKeyRepository}). Undefined → the Drizzle repo over
   * {@link db}.
   */
  localModelEndpointRepository?: LocalModelEndpointRepository
  /**
   * Override the per-workspace subscription-token pool repository (Claude Code / Codex / GLM
   * credentials). Like {@link providerApiKeyRepository}, mothership mode injects the local
   * `node:sqlite` credential store here so the pooled subscription tokens stay on the laptop
   * (the LOCAL container executor leases + decrypts them, so they never reach the mothership).
   * Undefined → the Drizzle repo over {@link db} (and the service turns off without either).
   */
  providerSubscriptionTokenRepository?: ProviderSubscriptionTokenRepository
  /**
   * Override the per-user individual-usage subscription repository (double-encrypted personal
   * credentials). The local-sqlite credential seam for mothership mode; undefined → the Drizzle
   * repo over {@link db}. Paired with {@link subscriptionActivationRepository} — the personal
   * subscription service needs BOTH, and BOTH must come from the same store.
   */
  personalSubscriptionRepository?: PersonalSubscriptionRepository
  /**
   * Override the per-run personal-credential activation repository (short-lived, system-key-only
   * re-encryptions). The local-sqlite credential seam for mothership mode; undefined → the Drizzle
   * repo over {@link db}. Two consumers share this ONE instance: the personal-subscription service
   * (mint) and the engine core (clear on run completion), so the override is threaded into both. In
   * mothership mode (no db) it is ALWAYS injected, so — unlike the org/durable stores — its engine
   * consumer is never routed remotely through {@link pickRepoSource}.
   */
  subscriptionActivationRepository?: SubscriptionActivationRepository
  /**
   * Started pg-boss instance for durable execution. When present the container wires
   * a {@link PgBossWorkRunner}; otherwise runs fall back to the engine's NoopWorkRunner
   * (the caller drives runs itself — e.g. tests).
   */
  boss?: PgBoss
  /** Pre-resolved config; defaults to `loadNodeConfig(env)`. */
  config?: AppConfig
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
  /**
   * Override the runner backend the container-agent steps dispatch to. When provided
   * (even as `null`) it REPLACES the default self-hosted-pool resolution, so a sibling
   * facade can supply its own transport (e.g. the local-mode Docker transport) without
   * registering a runner pool. Undefined → the default Node behaviour (resolve a
   * workspace's self-hosted pool when runner pools are enabled).
   */
  resolveTransport?: ResolveRunnerTransport | null
  /**
   * Override the DEPLOY job transport client (the async, container-backed Kubernetes
   * render lifecycle — slice 9's `deployJobClient` seam). When provided it REPLACES the
   * default (`new RunnerJobClient(resolveTransport)` — Node deploys on the workspace's
   * self-hosted pool, which pulls the `imageDeploy` variant). The local facade injects a
   * deploy-dedicated transport (the native CLI / a per-run deploy container) instead.
   * Undefined → the default pool-backed client when a runner transport is wired.
   */
  deployJobClient?: DeployJobClient
  /**
   * Suppress the DEFAULT pool-backed deploy client (`new RunnerJobClient(resolveTransport)`).
   * The local facade sets this: its agent transport runs the executor-harness image (or a host
   * agent process), which lacks `kubectl`/`kustomize`/`helm`, so it must NOT back deploy jobs.
   * Local injects its own deploy-dedicated `deployJobClient` when configured, else leaves deploy
   * unwired (a render-needing config then fails loudly). Undefined → the default applies (Node's
   * self-hosted pool, which pulls the `imageDeploy` variant, legitimately serves deploy).
   */
  disableDefaultDeployJobClient?: boolean
  /**
   * Override how the manifests-repo clone target is resolved for a deploy job (slice 9's
   * `resolveDeployCloneTarget` seam). When provided it REPLACES the default
   * (`makeResolveDeployCloneTarget` over the App token mint + a `github.com` origin), so the
   * local PAT / GitLab facade can emit the right host + a PAT clone token. Undefined → the
   * default GitHub-App-backed resolver when the App is configured.
   */
  resolveDeployCloneTarget?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
  /**
   * Override how the container executor mints the push/clone token. When provided it
   * REPLACES the GitHub-App token mint, so a sibling facade can authenticate with a
   * static credential instead of an App installation (e.g. a PAT in local mode). The
   * `installationId` argument is then ignored. Undefined → mint via the GitHub App
   * (requires `GITHUB_APP_PRIVATE_KEY`).
   */
  mintInstallationToken?: (installationId: number) => Promise<string>
  /**
   * A GitHub client used to wire the CI gate + the merge / mergeability providers
   * (so a run gates on real CI and merges for real). When provided, the
   * `ciStatusProvider`, `mergeabilityProvider` and `pullRequestMerger` are wired from
   * it + the resolved repo target. Undefined → those gates pass through (the existing
   * Node behaviour). The local facade passes a PAT-backed client.
   */
  githubClient?: GitHubClient
  /**
   * The browsable-frontend-PREVIEW container transport (slice 5c) — the per-runtime half that
   * publishes a served app's port to a host port and keeps it alive. Local mode injects the real
   * one (its Docker/Apple adapter); Node-pool/Worker inject none, so the preview module stays
   * unwired (503). When present, the runtime-neutral `buildPreviewJob` is constructed from the
   * SAME repo/token/session seams the container executor uses (unless one is injected via
   * `overrides` — the conformance suite passes a fake pair to drive the flow on real Postgres).
   */
  previewTransport?: PreviewTransport
  /**
   * Wrap the model-provider resolver right after it's built, so a sibling facade can add a
   * flavour the base resolver lacks. Local mode wraps it so a subscription HARNESS ref
   * (`claude-code` / `codex`) resolves to a CLI-backed inline model — driving the developer's
   * ambient CLI when present, else a warm container on a LEASED subscription credential (the
   * inline analogue of its container ambient-auth / leased-token paths). The lease seams are
   * passed in `deps` (built here from the same subscription services the container executor
   * uses), so the wrap can lease a per-run personal activation / a pooled token for the inline
   * call. Undefined → the base Node resolver (HTTP providers only). Applied to both the inline
   * executor and `createCore`, so the reviewer/brainstorm/estimator + the inline agent kinds
   * all use it.
   */
  wrapModelProviderResolver?: (
    inner: ModelProviderResolver,
    deps: ModelProviderResolverWrapDeps,
  ) => ModelProviderResolver
  /**
   * Override the git origin (clone URL + provider) for a run's repo. The default builds a
   * `github.com` URL; the local GitLab facade injects a builder emitting the configured
   * GitLab host + `gitlab`, so agent containers clone the right host and open merge requests
   * (without it the clone URL is always github.com, so a GitLab repo can't be cloned).
   * Undefined → the default GitHub origin.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Override the GitHub installation repository. When provided it REPLACES the default
   * Drizzle one, so a sibling facade can wrap it — e.g. local mode decorates it to
   * auto-provision a synthetic per-workspace installation for its PAT, since there is no
   * GitHub-App connect flow. Undefined → the default Drizzle repository over {@link db}.
   */
  githubInstallationRepository?: GitHubInstallationRepository
  /**
   * Force the Cloudflare-AI opt-in flag (the cross-runtime conformance suite forces it
   * off for parity). Undefined → derived from the REST credentials being present.
   */
  cloudflareModelsEnabled?: boolean
  /**
   * Explicit built-in gate providers, wired onto the build's `providerRegistry` AFTER the config
   * branches wire the real ones (so a test override wins). The cross-runtime conformance suite uses
   * this to drive the externalized `@cat-factory/gates` CI gate over a faked verdict; production
   * leaves it undefined and the config branches below wire the real providers.
   */
  gateProviders?: GateProviderOverrides
  /**
   * The real-time delivery sink. When provided, the container wires a
   * {@link NodeEventPublisher} (so the engine pushes execution/board/notification events
   * to subscribed browsers) and composes an in-app notification channel. `start()` passes
   * the layered propagator here (the local hub + any cross-node adapter such as Redis) and
   * attaches the hub itself to the HTTP server via {@link attachRealtime}; a single-node /
   * local boot passes the bare hub. `createServer`/tests leave it unset and the engine
   * falls back to the no-op publisher (no live push), exactly as before.
   */
  realtimeSink?: LocalEventSink
  /**
   * The app-owned cache bag (docs/initiatives/caching-layer.md). `start()` builds it once
   * per process via `createAppCaches` — with the Redis-backed invalidation notification
   * factory when `REDIS_URL` is set (multi-node), bare in-memory otherwise — and owns its
   * shutdown. `createServer`/tests leave it unset and `createCore` builds bare in-memory
   * defaults, so single-process coherence (write-site invalidation) still holds.
   */
  caches?: AppCaches
  /**
   * Override the shared HTTP provider the built-in `manifest` runner backend dispatches/tests
   * through (its OAuth cache reused), e.g. for tests. This is NOT the custom-kind seam: a
   * bespoke runner backend is registered by reference into the injected
   * {@link backendRegistries} and selected per-workspace by its `kind`, exactly like a custom
   * environment backend. The per-workspace runner-pool connection (manifest + secrets) still
   * configures it. Undefined → the default HTTP provider.
   */
  runnerPoolProvider?: RunnerPoolProvider
  /**
   * The app-owned backend registries (environment + runner kind → provider). Defaults to
   * `createBackendRegistries()` (just the built-in `manifest` + `kubernetes` kinds). A
   * deployment registers a custom backend by reference here; the cross-runtime conformance
   * suite injects a registry pre-loaded with a fake custom backend to assert the seam behaves
   * identically on both runtimes.
   */
  backendRegistries?: BackendRegistries
  /**
   * The app-owned agent-kind registry (built-ins + any a deployment registered by reference).
   * Rides its OWN option (not the integrations `BackendRegistries` bundle) since it's owned by
   * `@cat-factory/agents`. Defaults to `defaultAgentKindRegistry()`. The SAME instance is
   * threaded into the executors, `createCore`, and the ServerContainer's snapshot projection;
   * the conformance suite injects a pre-loaded one to assert the seam is symmetric.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * The app-owned polling-gate registry. Rides its own option like `agentKindRegistry`; defaults
   * to a fresh registry with the built-in `@cat-factory/gates` suite installed. Threaded into
   * `createCore` + re-exposed on Core (so `start()` passes it to `validateRegistrations`); the
   * conformance suite injects a pre-loaded one (built-ins + a fake custom gate) to assert the seam
   * is symmetric.
   */
  gateRegistry?: GateRegistry
  /**
   * The app-owned step-completion-resolver registry (deployment-registered resolvers). Rides its
   * own option; defaults to an empty registry. Threaded into `createCore`; the conformance suite
   * injects a pre-loaded one to assert the seam is symmetric.
   */
  stepResolverRegistry?: StepResolverRegistry
  /**
   * The app-owned initiative-preset registry (built-in generic / docs-refresh / tech-migration +
   * any a deployment registered by reference). Rides its own option like `agentKindRegistry`;
   * defaults to `defaultInitiativePresetRegistry()`. Threaded into `createCore` + re-exposed on the
   * ServerContainer; the conformance suite injects a pre-loaded one to assert the seam is symmetric.
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * The app-owned VCS provider registry (the neutral webhook receiver resolves a provider bundle
   * through it). Rides its own option like `agentKindRegistry`; defaults to `defaultVcsRegistry()`.
   * The GitLab provider is registered onto it when `GITLAB_TOKEN` is configured; surfaced on the
   * ServerContainer. The conformance suite injects a pre-loaded one to assert the seam is symmetric.
   */
  vcsRegistry?: VcsProviderRegistry
  /**
   * The app-owned provider registry the built-in gates probe (gate data sources keyed by
   * {@link ProviderToken}). Rides its own option like `gateRegistry`; defaults to
   * `defaultProviderRegistry()`. The facade wires its configured gate providers onto it and
   * injects the SAME instance into `createCore`. The conformance suite injects a pre-loaded one.
   */
  providerRegistry?: ProviderRegistry
  /**
   * The app-owned pipeline registry (deployment-registered extra pipelines). Rides its own option
   * like `gateRegistry`; defaults (inside `createCore`) to `defaultPipelineRegistry()`. A deployment
   * registers its pipelines on it so they seed into every new workspace; the conformance suite can
   * inject a pre-loaded one.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * Skip wrapping the resolved transport with the provisioning-log decorator. A sibling
   * facade that pre-wraps each transport branch with its OWN subsystem tag (local mode
   * tags the per-run container vs the runner pool separately) sets this so
   * {@link buildNodeContainer} doesn't double-wrap. Undefined/false → the default
   * single-subsystem wrap below.
   */
  skipProvisioningLogWrap?: boolean
  /**
   * The content-storage backend used when an account has configured none. The Node facade
   * defaults to `off` (storage requires explicit per-account configuration); the local facade
   * passes `fs` so on-disk screenshot storage works out of the box. Always overridable
   * per-account in the UI.
   */
  contentStorageDefaultBackend?: ContentStorageBackend
}

/**
 * Resolve which runner backend a workspace's container jobs dispatch to. The Node
 * facade has no built-in per-run container runtime (unlike the Worker's Cloudflare
 * Containers), so it serves a workspace's self-hosted runner pool when one is
 * registered and throws a clear error otherwise. Returns null (no transport at all)
 * when runner pools are not enabled. Mirrors the Worker's `buildResolveTransport`,
 * minus the Cloudflare-container path.
 */
/**
 * The Node composition root: assemble the framework-agnostic domain `Core` with
 * Drizzle/Postgres repositories + Node implementations of the runtime ports, then
 * attach the shared-controller extras (`config`, the kind-spanning agent-run repo,
 * the runtime gateways). The same persistence is used in dev, test and prod — tests
 * run against a real Postgres, exactly as the Worker runs against a real D1.
 *
 * Repo-operating agent steps (coder, blueprints, merger, …) run in a container
 * dispatched to a workspace's self-hosted runner pool — the shared
 * `ContainerAgentExecutor`, exactly as on the Worker. When the prerequisites (GitHub
 * App, `PUBLIC_URL`, `AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`) are absent the
 * composite still serves inline kinds but fails container kinds loudly.
 */
export function buildNodeContainer(options: NodeContainerOptions): ServerContainer {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  // A browsable preview needs a per-runtime host-port-publish transport. Plain Node (runner
  // pool) has none, so advertise support ONLY when a `previewTransport` is actually wired
  // (local mode, or a facade/test that injects one) — otherwise the SPA would offer a Start
  // button that 503s. Local pre-sets its own descriptor before calling in, so this ??= is
  // skipped there; the check covers a stock Node build (false) and the conformance harness
  // (which injects a fake transport via `overrides` → true).
  const previewTransportWired = Boolean(
    options.previewTransport ?? options.overrides?.previewTransport,
  )
  // The Node service has no built-in per-run container runtime: repo-operating agents run on
  // a self-hosted runner pool, and Tester environments via the environment provider. Surface
  // that so the SPA's infrastructure selector reads accurately. Local mode pre-sets its own
  // descriptor (host Docker + pool) before calling in, so only fill it when absent.
  config.infrastructure ??= buildInfrastructureCapabilities({
    execution: { available: ['runner-pool'], active: 'runner-pool' },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
    frontendPreview: { supported: previewTransportWired },
    // A remote Node deployment has account admins to govern the account-wide model policy.
    // (Local mode sets `config.infrastructure` itself before delegating here, so its
    // mothership-gated value wins over this `??=`.)
    modelPolicy: { supported: true },
  })
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  // Mothership mode runs with NO Postgres (`options.db` undefined): org/durable state is served
  // remotely via `options.repos`, so that set is REQUIRED there. (A standard Node/local build
  // passes `db` and we build the Drizzle set from it.)
  if (!options.repos && !options.db) {
    throw new Error(
      'buildNodeContainer requires `repos` when `db` is undefined (mothership mode supplies the ' +
        'composite remote + local-credential repositories).',
    )
  }
  const repos = options.repos ?? createDrizzleRepositories(options.db as DrizzleDb, clock)
  // The Drizzle constructors only stash the handle — no build-time work (audited) — so BUILDING
  // the stores below over an `undefined` db is safe; `db` carries the non-null type for those
  // constructions, and the per-user credential services take the OPTIONAL `options.db` and turn
  // themselves off when it is absent.
  const db = options.db as DrizzleDb
  // Mothership mode (`options.db` undefined): the org/durable stores a standard build constructs
  // directly from the db — the GitHub installation + projections, runner-pool connection,
  // bootstrap + env-config-repair job stores, notifications, reference-architecture library,
  // task + subscription-activation stores — are sourced from the REMOTE registry instead (here
  // `options.repos` is the full-surface remote `Proxy` from `composeMothership`, which forwards
  // any repo name to the mothership over RPC). `pickRepoSource(remoteRepos, name, build)` picks
  // the remote entry when there is no db, else builds the Drizzle repo — see the Phase-3 audit in
  // docs/initiatives/mothership-mode.md. The feature-flagged integration repos owned by the
  // sub-helpers (tasks/documents/environments/fragments/slack) are opt-in and off by default, so
  // they are NOT on the default board-load + run path and remain a follow-up sub-slice.
  const remoteRepos = options.db ? undefined : (repos as unknown as Record<string, unknown>)
  // `remoteRepos` + `db` are fixed for this build, so bind them once: `sourced('name', (d) => …)`
  // picks the remote registry entry in mothership mode, else builds the Drizzle repo over `db`.
  const sourced = <T>(name: string, build: (d: DrizzleDb) => T): T =>
    pickRepoSource(remoteRepos, name, () => build(db))

  // The app-owned backend registries (env + runner kind → provider), built once here and
  // injected into the engine + surfaced on the container for the snapshot's backend-kind
  // selectors. A deployment registers a custom backend by reference; the conformance suite
  // injects a pre-loaded registry. Defaults to just the built-in `manifest`/`kubernetes` kinds.
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
  } = options.backendRegistries ?? createBackendRegistries()
  // The app-owned agent-kind registry: the injected instance (so a deployment's custom kinds
  // are visible) else the built-ins-only default. The SAME instance flows to the executors,
  // createCore and the ServerContainer snapshot projection.
  const agentKindRegistry = options.agentKindRegistry ?? defaultAgentKindRegistry()
  // The app-owned gate registry: the injected instance (conformance / a deployment pre-loads it),
  // else a fresh one with the built-in `@cat-factory/gates` suite installed via
  // `gateRegistryWithBuiltins()`. Flows into createCore (the engine's gate machine) and is
  // re-exposed on Core so `start()` validates the SAME instance.
  const gateRegistry = options.gateRegistry ?? gateRegistryWithBuiltins()
  // The app-owned step-resolver registry: the injected instance else an empty default (the
  // built-in `merger` resolver is a privileged engine built-in, not a registry entry).
  const stepResolverRegistry = options.stepResolverRegistry ?? defaultStepResolverRegistry()
  // The app-owned initiative-preset registry: the injected instance else the built-ins-only
  // default (generic / docs-refresh / tech-migration). Flows into createCore (initiative services
  // + spawned-run preset context) and the ServerContainer snapshot descriptors + preset probe.
  const initiativePresetRegistry =
    options.initiativePresetRegistry ?? defaultInitiativePresetRegistry()

  // Register the opt-in AWS EKS backends by reference (the default registries stay AWS-free).
  // Reuses the native Kubernetes transport/provider behind a minted IAM apiserver token; a
  // pass-through until a workspace connects an `eks` backend. Registered on BOTH facades (the
  // Worker registers the same pair in its container build) so the runtimes stay symmetric with
  // the native `kubernetes` backend these extend — a real EKS cluster's private-CA apiserver is
  // only reachable from a runtime that can pin a custom CA (Node/local), the same constraint a
  // private-CA `kubernetes` connection already carries.
  runnerBackendRegistry.register(eksRunnerBackend)
  environmentBackendRegistry.register(eksEnvironmentBackend)

  // The built-in gates' providers are wired onto the app-owned `providerRegistry` (news'd below,
  // fresh unless injected via `options`). The GitHub + release-health wiring runs only inside its
  // `enabled`/`githubClient` branches; a fresh registry starts empty, so an unconfigured gate just
  // stays unwired (pass-through) — no reset needed (the former `clearGateProviders()` guarded a
  // module-global that no longer exists). Mirrors the Worker facade (keep the runtimes symmetric).
  // Any test-injected gate providers (`options.gateProviders`) are applied at the END of this build
  // so they OVERRIDE the config wiring (local mode wires a PAT-backed CI provider here that would
  // otherwise clobber a faked one) — gates read their provider lazily at probe time, last write wins.

  // Opt-in GitLab VCS provider (single-token model, mirroring local-mode's PAT). Registered on
  // the app-owned `vcsRegistry` so the neutral webhook route + any VcsConnectionRef holder
  // resolves it. A no-op unless GITLAB_TOKEN is set; symmetric with the Worker facade (and
  // inherited by local) per "keep the runtimes symmetric".
  const vcsRegistry = options.vcsRegistry ?? defaultVcsRegistry()
  // The app-owned provider registry the built-in gates probe through. A single-process facade, so
  // one instance for the process (the injected one via `options`, else a fresh empty one). The
  // GitHub CI/mergeability/review/doc-quality + release-health + incident providers are wired onto
  // it below when configured; injected into `createCore` so the gate machine reads the SAME
  // instance. A fresh instance starts empty, so the former `clearGateProviders()` reset is gone.
  const providerRegistry = options.providerRegistry ?? defaultProviderRegistry()
  let gitlabEngineClient: GitHubClient | undefined
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    registerGitLab(vcsRegistry, {
      tokenSource: new StaticGitLabTokenSource(env.GITLAB_TOKEN, config.gitlab.apiBase),
      clock,
      webhookSecret: config.gitlab.webhookSecret || undefined,
    })
    // Bridge the GitLab VcsClient onto the legacy GitHubClient port the engine's gate / merge /
    // RepoFiles paths consume, so a GitLab-only deployment (no GitHub App) gates on real CI and
    // merges the MR for real — the SAME wiring local mode already does, now on the Node facade
    // too (keep the runtimes symmetric). The GitHub App client wins when both are configured.
    gitlabEngineClient = buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
    })
  }

  // Honour the workspace's model presets at run time (block-pinned > the task's
  // selected/default model preset > env routing), uniformly for inline and container
  // kinds. The built-in default preset points every agent kind at Kimi K2.7.
  const resolveWorkspaceModelDefault = (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => resolvePresetModelForKind(repos.modelPresetRepository, workspaceId, agentKind, modelPresetId)

  // The credential/token stores + the model-provisioning stack (API-key pool, public-API +
  // local-model-endpoint + user-secret + OpenRouter + subscription + personal-subscription
  // stores, the trace sink, the model-provider resolver, and the inline executor), lifted into
  // `container-model-deps.ts` so this composition root stays within the file-size budget.
  const {
    apiKeys,
    publicApiKeys,
    localModelEndpoints,
    userSecrets,
    resolveUserGitHubToken,
    openRouterCatalog,
    subscriptions,
    personalSubscriptions,
    traceSink,
    modelProviderResolver,
    cloudflareModelsEnabled,
    inline,
  } = buildNodeModelDeps({
    env,
    config,
    db,
    workspaceRepository: repos.workspaceRepository,
    idGenerator,
    clock,
    agentKindRegistry,
    userSecretKindRegistry,
    resolveWorkspaceModelDefault,
    providerApiKeyRepository: options.providerApiKeyRepository,
    localModelEndpointRepository: options.localModelEndpointRepository,
    providerSubscriptionTokenRepository: options.providerSubscriptionTokenRepository,
    personalSubscriptionRepository: options.personalSubscriptionRepository,
    subscriptionActivationRepository: options.subscriptionActivationRepository,
    wrapModelProviderResolver: options.wrapModelProviderResolver,
    cloudflareModelsEnabled: options.cloudflareModelsEnabled,
    caches: options.caches,
  })

  // Persistence the container-execution path needs (built from the same db). The
  // runner-pool repo also backs the `runners` Core module so a pool is registrable
  // via the API; the installation repo backs both token minting and repo resolution.
  const runnerPoolConnectionRepository = sourced(
    'runnerPoolConnectionRepository',
    (d) => new DrizzleRunnerPoolConnectionRepository(d),
  )
  const githubInstallationRepository =
    options.githubInstallationRepository ??
    sourced('githubInstallationRepository', (d) => new DrizzleGitHubInstallationRepository(d))
  // The repositories projection (+ sync cursors), shared by `buildResolveRepoTarget`
  // (block→repo resolution) and the GitHub sync/webhook module below.
  const repoProjectionRepository = sourced(
    'repoProjectionRepository',
    (d) => new DrizzleRepoProjectionRepository(d),
  )

  // The GitHub App registry, built once when the App is configured and shared by the
  // container executor's push-token mint, the tech-debt issue filer, and the CI / merge
  // gate client below. Undefined when the App isn't configured.
  const appRegistry = buildNodeAppRegistry(env, config, clock, githubInstallationRepository)

  // The repo a running block targets (installation + owner/name), resolved from the
  // github_repos projection. Built once and shared by the container executor, the
  // GitHub-issue tracker filer, and the CI / merge providers.
  const resolveRepoTarget = buildResolveRepoTarget({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    // The org service repo (its `getByFrameBlock` is all `buildResolveRepoTarget` needs); already
    // in `repos`, so it is the Drizzle repo over `db` in a standard build and the remote proxy in
    // mothership mode — no separate direct-db `DrizzleServiceFrameRepository` construction.
    serviceRepository: repos.serviceRepository,
    // Cache the whole-projection re-list per workspace (slice 3); the GitHub sync/webhook
    // module + bootstrapper invalidate the same bag on every projection write.
    repoProjectionCache: options.caches?.repoProjection,
  })

  // The MULTI-REPO resolver (service-connections phase 3): the task's own repo plus each
  // connected involved-service repo, deduped (the service repo's batched `listByFrameBlocks`
  // resolves the involved frames in one query). Fed to the container executor so the
  // implementer can fan a cross-service change out across sibling checkouts.
  const resolveRepoTargets = buildResolveRepoTargets({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    serviceRepository: repos.serviceRepository,
  })

  // The runner-transport resolver + the container-backed deploy lifecycle seams (resolve the
  // workspace's transport, wrap it with the provisioning-log decorator, build the deploy job
  // client + clone-target resolver), lifted into `container-transport-deps.ts` to keep this
  // root within budget.
  const { resolveTransport, baseDeployMint, deployDeps } = buildNodeTransportDeploy({
    config,
    repos,
    idGenerator,
    clock,
    runnerPoolConnectionRepository,
    runnerBackendRegistry,
    appRegistry,
    resolveRepoTarget,
    workspaceRepository: repos.workspaceRepository,
    resolveTransportOverride: options.resolveTransport,
    runnerPoolProvider: options.runnerPoolProvider,
    skipProvisioningLogWrap: options.skipProvisioningLogWrap,
    mintInstallationToken: options.mintInstallationToken,
    deployJobClientOverride: options.deployJobClient,
    disableDefaultDeployJobClient: options.disableDefaultDeployJobClient,
    resolveDeployCloneTargetOverride: options.resolveDeployCloneTarget,
    resolveRepoOrigin: options.resolveRepoOrigin,
  })
  // The per-run agent-observability + web-search + sealed-secret services (agent-context /
  // search-query / harness-call telemetry sinks, the web-search upstream + availability
  // resolver, the package-registry + test-secret dispatch resolvers, the subscription-quota
  // provider), lifted into `container-run-services-deps.ts` to keep this root within budget.
  const {
    agentContextObservability,
    searchQueryObservability,
    recordHarnessCalls,
    defaultWebSearchUpstream,
    resolveWebSearchAvailability,
    packageRegistrySecretCipher,
    resolvePackageRegistries,
    testSecretsService,
    resolveTestSecrets,
    resolveTestSecretRefs,
    subscriptionQuotaProvider,
  } = buildNodeRunServices({ env, config, repos, idGenerator, clock, caches: options.caches })

  const container = buildNodeContainerExecutor({
    env,
    config,
    appRegistry,
    resolveRepoTarget,
    resolveRepoTargets,
    resolveTransport,
    resolveWorkspaceModelDefault,
    agentKindRegistry,
    mintInstallationTokenOverride: options.mintInstallationToken,
    subscriptions,
    personalSubscriptions,
    resolveAccountId: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
    resolveUserGitHubToken,
    agentContextObservability,
    resolveWebSearchAvailability,
    resolveRepoOrigin: options.resolveRepoOrigin,
    resolvePackageRegistries,
    resolveTestSecrets,
    recordHarnessCalls,
    recordSubscriptionQuotaUsage: (target, usage) =>
      subscriptionQuotaProvider.recordUsage(target, usage),
  })

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  // Optionally wrapped with the consensus mechanism below (after the event publisher
  // is built, so live consensus pushes ride the same hub).
  const standardAgentExecutor = new CompositeAgentExecutor(inline, container, agentKindRegistry)

  // The GitHub-client-dependent slice of the composition root: the engine's GitHub client, the
  // CI / mergeability / review / doc-quality gate-provider wiring (registered onto
  // `providerRegistry` as a side effect — kept BEFORE `applyGateProviders` below), the task-source
  // deps, issue writeback, and the GitHub gate + projection/sync module deps. Lifted into
  // `container-github-deps.ts` (mirroring the Worker's `selectGitHubDeps`) so this composition root
  // stays within the file-size budget — same reason `container-executor-deps.ts` exists.
  const {
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
  } = selectNodeGitHubDeps({
    config,
    db,
    remoteRepos,
    sourced,
    idGenerator,
    clock,
    appRegistry,
    githubClientOverride: options.githubClient,
    resolveUserGitHubToken,
    gitlabEngineClient,
    providerRegistry,
    resolveRepoTarget,
    githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    caches: options.caches,
  })

  // Repo-bootstrap: the reference-architecture library + the container-dispatching
  // `repoBootstrapper`, lifted into `container-transport-deps.ts` to keep this root within budget.
  const { bootstrapJobRepository, bootstrapMintInstallationToken, repoBootstrapper } =
    buildNodeBootstrapper({
      env,
      config,
      sourced,
      resolveTransport,
      githubInstallationRepository,
      repoProjectionRepository,
      appRegistry,
      githubClient,
      mintInstallationToken: options.mintInstallationToken,
      resolvePackageRegistries,
      caches: options.caches,
    })

  // Real-time event publisher + notification channel + optional consensus wrap, lifted into
  // `container-realtime-deps.ts` to keep this root within the file-size budget.
  const { slackDeps, executionEventPublisher, agentExecutor, notificationChannel } =
    buildNodeRealtimeDeps({
      env,
      config,
      repos,
      sourced,
      realtimeSink: options.realtimeSink,
      standardAgentExecutor,
      modelProviderResolver,
      resolveWorkspaceModelDefault,
      agentKindRegistry,
    })

  // Per-account settings + binary-artifact storage + the observability/incident gate-provider
  // wiring (onto `providerRegistry`, before `applyGateProviders` below), plus the package-registry
  // management deps, lifted into `container-account-deps.ts` to keep this root within budget.
  const {
    releaseHealthDeps,
    packageRegistryDeps,
    incidentEnrichmentDeps,
    accountSettings,
    resolveBinaryArtifactStore,
  } = buildNodeAccountDeps({
    env,
    config,
    db,
    repos,
    idGenerator,
    clock,
    providerRegistry,
    packageRegistrySecretCipher,
    contentStorageDefaultBackend: options.contentStorageDefaultBackend,
    caches: options.caches,
  })

  // Runner-pool URL/host guard, scoped to its own config (independent of the environment
  // allow-list); absent => strict public-https.
  const runnerUrlPolicy = resolveUrlSafetyPolicy(config.runners)

  // Apply any test-injected gate providers LAST, so they override the config wiring above (the
  // cross-runtime conformance suite drives the externalized CI gate over a faked verdict; in
  // local mode a PAT-backed CI provider is wired above and would otherwise win). Production
  // leaves `gateProviders` undefined, so this is a no-op outside tests.
  applyGateProviders(providerRegistry, options.gateProviders)
  // Surface any gate left as a silent pass-through (no provider wired) so a misconfigured
  // deployment is visible in the logs instead of quietly auto-merging without checking CI.
  warnUnwiredGates(providerRegistry, logger)

  // pg-boss-backed async GitHub ingest (webhook/resync/backfill) when the durable engine is
  // wired; inline fallback with no boss. Built once so the engine's skill-freshness fan-out
  // (slice 4) enqueues through the SAME `githubWebhook` seam rather than re-deriving the queue.
  const gateways = createNodeGateways(env, options.boss)

  const dependencies: CoreDependencies = {
    ...releaseHealthDeps,
    ...incidentEnrichmentDeps,
    ...packageRegistryDeps,
    // Fold the service frame's SENSITIVE test-credential refs (key + description, never values)
    // into the tester prompt. Present when ENCRYPTION_KEY is set; absent ⇒ no advertised secrets.
    ...(resolveTestSecretRefs ? { resolveTestSecretRefs } : {}),
    // App-owned backend registries (kind → provider) the connection services resolve through.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The app-owned agent-kind registry (built-ins + any deployment-registered kinds); the
    // engine reads it (traits / inline-surface / pre-post-op hooks) and re-exposes it on Core.
    agentKindRegistry,
    // The app-owned gate + step-resolver registries; the engine's gate machine + completion hub
    // read them, and the gate registry is re-exposed on Core for the boot-time validation.
    gateRegistry,
    stepResolverRegistry,
    // The app-owned provider registry the gate providers were wired onto above; the engine's gate
    // machine reads the SAME instance through its GateContext.
    providerRegistry,
    // The app-owned pipeline registry (deployment-registered extra pipelines); createCore threads
    // it into the workspace + pipeline services and re-exposes it on Core for boot-time validation.
    pipelineRegistry: options.pipelineRegistry,
    // The app-owned initiative-preset registry; the initiative services read it and it is
    // re-exposed on Core for the snapshot descriptors + preset probe.
    initiativePresetRegistry,
    // The code-defined custom provision-type catalog, merged with the workspace rows by
    // `listCustomTypes` so a programmatically-registered type surfaces in the infra editor + the
    // per-service provisioning picker.
    customManifestTypeRegistry,
    ...(accountSettings ? { accountSettings } : {}),
    // Resolves the per-account binary-artifact store (screenshots) for the visual-confirmation
    // gate; resolving to null (no storage configured) ⇒ the gate passes through.
    resolveBinaryArtifactStore,
    workspaceRepository: repos.workspaceRepository,
    workspaceMemberRepository: repos.workspaceMemberRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    userRepository: repos.userRepository,
    passwordHasher: new WebCryptoPasswordHasher(),
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    // In mothership mode its home is the LOCAL `node:sqlite` credential bucket (the activation
    // re-seals the token for the run, and the LOCAL container executor decrypts it), injected via
    // `options.subscriptionActivationRepository` — the SAME instance the personal-subscription
    // service above mints into, so mint + clear agree. Absent (plain Node / siloed-Postgres local)
    // → the Drizzle repo over `db`. This is NEVER routed through `sourced` (the remote registry):
    // every no-db (mothership) caller injects the override — `buildLocalContainer` in production
    // and `makeMothershipConformanceApp` in tests — so `db` here is always a real Postgres handle,
    // and routing an activation clear to the mothership (where `deleteByExecution` isn't
    // allow-listed) is a path no caller takes.
    subscriptionActivationRepository:
      options.subscriptionActivationRepository ?? new DrizzleSubscriptionActivationRepository(db),
    // In-org shared services. When a realtime hub is wired (start()), the engine's
    // event publisher (composed above) is a `FanOutEventPublisher` over these two repos,
    // so a shared service's live events reach every board that mounts it — parity with
    // the Cloudflare facade. Without a hub (createServer/tests) the engine uses its
    // NoopEventPublisher and nothing is pushed.
    serviceRepository: repos.serviceRepository,
    workspaceMountRepository: repos.workspaceMountRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    llmCallMetricRepository: repos.llmCallMetricRepository,
    // Deployment-level rollups over `agent_runs` for the operator dashboard.
    platformMetricsRepository: repos.platformMetricsRepository,
    // Unified provisioning event log (its own Postgres schema). Threads the recorder
    // into the env services and exposes the read service for the logs controller.
    provisioningLogRepository: repos.provisioningLogRepository,
    recordLlmPrompts: config.observability.recordPrompts,
    // Re-exposed on the core for the agent-context read endpoint; the same instance
    // is injected into the container executor above for the write path.
    agentContextObservability,
    // Re-exposed on the core for the search-query read endpoint AND the search proxy's
    // write path (it reads it off the request container).
    searchQueryObservability,
    // Opt-in external trace sink(s) — Langfuse and/or OpenTelemetry — fanning every
    // recorded LLM call out as a generation. Built only when configured; otherwise
    // undefined and there is no external emission.
    llmTraceSink: buildTraceSink(config),
    modelPresetRepository: repos.modelPresetRepository,
    // A fresh workspace's model-preset library is seeded with this built-in as the default
    // (Node deploy → Kimi K2.7, the Cloudflare-runnable baseline; the local facade injects
    // Claude). Applied only at first seed, so a user's later manual default choice wins.
    defaultModelPresetId: options.defaultModelPresetId ?? DEFAULT_MODEL_PRESET_ID,
    serviceFragmentDefaultsRepository: repos.serviceFragmentDefaultsRepository,
    // Requirements-review feature (stateless reviewer + the requirements-rework
    // step). Wired identically to the Cloudflare facade's `selectRequirementsDeps`
    // so both runtimes serve the review/rework API AND substitute a block's reworked
    // requirements into the agent context (the cross-runtime conformance suite asserts
    // the substitution against both stores). The reviewer's model resolves exactly
    // like a pipeline step: block-pin > workspace per-kind default > routing default
    // (which falls back to Cloudflare Workers AI unless a direct key is set).
    requirementReviewRepository: repos.requirementReviewRepository,
    // Interactive document-interview sessions (WS5). Wired unconditionally; the interviewer
    // reuses the requirements reviewer's model config resolved just below.
    docInterviewRepository: repos.docInterviewRepository,
    // Kaizen agent (post-run grading). Wired unconditionally, mirroring the Cloudflare
    // facade, so the engine schedules gradings at run completion and the background sweep
    // runs them. The grader resolves its model for the `kaizen` kind exactly like a step.
    kaizenGradingRepository: repos.kaizenGradingRepository,
    kaizenVerifiedComboRepository: repos.kaizenVerifiedComboRepository,
    clarityReviewRepository: repos.clarityReviewRepository,
    brainstormSessionRepository: repos.brainstormSessionRepository,
    // Initiatives (the long-running multi-task work container). Wired unconditionally,
    // mirroring the Worker's `selectMergeLifecycleDeps`, so the create/read API + the
    // planning pipeline's ingest/committer steps work identically on both runtimes.
    initiativeRepository: repos.initiativeRepository,
    // Merge threshold presets: the per-workspace auto-merge ceiling library a task's
    // merge gate resolves (block-pinned preset > workspace default). Wired
    // unconditionally, exactly like the Worker's `selectMergeLifecycleDeps`, so the
    // preset CRUD API + the merger step's threshold resolution work identically.
    riskPolicyRepository: repos.riskPolicyRepository,
    // Shared stacks (long-lived compose infra a consumer environment attaches to). Wired
    // unconditionally like the merge presets so the CRUD API works identically on both
    // runtimes; the bring-up (`ensureUp`) needs a host daemon, so plain Node has no
    // `composeRuntime` — the local facade injects one via `overrides.composeRuntime`.
    sharedStackRepository: repos.sharedStackRepository,
    // Sandbox (parallel prompt/model testing) — contributed as one sandbox-owned mixin,
    // symmetric with the Worker's `...selectSandboxDeps(db)`; the run-driver reuses the
    // reviewer model config below. The container body never enumerates the five repos.
    ...createDrizzleSandboxDeps(db),
    // Per-workspace runtime settings (human-wait escalation threshold + per-service task
    // limit). Wired unconditionally so the settings API + the limit enforcement + the
    // escalation sweep work identically to the Worker.
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    userSettingsRepository: repos.userSettingsRepository,
    modelProviderResolver,
    requirementReviewModel: config.agents.routing.default.ref,
    requirementReviewResolveModel: config.agents.resolveBlockModel,
    // Local mode runs the inline reviewers/brainstorm/estimator on the ambient Claude Code /
    // Codex CLI when the pinned model is a subscription harness (undefined on stock Node, so
    // such refs degrade to the routing default). Also drives the preset satisfiability guard.
    ...(config.agents.inlineHarnessRef ? { inlineHarnessRef: config.agents.inlineHarnessRef } : {}),
    // Notifications subsystem (parity with the Worker, which wires it unconditionally):
    // the inbox + the human-action surfaces. Node has no real-time push, so the rows
    // persist (inbox + snapshot) and any channel composed below — e.g. Slack — delivers.
    notificationRepository: sourced(
      'notificationRepository',
      (d) => new DrizzleNotificationRepository(d),
    ),
    ...tasks.deps,
    // Recurring pipelines + the workspace tracker selection. The tracker provider
    // files the tech-debt pipeline's issue by resolving the *workspace's* connected
    // integration: GitHub issues through the workspace's GitHub App installation,
    // Jira tickets from the per-workspace encrypted connection store — both per-tenant.
    pipelineScheduleRepository: repos.pipelineScheduleRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    ticketTrackerProvider: new TicketTrackerService({
      trackerSettingsRepository: repos.trackerSettingsRepository,
      fetchImpl: fetch,
      ...(fileGitHubIssue ? { fileGitHubIssue } : {}),
      ...(tasks.taskConnectionRepository
        ? {
            resolveJiraConnection: async (workspaceId) => {
              const connection = await tasks.taskConnectionRepository!.getByWorkspace(
                workspaceId,
                'jira',
              )
              const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
              if (!baseUrl || !accountEmail || !apiToken) return null
              return { baseUrl, accountEmail, apiToken }
            },
            resolveLinearConnection: async (workspaceId) => {
              const connection = await tasks.taskConnectionRepository!.getByWorkspace(
                workspaceId,
                'linear',
              )
              const { apiKey, token } = connection?.credentials ?? {}
              return apiKey || token ? { apiKey, token } : null
            },
          }
        : {}),
    }),
    issueWritebackProvider,
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
    // Price metered dynamic OpenRouter models at their real per-model rate (not the
    // bare-`openrouter` fallback) using this workspace's enabled catalog.
    dynamicModelPricesFor: openRouterCatalog
      ? (ws) => openRouterCatalog.capabilitiesFor(ws)
      : undefined,
    // The runner-pool integration assembles when enabled, so a workspace can
    // register the self-hosted pool its container agents dispatch to.
    ...(config.runners.enabled && config.runners.encryptionKey
      ? {
          runnerPoolConnectionRepository,
          runnerSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: config.runners.encryptionKey,
            info: RUNNERS_CIPHER_INFO,
          }),
          // The pool provider instance backs the connection service's describeProvider +
          // testConnection (the manifest editor's secret-key form + a pre-save probe). An
          // injected native adapter wins here too (same instance that drives dispatch), so
          // its describeConfig/testConnection render — else the generic manifest provider
          // (same SSRF policy as the dispatch transport).
          runnerPoolProvider:
            options.runnerPoolProvider ??
            new HttpRunnerPoolProvider(runnerUrlPolicy ? { urlPolicy: runnerUrlPolicy } : {}),
          // Node (and local) has undici, so it can verify a private CA / skip TLS for a
          // Kubernetes apiserver — accept such a config at registration.
          runnerCustomTlsSupported: true,
          ...(runnerUrlPolicy ? { runnerUrlSafetyPolicy: runnerUrlPolicy } : {}),
        }
      : {}),
    ...(options.boss
      ? {
          workRunner: new PgBossWorkRunner(options.boss, executionRuntime(config, env).queue),
          // The durable bootstrap driver (analogue of the Worker's BootstrapWorkflow):
          // BootstrapService.startRun enqueues a drive job that polls the run to terminal.
          bootstrapRunner: new PgBossBootstrapRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
          // The durable env-config-repair driver (analogue of the Worker's
          // EnvConfigRepairWorkflow): start enqueues a drive job that polls the run to terminal.
          envConfigRepairRunner: new PgBossEnvConfigRepairRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
          // The durable ephemeral-environment self-test driver (analogue of the Worker's
          // EnvironmentTestWorkflow): startRun enqueues a drive job that advances the run.
          environmentTestRunner: new PgBossEnvironmentTestRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
        }
      : {}),
    ...githubGateDeps,
    // GitHub installation + repo/branch/PR/issue/commit/check-run projections + the
    // sync/webhook module (inline ingest persists to these repos on Node).
    ...githubModuleDeps,
    // Repo-bootstrap: the reference-architecture library + bootstrap-run store make the
    // module + API available; `repoBootstrapper` (when wired) dispatches the bootstrap
    // container through the shared runner seam, and `bootstrapRunner` (pg-boss, below)
    // durably drives its poll loop — parity with the Worker's BootstrapWorkflow.
    referenceArchitectureRepository: sourced(
      'referenceArchitectureRepository',
      (d) => new DrizzleReferenceArchitectureRepository(d),
    ),
    bootstrapJobRepository,
    ...(repoBootstrapper ? { repoBootstrapper } : {}),
    // Env-config-repair runs share the unified agent_runs table (kind-scoped). The job
    // repository is wired unconditionally; the repairer (agent fallback) is wired
    // post-overrides below over the FINAL provider, and the durable runner in the
    // `options.boss` block above — parity with the Worker's EnvConfigRepairWorkflow.
    envConfigRepairJobRepository: sourced(
      'envConfigRepairJobRepository',
      (d) => new DrizzleEnvConfigRepairJobRepository(d),
    ),
    // Ephemeral-environment self-test runs (their own table). The store is wired
    // unconditionally; the environments module builds the service when it + a git provider
    // are present, and the durable runner is wired in the `options.boss` block above.
    environmentTestRunRepository: sourced(
      'environmentTestRunRepository',
      (d) => new DrizzleEnvironmentTestRunRepository(d),
    ),
    // Document sources (Confluence / Notion / GitHub docs): wired from the shared
    // integration providers exactly like the Worker, so a workspace can connect a
    // source and import requirement/PRD/RFC pages as agent context.
    ...selectNodeDocumentsDeps(config, db, githubClient, githubInstallationRepository),
    // Ephemeral environments (opt-in): a workspace registers its own environment
    // management API; the tester provisions/destroys per-run environments from it. A
    // trusted in-house adapter can replace the default HTTP provider via the seam.
    // The environment integration scopes its own URL/host policy from
    // `config.environments` inside this selector (separate from the runner pool's).
    ...selectNodeEnvironmentsDeps(config, db),
    // The async container-backed Kubernetes deploy lifecycle (deployJobClient +
    // resolveDeployCloneTarget) — pool-backed by default, overridable by the local facade.
    ...deployDeps,
    // Prompt-fragment library (ADR 0006; opt-in): the managed tenant-scoped catalog
    // of best-practice fragments feeding every agent run, wired exactly like the
    // Worker's selectFragmentLibraryDeps (repos + installation resolver + selector).
    ...selectNodeFragmentLibraryDeps(
      config,
      env,
      db,
      githubClient,
      githubInstallationRepository,
      modelProviderResolver,
    ),
    // Repo-sourced Claude Skills library (docs/initiatives/repo-skills.md; opt-in): the
    // account's catalog of repo-authored skills, wired exactly like the Worker's
    // selectSkillLibraryDeps (account repos + installation resolver).
    ...selectNodeSkillLibraryDeps(config, db, githubClient, githubInstallationRepository),
    // Push-webhook skill-source freshness fan-out (slice 4): resync affected sources via the
    // pg-boss GitHub-sync queue. No boss (pure-logic test) ⇒ no proactive resync; the
    // dispatch-time probe is the freshness backstop.
    enqueueSkillResync: async ({ accountId, sourceId }) => {
      await gateways.githubWebhook.queueSkillResync(accountId, sourceId)
    },
    // Slack: an extra notification transport (the channel) + its management module.
    // Default-off; when enabled its channel is composed into `notificationChannel` below
    // alongside the in-app push, identically to the Worker.
    ...slackDeps,
    // Account invitations + per-account email senders (UI-onboarded, DB-stored).
    ...selectNodeEmailInvitationDeps(config, repos),
    // The pipeline-start guard resolves what's configured for a workspace + initiator.
    resolveProviderCapabilities: (workspaceId, initiatedBy) =>
      resolveWorkspaceCapabilities(
        {
          apiKeys,
          subscriptions,
          personalSubscriptions,
          cloudflareModelsEnabled,
          baseUrlFor: (provider) => baseUrlForNode(provider, env),
          localModelEndpoints,
          openRouterCatalog,
          accountSettings,
          workspaceAccountOf: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
          modelPolicySupported: config.infrastructure?.modelPolicy?.supported ?? false,
          ...(options.caches ? { caches: options.caches } : {}),
        },
        workspaceId,
        initiatedBy,
      ),
    // Real-time push (when a hub is wired) + the composed notification channel (in-app
    // push + Slack). These come AFTER the spreads so the composite replaces the bare
    // Slack channel `slackDeps` set; both are absent (no override) when nothing is wired.
    ...(executionEventPublisher ? { executionEventPublisher } : {}),
    ...(notificationChannel ? { notificationChannel } : {}),
    // Run the engine's gate-probe / merge GitHub reads under the run initiator's ambient
    // context, so a per-user PAT (when set) is preferred over the App/env token.
    runInitiatorScope: runWithInitiator,
    // The process-wide cache bag from start() (Redis-notified invalidation when REDIS_URL
    // is set). Absent ⇒ createCore builds bare in-memory defaults.
    ...(options.caches ? { caches: options.caches } : {}),
    ...options.overrides,
  }

  // Browsable frontend preview (slice 5c): wire the preview module when a per-runtime preview
  // transport is available. Local mode injects the real transport; the conformance suite injects
  // BOTH a fake transport + a fake job builder via `overrides` (which win, so the flow runs on
  // real Postgres without GitHub). The Worker/Node-pool inject neither ⇒ the module stays absent
  // (the controller 503s). When a transport is present but no builder was injected, construct the
  // real one from the SAME repo/token/session seams the container executor uses; without those
  // (no PUBLIC_URL / session secret / token mint) the module stays unwired rather than half-built.
  if (options.previewTransport && !dependencies.previewTransport) {
    dependencies.previewTransport = options.previewTransport
  }
  if (dependencies.previewTransport && !dependencies.buildPreviewJob) {
    const previewPublicUrl = env.PUBLIC_URL?.trim()
    const previewSessionSecret = config.auth.sessionSecret
    if (previewPublicUrl && previewSessionSecret && baseDeployMint) {
      dependencies.buildPreviewJob = makePreviewJobBuilder({
        blockRepository: repos.blockRepository,
        resolveRepoTarget,
        mintInstallationToken: baseDeployMint,
        ...(options.resolveRepoOrigin ? { resolveRepoOrigin: options.resolveRepoOrigin } : {}),
        sessionService: new ContainerSessionService({ secret: previewSessionSecret }),
        proxyBaseUrl: `${previewPublicUrl.replace(/\/+$/, '')}/v1`,
        ...(config.github.apiBase ? { githubApiBase: config.github.apiBase } : {}),
        ...(dependencies.environmentRegistryRepository
          ? { environmentRegistryRepository: dependencies.environmentRegistryRepository }
          : {}),
      })
    }
  }

  // Wire the live env-config repair agent over the FINAL environment provider (after the
  // `...options.overrides` above), so an injected native adapter — not the default manifest
  // provider — is what the repair dispatcher uses. Unwired on a stock deployment (the
  // generic provider has no `describeRepairAgent`), exactly like the service guard. Local
  // inherits this through `buildNodeContainer` with no extra wiring.
  const envConfigRepairer = selectNodeEnvConfigRepairer({
    env,
    config,
    resolveTransport,
    installationRepository: githubInstallationRepository,
    mintInstallationToken: bootstrapMintInstallationToken,
    override: dependencies.environmentProvider,
    environmentBackendRegistry,
  })
  // Don't clobber an override-provided repairer (e.g. the conformance suite's fake): an
  // explicit `overrides.envConfigRepairer` wins, exactly like `repoBootstrapper`.
  if (envConfigRepairer && !dependencies.envConfigRepairer) {
    dependencies.envConfigRepairer = envConfigRepairer
  }

  // Mothership mode (`db` undefined): `AgentContextBuilder` reads a block's linked docs/tasks
  // (`documentRepository`/`taskRepository`.listByBlock/get) on EVERY container agent dispatch, so
  // these are on the board-load + run path even though the document/task INTEGRATIONS are opt-in.
  // The sub-helpers above (`selectNodeDocumentsDeps`/`selectNodeTasksDeps`) build them directly
  // over the absent `db`, so re-source the context-builder run-path repos from the remote registry —
  // plus (below) the environment CONNECTION management surface. The document/task connection/provider
  // surfaces they also build stay db-direct (a later integration slice remotes them — their
  // credential rows would ship DECRYPTED over the RPC, an open secrets design point, unlike the
  // sealed-blob environment connection here). Routing is orthogonal to the allow-list: an
  // un-allow-listed remote method returns a clean `unknown_method`, never a `db`-undefined `TypeError`.
  if (remoteRepos) {
    dependencies.documentRepository =
      remoteRepos.documentRepository as CoreDependencies['documentRepository']
    dependencies.taskRepository = remoteRepos.taskRepository as CoreDependencies['taskRepository']
    // The context builder also resolves the block's live environment per step
    // (`environmentProvisioning.resolveForBlock` → `environmentRegistryRepository.getByBlock`,
    // null when no env is provisioned — the common path). Route both environment repos so the
    // service `createCore` builds reads org state remotely. NOTE: a remotely-stored env access
    // cipher is sealed with the mothership's key, which never reaches the laptop, so actually
    // DECRYPTING a provisioned env's creds locally is a later (secrets-delegation) slice — only
    // the non-secret block→env mapping read is on the basic run path here.
    dependencies.environmentRegistryRepository =
      remoteRepos.environmentRegistryRepository as CoreDependencies['environmentRegistryRepository']
    dependencies.environmentConnectionRepository =
      remoteRepos.environmentConnectionRepository as CoreDependencies['environmentConnectionRepository']
    // The environments management panel also reads/edits the workspace's custom-manifest-type
    // catalog (`EnvironmentConnectionService.listCustomTypes`/`upsertCustomType`), built directly
    // over the absent `db` by `selectNodeEnvironmentsDeps`. Route it from the remote registry too so
    // the connection + infra-handler management surface is functional (no secrets — just manifest
    // metadata; the RPC allow-list gates its CRUD). Provisioning WRITES stay db-direct/off (a later
    // secrets-delegation slice), like the environment registry above.
    dependencies.customManifestTypeRepository =
      remoteRepos.customManifestTypeRepository as CoreDependencies['customManifestTypeRepository']
    // The prompt-fragment library (`FragmentLibraryService`, built directly over the absent `db`
    // by `selectNodeFragmentLibraryDeps`) — its management surface (list/create/update/delete
    // fragments + list/link sources) is served remotely so the library panels are functional in
    // mothership mode; rows carry no secrets, and the RPC allow-list gates each method by its
    // `(ownerKind, ownerId)` scope. Repo-SYNC (the source service's GitHub reads) stays
    // db-direct/off — the mothership owns GitHub sync.
    //
    // Route only when the library is ALREADY configured (`config.fragmentLibrary.enabled` — else
    // these are absent). UNLIKE the document/task/env repos above (whose modules need extra deps,
    // so setting the repo alone leaves the module off), the fragment module assembles from
    // `promptFragmentRepository` ALONE — so unconditionally setting it would spuriously turn the
    // module ON and force fragment resolution on EVERY run against a mothership that may not wire
    // the repo. Overriding in place preserves the "module only when configured" gate while swapping
    // the (db-less, broken) Drizzle repo for the remote one.
    if (dependencies.promptFragmentRepository) {
      dependencies.promptFragmentRepository =
        remoteRepos.promptFragmentRepository as CoreDependencies['promptFragmentRepository']
    }
    if (dependencies.fragmentSourceRepository) {
      dependencies.fragmentSourceRepository =
        remoteRepos.fragmentSourceRepository as CoreDependencies['fragmentSourceRepository']
    }
    // The Claude Skills library, same shape as the fragment library above: swap the
    // (db-less, broken) Drizzle repos for the remote ones when the mothership exposes
    // them. Until the mothership RPC surfaces skills, `remoteRepos.*` is undefined, which
    // leaves the skill module UNassembled in mothership mode (the controller 503s) rather
    // than assembling over a broken db — a clean opt-in follow-up, like fragment repo-sync.
    if (dependencies.accountSkillRepository) {
      dependencies.accountSkillRepository =
        remoteRepos.accountSkillRepository as CoreDependencies['accountSkillRepository']
    }
    if (dependencies.skillSourceRepository) {
      dependencies.skillSourceRepository =
        remoteRepos.skillSourceRepository as CoreDependencies['skillSourceRepository']
    }
  }

  return {
    ...createCore(dependencies),
    config,
    // The deployment-wide trusted web-search upstream (built from `WEB_SEARCH_*` env above),
    // read by `WebSearchProxyController` as the fallback when a run's account has no keys.
    ...(defaultWebSearchUpstream ? { defaultWebSearchUpstream } : {}),
    // The same checkout-free repo resolver the engine binds pre/post-ops with, surfaced so
    // the shared service-spec read controller can read the `spec/` artifact off main.
    resolveRunRepoContext: dependencies.resolveRunRepoContext,
    // The block→service→repo resolver, surfaced so the task-search controller can scope a
    // GitHub-issue search to the originating service's repo (and refuse it when unlinked).
    resolveRepoTarget,
    agentRunRepository: repos.agentRunRepository,
    // Execution-scoped repo, surfaced for the conformance suite's compareAndSwap parity check.
    executionRepository: repos.executionRepository,
    // The repository registry the mothership-mode machine API (`/internal/persistence`) reflects
    // over, so a Node deployment can act as a mothership for mothership-mode local nodes. The
    // controller gates which repo+method is callable (allow-list) and account-scopes each call;
    // exposing the whole `dependencies` (which carries every repo under its canonical name) is
    // safe. `agentRunRepository` is the one repo NOT part of `CoreDependencies` (the engine's
    // Core never reads it — it's surfaced separately above for `AgentRunController`), so fold it
    // in explicitly, else the board's retry/stop `getRef` call comes back `... is not wired`.
    // Sourced identically on both facades so they attach the same registry surface.
    // Mothership-side GitHub token delegation (`POST /internal/github/installation-token`):
    // when this deployment's GitHub App is configured, a machine-authed mothership-mode node
    // can mint the short-lived installation tokens its agent containers/gates need — the App
    // private key never leaves this service. The registry satisfies the seam structurally.
    // Wired symmetrically on the Cloudflare facade.
    ...(appRegistry ? { githubTokenDelegation: appRegistry } : {}),
    // Mothership-side real-time UPSTREAM delivery (`POST /internal/events/publish`): when this
    // deployment is a mothership (its realtime transport is wired), a machine-authed mothership-mode
    // node's relayed engine events land in this deployment's OWN fan-out (`options.realtimeSink` —
    // the hub, or the layered propagator on a multi-node deployment), so hosted teammates on the
    // shared board see the local node's activity live. Wired symmetrically on the Cloudflare facade
    // (the per-workspace WorkspaceEventsHub Durable Object). Absent realtime ⇒ the endpoint 503s.
    ...(options.realtimeSink
      ? { machineEventRelay: new LocalMachineEventRelay(options.realtimeSink) }
      : {}),
    repositories: {
      ...dependencies,
      agentRunRepository: repos.agentRunRepository,
      // The binary-artifact METADATA store (visual-confirmation gate screenshots/references) is
      // not part of `CoreDependencies` (it's composed into `resolveBinaryArtifactStore`, not the
      // engine's Core), so fold it into the reflected registry explicitly — else a mothership-mode
      // node's artifact reads/writes come back `... is not wired`. The blob BYTES stay per-account
      // local; only the metadata is proxied.
      binaryArtifactMetadataStore: repos.binaryArtifactMetadataStore,
      // The sensitive per-service test-credential store is org/durable state the engine reads via
      // the `resolveTestSecretRefs` FUNCTION (never the repo directly), so it isn't in
      // `CoreDependencies` either — fold it in explicitly, else a mothership-mode node's tester
      // run-path read + the inspector CRUD come back `... is not wired`. Only the SEALED blob is
      // proxied (decrypted service-side under the LOCAL key), like the observability/runner-pool
      // connections.
      testSecretsRepository: repos.testSecretsRepository,
      // GitHub projection + installation reads the mothership serves over the persistence RPC even
      // when its OWN github service is off. A mothership-mode local node reaches GitHub by token
      // DELEGATION (no local App), which enables `container.github`, so its board snapshot
      // (`github.service.listRepos` → `repoProjectionRepository.list`) and run-path repo resolution
      // (`githubInstallationRepository.getByWorkspace` + `repoProjectionRepository.list`) read the
      // projection over RPC. Both are plain org tables the mothership owns, constructed
      // unconditionally above — so reflect them regardless of `config.github.enabled` (they land in
      // `dependencies` only when the github MODULE is wired), else a mothership without its own App
      // configured 500s that board load with `... is not wired`. Allow-listed in
      // `REMOTE_PERSISTENCE_METHODS`; folded in explicitly like the stores above.
      repoProjectionRepository,
      githubInstallationRepository,
    } as unknown as PersistenceRegistry,
    // App-owned backend registries, surfaced so the workspace snapshot's backend-kind
    // selectors (`environmentBackendKinds` / `runnerBackendKinds`) read the registered kinds.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The consensus transcript store, for the read endpoint (window load / reload).
    consensusSessionRepository: repos.consensusSessionRepository,
    // Resolves the per-account binary-artifact store (screenshots) for the artifact
    // controllers + the visual-confirmation gate (configured per-account in the UI).
    resolveBinaryArtifactStore,
    // Stock/remote Node has NO built-in container runtime, so container agents run ONLY on a
    // self-hosted runner pool — an unregistered pool means no agent can run, which the infra-setup
    // banner should surface. Local mode injects its own per-run-host-container `resolveTransport`
    // (so the pool is optional there); detect that by the absence of the default pool transport.
    agentExecutorRequiresRunnerPool: options.resolveTransport === undefined,
    // A missing ephemeral-environment provider is a real setup gap ONLY when no zero-config
    // in-container test-env default exists. Stock Node's sole test-env backend is the
    // `environment-provider`, so it's required here; local mode on a Docker-family runtime
    // advertises `local-compose` (docker-compose in the run's container, no connection), which
    // flips this false so the "test environment not configured" banner stays quiet. Derived from
    // the capability descriptor local already populated, so the two can't drift.
    ephemeralEnvironmentsRequireProvider: !testEnvHasZeroConfigDefault(config.infrastructure),
    // pg-boss-backed async GitHub ingest when the durable engine is wired (the real
    // server drains the queue via `startGitHubSyncWorker`); inline fallback with no boss.
    // Built once above so the skill-freshness fan-out shares this same instance.
    gateways,
    // Source-control PAT login: lets a user sign in with their own GitHub/GitLab PAT via
    // `/auth/pat`, held to the server's login/org/domain allowlist. Local mode overrides this
    // (via its container spread) with a configured-token, allowlist-exempt registry.
    vcsIdentity: buildNodeVcsIdentityRegistry(config),
    // The app-owned VCS provider registry the neutral webhook route resolves a provider from.
    vcsRegistry,
    // The sensitive per-service test-credential store the shared test-secrets controller reads;
    // present when the shared ENCRYPTION_KEY is configured.
    ...(testSecretsService ? { testSecrets: testSecretsService } : {}),
    // The vendor-credential (subscription token pool) service the shared controller
    // reads; present when the shared ENCRYPTION_KEY is configured.
    subscriptions,
    // The per-user individual-usage subscription store (Claude); present when the
    // shared ENCRYPTION_KEY is configured.
    personalSubscriptions,
    // The direct-provider API-key pool (account/workspace/user); present when the
    // shared ENCRYPTION_KEY is configured.
    apiKeys,
    // The inbound public-API key store; present when the shared ENCRYPTION_KEY is configured.
    publicApiKeys,
    // Whether the opt-in Cloudflare Workers AI lib is enabled (REST creds present).
    cloudflareModelsEnabled,
    // The direct-provider base-URL resolver the catalog uses to gate selectability on a
    // resolvable endpoint (e.g. LiteLLM stays unselectable until LITELLM_BASE_URL is set).
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    // The per-user locally-run model endpoints store; present when ENCRYPTION_KEY is set.
    localModelEndpoints,
    // The per-user generic secret store (GitHub PAT, …); present when ENCRYPTION_KEY is set.
    userSecrets,
    // The per-user "repos my PAT can reach" projection (board redaction + picker expansion);
    // Postgres-backed, so absent in the no-DB mothership node (redaction degrades to visible).
    userRepoAccess: db ? new DrizzleUserRepoAccessRepository(db) : undefined,
    // The per-workspace OpenRouter dynamic-catalog store; present when the API-key pool is.
    openRouterCatalog,
    // Flush + release the external trace sink on graceful shutdown so the OpenTelemetry SDK
    // exporter's final batch of spans/metrics isn't dropped and its background timers are
    // cleared. Best-effort; a no-op for the fetch-based Langfuse sink and when nothing is
    // wired. (The local facade composes this into its own `onShutdown` — see its container.)
    onShutdown: async () => {
      await traceSink?.shutdown?.()
    },
  }
}

/**
 * Wire the task-source integration for the Node facade when it is enabled (the
 * `tasks` module then assembles so tenants can connect Jira through the existing
 * UI). Returns the `CoreDependencies` fragment plus the connection repository so the
 * tracker can resolve each workspace's Jira credentials from the same store.
 * No registered providers → `{ deps: {} }` and both the tasks module and the Jira
 * tracker stay off (the encryption key is guaranteed present by `loadTasksConfig`).
 */
/**
 * Wire the document-source integration for the Node facade, mirroring the Worker's
 * `selectDocumentsDeps`: the shared `@cat-factory/integrations` provider shells
 * (Confluence/Notion always; GitHub-docs only when a GitHub client is available, since
 * it reuses the workspace's App installation), the Drizzle connection/document repos,
 * and — in `llm` planner mode — the default model ref the doc→board planner runs with
 * (the container's `modelProvider` is shared). Source credentials are encrypted at rest
 * under a documents-scoped HKDF info, keyed by the shared ENCRYPTION_KEY.
 */
function selectNodeDocumentsDeps(
  config: AppConfig,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): Partial<CoreDependencies> {
  if (!config.documents.enabled || !config.documents.encryptionKey) return {}
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
  if (config.documents.sources.includes('github') && githubClient) {
    providers.push(new GitHubDocsProvider({ githubClient, installations, logger }))
  }
  if (providers.length === 0) return {}
  return {
    documentSourceProviders: providers,
    documentConnectionRepository: new DrizzleDocumentConnectionRepository(
      db,
      new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey,
        info: 'cat-factory:documents',
      }),
    ),
    documentRepository: new DrizzleDocumentRepository(db),
    ...(config.documents.planner === 'llm'
      ? { documentPlannerModel: config.agents.routing.default.ref }
      : {}),
  }
}

/**
 * Wire the ephemeral-environment integration for the Node facade when enabled,
 * mirroring the Worker's `selectEnvironmentsDeps`: the Drizzle connection + registry repos
 * and the environment-scoped `SecretCipher`. The provider itself is resolved per-workspace
 * from the env-backend registry by the stored `kind` (built-in `manifest`/`kubernetes`, or a
 * deployment's programmatically-registered custom kind), so nothing is injected here.
 * Per-tenant management-API secrets are encrypted at rest with the shared ENCRYPTION_KEY.
 * No key configured → `{}` and the module stays off (there is no separate enable flag).
 */
function selectNodeEnvironmentsDeps(config: AppConfig, db: DrizzleDb): Partial<CoreDependencies> {
  if (!config.environments.encryptionKey) return {}
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind`. Node honors custom-CA / insecure-skip TLS (undici), so a Kubernetes env config
  // with a CA is allowed (environmentCustomTlsSupported defaults to supported).
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new DrizzleEnvironmentConnectionRepository(db),
    environmentRegistryRepository: new DrizzleEnvironmentRegistryRepository(db),
    // The workspace-defined custom-manifest-type catalog is a workspace feature on every facade.
    customManifestTypeRepository: new DrizzleCustomManifestTypeRepository(db),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
    // Deployment-level, additive extensions to the built-in provisioning-detection conventions.
    ...(config.environments.detectionConventions
      ? { detectionConventions: config.environments.detectionConventions }
      : {}),
  }
}
