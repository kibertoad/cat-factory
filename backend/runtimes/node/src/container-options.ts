// The Node facade's composition-root OPTIONS — the whole surface a deployment (or a sibling
// facade, or a test) can hand `buildNodeContainer`/`startNode`: the persistence handles, the
// app-owned registries, the extension seams, and the declarative SEEDS a deployment ships with.
//
// Split out of `container.ts` when the shared-stack seed option pushed that file past its size
// budget: the declaration block is a cohesive unit that reads as documentation, and the builder
// beside it is the code. Re-exported from `container.ts`, so no call site changed. (The same move
// `ExecutionService.ts` made with `ExecutionServiceDependencies`.)

import { type AgentKindRegistry } from '@cat-factory/agents'
import {
  type BackendRegistries,
  type DeployJobClient,
  type RegisterHandlerInput,
} from '@cat-factory/integrations'
import {
  type CreateSharedStackInput,
  type DeployCloneTarget,
  type GitHubClient,
  type GitHubInstallationRepository,
  type LocalModelEndpointRepository,
  type ModelProviderResolver,
  type PersonalSubscriptionRepository,
  type ProviderApiKeyRepository,
  type ProviderSubscriptionTokenRepository,
  type RunnerPoolProvider,
  type SubscriptionActivationRepository,
} from '@cat-factory/kernel'
import {
  type CoreDependencies,
  type GateRegistry,
  type JudgeRegistry,
  type StepResolverRegistry,
} from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ResolveRepoOrigin,
  type ResolveRunnerTransport,
} from '@cat-factory/server'
import { type GateProviderOverrides } from '@cat-factory/gates'
import {
  type AppCaches,
  type InitiativePresetRegistry,
  type NotificationChannel,
  type PipelineRegistry,
  type PreviewTransport,
  type ProviderRegistry,
  type BinaryGeneratorRegistry,
  type BinaryGeneratorSource,
  type FoundationalBuiltinSource,
  type FoundationalServiceRegistry,
  type TaskTypeRegistry,
  type ToolSecretResolver,
  type VcsProviderRegistry,
} from '@cat-factory/kernel'
import { type PgBoss } from 'pg-boss'
import { type DrizzleDb } from './db/client.js'
import { type LocalEventSink, type RealtimeRoomWatcher } from './realtime.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { type ContentStorageBackend } from '@cat-factory/contracts'
import type { ModelProviderResolverWrapDeps } from './container.js'

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
   * A deployment's pre-declared environment-handler seeds (each a `RegisterHandlerInput`),
   * forwarded into `createCore`. When present (and the environments module is wired) the container
   * exposes an `environmentHandlerSeeder`; `start()`/`bootServer` boot-backfill every existing
   * workspace and `WorkspaceService.create` seeds each new one, so a deployment supplies its infra
   * handler from config with no manual SPA step. Absent / empty ⇒ no seeding.
   */
  seedEnvironmentHandlers?: RegisterHandlerInput[]
  /**
   * A deployment's pre-declared SHARED STACKS (each a `CreateSharedStackInput`) — the long-lived
   * compose infra its services' preview environments attach to — forwarded into `createCore`.
   * Wired exactly like {@link seedEnvironmentHandlers}: the container exposes a
   * `sharedStackSeeder`, `start()`/`bootServer` boot-backfill every existing workspace, and
   * `WorkspaceService.create` seeds each new one.
   *
   * A seed's ordered compose layers may be INLINE documents, paths in ANOTHER repo, or paths in
   * the stack's own clone — so a deployment can describe a service's full infra dependencies in
   * code, with no repo of its own and no manual SPA step. Absent / empty ⇒ no seeding.
   */
  seedSharedStacks?: CreateSharedStackInput[]
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
   * The room-observability side of the SAME realtime transport `realtimeSink` writes to (a
   * {@link NodeRealtimeHub} satisfies both). Supplied only where something needs to react to a
   * workspace gaining/losing its first/last local subscriber — today just mothership mode, whose
   * inbound subscriber opens one upstream stream per watched workspace. A standard Node boot
   * leaves it unset and nothing observes rooms.
   */
  realtimeRooms?: RealtimeRoomWatcher
  /**
   * Extra notification delivery channels composed alongside the ones this facade builds (in-app +
   * Slack). The local facade contributes its mothership `RemoteNotificationChannel` here, so a
   * notification raised on a laptop is delivered by the mothership through the org's external
   * transports (whose credentials never reach the machine). Unset on a stock Node deployment.
   */
  notificationChannels?: NotificationChannel[]
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
   * The app-owned JUDGE registry — the fourth step-taxonomy bucket (an LLM assessment against a
   * rubric, compared to a per-task threshold, disposed as advance/park/bounce/fail). Rides its own
   * option like `gateRegistry`; defaults to an EMPTY registry (the platform ships no built-in
   * judges). Threaded into `createCore` + re-exposed on Core; the conformance suite injects a
   * pre-loaded one to assert the seam is symmetric across runtimes.
   */
  judgeRegistry?: JudgeRegistry
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
   * The app-owned custom task-type registry (deployment-registered namespaced task types). Rides
   * its own option like `pipelineRegistry`; defaults (inside `createCore`) to
   * `defaultTaskTypeRegistry()`. A deployment registers its task types on it so they surface in the
   * snapshot (`customTaskTypes`) + resolve their default pipeline; the conformance suite injects a
   * pre-loaded one to assert the seam is symmetric.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * The app-owned foundational-service registry (the shared capabilities a deployment declares in
   * CODE). Rides its own option like `taskTypeRegistry`; defaults (inside `createCore`) to
   * `defaultFoundationalServiceRegistry()`. A deployment registers its estate on it so every
   * workspace catalog carries it as the `builtin` tier, and boot validation refuses a malformed
   * definition. See backend/docs/adr/0031-foundational-services.md.
   */
  foundationalServiceRegistry?: FoundationalServiceRegistry
  /**
   * The app-owned registry of GENERATIVE BINARY INTEGRATIONS (the image / music / video
   * generation APIs a deployment pays for, declared in CODE). Rides its own option like
   * `foundationalServiceRegistry`; defaults (inside `createCore`) to
   * `defaultBinaryGeneratorRegistry()` — EMPTY, since the platform ships none. A deployment
   * registers its integrations on it so a step carrying the `binary-output` trait can select
   * them (`stepOptions.binaryOutput.generatorIds`), and boot validation refuses a malformed
   * definition, an unusable credential name or a cleartext endpoint.
   *
   * Deliberately NOT folded into the foundational registry above: that catalog is what a design
   * is expected to build ON, while an integration is an instrument a specific step is pointed at.
   * See docs/initiatives/binary-output-foundational-storage.md.
   */
  binaryGeneratorRegistry?: BinaryGeneratorRegistry
  /**
   * Where the catalog's `builtin` tier is READ from, when it is not this process's own registry
   * above. Set by exactly one caller — the local facade booting in MOTHERSHIP mode, which reads
   * the mothership's registry over `GET /internal/foundational-services` because the estate is
   * org state and a node's own build can only hold a second, drifting copy of it. See
   * `kernel/src/ports/foundational-builtins.ts`.
   */
  foundationalBuiltinSource?: FoundationalBuiltinSource
  /**
   * Where the deployment's GENERATIVE BINARY INTEGRATIONS are READ from, when that is not this
   * process's own registry above. Set by exactly one caller — the local facade booting in
   * MOTHERSHIP mode, which reads the mothership's registry over `GET /internal/binary-generators`
   * because the set the pipeline builder OFFERED and the set run admission RESOLVES have to be
   * one set. See `kernel/src/ports/binary-generators.ts`.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
  /**
   * Build the resolver that supplies a registered capability's CREDENTIALS at dispatch — a tool
   * server's (MCP) and a generative binary integration's alike. Called once at composition, with
   * this process's environment, and defaulting to `createEnvToolSecretResolver(env)`.
   *
   * This is the seam the `ToolSecretResolver` port was designed for and did not have: a
   * deployment holding PER-WORKSPACE credentials (its own sealed store, Vault, the Cloudflare
   * Secrets Store) implements the port and passes it here, and nothing else in the dispatch path
   * changes. Without it, reaching the port meant abandoning the facade and reassembling the boot
   * sequence — forgoing exactly the preflights `start()` exists to provide — to change one
   * argument.
   *
   * A FACTORY rather than an instance so the narrower env bound composes in one line, and so the
   * Worker's per-request build can take the same option shape:
   *
   *     createToolSecretResolver: (env) => createEnvToolSecretResolver(env, { allowKeys: [...] })
   *
   * A custom resolver does NOT weaken the reserved-key floor: a key naming a platform
   * configuration variable is dropped at the call site, before any resolver is asked.
   */
  createToolSecretResolver?: (env: NodeJS.ProcessEnv) => ToolSecretResolver
  /**
   * Whether this node's own environment answers a capability credential the workspace has NOT
   * stored. Defaults to true, which is what a single-tenant install, a local checkout and a CI
   * environment all want: the operator sets the variable they already set for everything else.
   *
   * A MULTI-TENANT deployment sets it false. With the fallback on, a workspace that has typed
   * nothing silently authenticates its runs as whoever set the variable, and the vendor bill lands
   * in that account, which is the single-tenant answer this store exists to replace. Off, an
   * unstored key resolves to nothing, the capability reports itself unavailable to its agent, and
   * the credential checklist stops telling the operator that a blank row may still resolve.
   *
   * Ignored when {@link createToolSecretResolver} is set: that resolver replaces the whole chain,
   * so there is no fallback of ours left to keep or drop. Whether a HOSTED deployment should
   * default to store-only is a product call, and this option deliberately does not make it.
   */
  capabilityCredentialEnvironmentFallback?: boolean
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
