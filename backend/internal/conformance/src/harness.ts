import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateProviderOverrides } from '@cat-factory/gates'
import type {
  BackendRegistries,
  DeployJobClient,
  DetectionConventions,
} from '@cat-factory/integrations'
import type { TesterQualityReviewer } from '@cat-factory/orchestration'
import type {
  AgentRunRepository,
  BlockRepository,
  DocInterviewRepository,
  DocumentRepository,
  DeployCloneTarget,
  EnvironmentProvider,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  InitiativePresetRegistry,
  InitiativeRepository,
  LlmCallActivity,
  NotificationRepository,
  ResolveBinaryArtifactStore,
  ResolveRunRepoContext,
  RunRepoContext,
  Service,
  TaskSourceProvider,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type { FakeAgentOptions } from './FakeAgentExecutor.js'
import type { OnboardingProbe } from './onboarding.js'

/**
 * An {@link ExecutionEventPublisher} that records every run snapshot the engine
 * pushes, deep-cloned at emit time. The suite drives runs directly (no live
 * WebSocket), so this is how it asserts INTERMEDIATE transitions — e.g. that a
 * step's model is already set on the first "spinning up container" emit — which
 * `drive`'s final-state return can't reveal. Each facade harness wires one over the
 * `executionEventPublisher` core override and exposes it via {@link ConformanceApp.executionEmits}.
 */
export class RecordingEventPublisher implements ExecutionEventPublisher {
  readonly emits: ExecutionInstance[] = []
  /** Every compact `llmCall` activity the proxy pushed (via `llmCallObserved`), in order. */
  readonly llmCalls: LlmCallActivity[] = []
  /**
   * Every coarse `boardChanged` the engine/board service pushed, in order — so the suite can
   * assert a human board mutation (add/rename/move/reparent/delete) emits a real-time signal on
   * every runtime, not just returns over REST.
   */
  readonly boardEvents: { workspaceId: string; reason: string; blockId: string | null }[] = []

  async executionChanged(_workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // Clone so the engine's later in-place mutations don't rewrite recorded history.
    this.emits.push(structuredClone(instance))
  }

  async boardChanged(workspaceId: string, reason: string, blockId?: string | null): Promise<void> {
    this.boardEvents.push({ workspaceId, reason, blockId: blockId ?? null })
  }
  async bootstrapChanged(): Promise<void> {}
  async notificationChanged(): Promise<void> {}
  async llmCallObserved(_workspaceId: string, activity: LlmCallActivity): Promise<void> {
    this.llmCalls.push(structuredClone(activity))
  }
}

// The seam the conformance suite drives. Each runtime facade implements a
// `ConformanceHarness` over its own composition root (the Cloudflare Worker over
// D1 inside workerd; the Node service over real Postgres) and the suite runs the
// SAME assertions through it — so any behavioural drift between runtimes fails a
// test rather than shipping silently.

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

/**
 * One built application, bound to a runtime's real persistence and a deterministic
 * {@link FakeAgentExecutor}. Mirrors the shape of the Worker's existing `TestApp`
 * so a harness is a thin adapter, not a rewrite.
 */
export interface ConformanceApp {
  /** Issue an HTTP request through the facade's real Hono `app.fetch`. */
  call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<TestResponse<T>>
  /** Create (and optionally seed) a workspace, returning its snapshot. */
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Create a workspace owned by an ORG account (a fresh org + owner created straight through
   * the facade's services, since dev-open has no signed-in user to drive the HTTP account flow).
   * Unseeded by default; pass `seed: true` for the demo board + built-in pipelines (e.g. the
   * public-API test, which needs the account AND the seeded `pl_initiative_breakdown` pipeline).
   * Backs the assertion that an individual-only subscription (Claude) is refused for org-owned
   * workspaces on every runtime.
   */
  createOrgWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate) and return the latest executions. In production a
   * durable driver does this (Cloudflare Workflows / pg-boss); the suite drives the
   * engine directly so assertions are deterministic and runtime-independent.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
  /**
   * Start a run straight through the facade's real `ExecutionService`, optionally with a
   * per-run gate override (the initiative-preset gate-override seam) — a path no HTTP route
   * exposes. Lets the suite assert the override lands on the persisted run steps (and drive
   * the run's pause/advance) identically on D1 and Postgres. `initiatedBy` is left
   * system-null and `origin` defaults to manual, matching a loop-spawned run.
   */
  startExecution(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    opts?: { gates?: boolean[] },
  ): Promise<ExecutionInstance>
  /**
   * Poll a bootstrap run to a terminal state (the Node/CF facades durably drive this via
   * pg-boss / a BootstrapWorkflow; the suite drives it directly against a deterministic
   * {@link FakeRepoBootstrapper}). Returns the number of polls taken.
   */
  driveBootstrap(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
  /**
   * Poll an env-config-repair run to a terminal state (the Node/CF facades durably drive
   * this via pg-boss / an EnvConfigRepairWorkflow; the suite drives it directly against a
   * deterministic {@link FakeEnvConfigRepairer}, whose `done` poll triggers the service's
   * injected re-validation). Returns the number of polls taken.
   */
  driveEnvConfigRepair(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
  /**
   * Every {@link ExecutionInstance} the engine emitted (via `executionChanged`), in
   * order and deep-cloned at emit time — so the suite can assert intermediate
   * transitions `drive`'s final state can't show. Optionally filtered to one block.
   */
  executionEmits(blockId?: string): ExecutionInstance[]
  /**
   * Every coarse `boardChanged` the board service pushed (via `boardChanged`), in order —
   * so the suite can assert a human board mutation emits a real-time signal on every runtime.
   * Optionally filtered to events naming a specific block.
   */
  boardEmits(blockId?: string): { workspaceId: string; reason: string; blockId: string | null }[]
  /**
   * Seed an already-"incorporated" requirements review for a block straight into the
   * facade's real review store, so the suite can assert the engine substitutes the
   * reworked requirements into the agent context — on EVERY runtime, not just the one
   * a feature-specific spec happens to cover. (The review/rework run themselves call a
   * real LLM, so the suite seeds the persisted outcome rather than driving them.)
   */
  seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string): Promise<void>
  /**
   * Seed a `ready` review with one still-open finding straight into the facade's real
   * review store, so the suite can assert the async-incorporate route's pre-LLM guard
   * (incorporation refused while a finding is unanswered) on every runtime without a live
   * reviewer model.
   */
  seedReadyReview(workspaceId: string, blockId: string): Promise<void>
  /**
   * Seed an already-"incorporated" clarity (bug-report triage) review for a block straight
   * into the facade's real clarity store, so the suite can assert the engine substitutes the
   * clarified report into the agent context — on EVERY runtime (the clarity mirror of
   * {@link seedIncorporatedReview}).
   */
  seedIncorporatedClarityReview(workspaceId: string, blockId: string, report: string): Promise<void>
  /**
   * The facade's execution-scoped run repository over its real store, so the suite can
   * assert the optimistic-concurrency `compareAndSwap` semantics (a stale write is
   * refused, not clobbering) identically on D1 and Postgres.
   */
  executionRepository(): ExecutionRepository
  /**
   * The facade's kind-spanning `agent_runs` view over its real store, so the suite can assert
   * the stale-run sweeper's read primitives behave identically on D1 and Postgres: `listStale`
   * returns each candidate's `updatedAt` (the hard-stall clock reads it) and `liveRunIds`
   * filters out terminal runs (the local orphaned-container reap keys off it).
   */
  agentRunRepository(): AgentRunRepository
  /**
   * The facade's block repository over its real store, so the suite can assert the batched
   * cross-workspace read (`findByIds`) resolves each block to its HOME workspace identically
   * on D1 and Postgres.
   */
  blockRepository(): BlockRepository
  /**
   * The facade's initiative repository over its real store. Lets the suite seed an initiative
   * entity (with a registered preset) directly, so it can assert the engine folds that preset's
   * per-kind steering onto a SPAWNED run's agent context (D1) — a spawned run is a task carrying
   * `block.initiativeId`, which no HTTP route creates without driving a full planning loop.
   */
  initiativeRepository(): InitiativeRepository
  /**
   * The facade's notification repository over its real store, so the suite can assert the
   * escalation sweep's single-statement `escalateStaleOpen` flips exactly the overdue open
   * cards — and returns them for re-delivery — identically on D1 and Postgres.
   */
  notificationRepository(): NotificationRepository
  /**
   * The facade's document projections repository over its real store, so the suite can assert the
   * WS1 workspace+`DocKind` role-link persistence (template singular-replace, exemplar multi,
   * clear) identically on D1 and Postgres. The link WRITE surface is workspace-scoped and needs an
   * imported document row, which the dev-open HTTP `call` path can't create (import needs a live
   * source); like the other probes, the persistence is exercised through the repository directly.
   */
  documentRepository(): DocumentRepository
  /**
   * The facade's interactive document-interview session repository over its real store, so the
   * suite can assert the WS5 session persistence (upsert / getByBlock-newest-wins / get /
   * deleteByBlock) identically on D1 and Postgres. A session is created by the interviewer LLM
   * (off in conformance), so — like the document role-link probe — the persistence is exercised
   * through the repository directly rather than an HTTP flow.
   */
  docInterviewRepository(): DocInterviewRepository
  /**
   * Seed an account-owned service row linked to a frame block straight into the facade's real
   * service store, so the frame-deletion test can assert the batched frame→service reclaim
   * actually deletes the backing service on every runtime. The only production path that
   * creates a service is a GitHub connection (off in conformance), so the suite seeds the row
   * directly rather than driving that flow.
   */
  seedService(service: Service): Promise<void>
  /** Read a service back by id (null once reclaimed), for the frame-deletion reclaim assertion. */
  getService(id: string): Promise<Service | null>
  /**
   * The facade's user-identity + onboarding services over its real store, so the suite
   * can assert identity/invitation behaviour parity (the unauthenticated HTTP `call`
   * path can't reach the authenticated identity layer).
   */
  onboarding(): OnboardingProbe
  /**
   * The facade's per-user locally-run model endpoints service over its real store, so the
   * suite can assert repository/service parity (CRUD + the optional bearer-key encryption
   * round-trip + the enabled-models JSON) across D1 and Postgres. The HTTP routes are
   * user-scoped and the dev-open `call` path has no signed-in user, so — like personal
   * subscriptions — this is exercised through the service directly. Undefined when the
   * facade did not wire the store (no ENCRYPTION_KEY).
   */
  localModelEndpoints?(): LocalModelEndpointsProbe | undefined
  /**
   * The facade's per-user generic secret service (a GitHub PAT today) over its real store,
   * so the suite can assert repository/service parity (store → system-encrypted resolve +
   * the kind descriptor) across D1 and Postgres. User-scoped like local model endpoints, so
   * exercised through the service directly. Undefined when the facade didn't wire the store.
   */
  userSecrets?(): UserSecretsProbe | undefined
  /**
   * The facade's per-user settings service (the user-tier spend budget) over its real store,
   * so the suite can assert repository parity (the `user_settings` round-trip) across D1 and
   * Postgres. User-scoped, so exercised through the service directly (the dev-open `call` path
   * has no signed-in user). Undefined when the facade did not wire the store.
   */
  userSettings?(): UserSettingsProbe | undefined
  /**
   * The facade's per-workspace OpenRouter dynamic-catalog service over its real store, so the
   * suite can assert repository/service parity (enabled-subset round-trip) across D1 and
   * Postgres. The HTTP routes need a signed-in user the dev-open `call` path lacks, so the
   * persistence is exercised through the service directly. Undefined when the facade did not
   * wire the store (no ENCRYPTION_KEY / API-key pool).
   */
  openRouterCatalog?(): OpenRouterCatalogProbe | undefined
  /**
   * The facade's per-workspace private package-registry service over its real store. The
   * CRUD is workspace-scoped and asserted over the HTTP `call` path; this probe covers the
   * DISPATCH half — the decrypt that puts host+token on a container job body — which no
   * HTTP route exposes (tokens are write-only on the wire). Undefined when the facade did
   * not wire the store (no ENCRYPTION_KEY).
   */
  packageRegistries?(): PackageRegistriesProbe | undefined
}

/** The dispatch-side subset of the package-registry service the conformance suite drives. */
export interface PackageRegistriesProbe {
  resolveForDispatch(
    workspaceId: string,
  ): Promise<{ ecosystem: string; host: string; scopes: string[]; token: string }[]>
}

/** One OpenRouter model's cached metadata, as stored in the dynamic catalog. */
export interface OpenRouterCatalogModel {
  id: string
  name: string
  contextLength?: number
  inputPerMillion: number
  outputPerMillion: number
}

/** The subset of the OpenRouter-catalog service the conformance suite drives. */
export interface OpenRouterCatalogProbe {
  get(workspaceId: string): Promise<{ models: OpenRouterCatalogModel[] }>
  upsert(
    workspaceId: string,
    input: { models: OpenRouterCatalogModel[] },
  ): Promise<{ models: OpenRouterCatalogModel[] }>
}

/** The subset of the local-model-endpoints service the conformance suite drives. */
export interface LocalModelEndpointsProbe {
  list(
    userId: string,
  ): Promise<{ provider: string; baseUrl: string; hasApiKey: boolean; models: string[] }[]>
  upsert(
    userId: string,
    input: { provider: string; label?: string; baseUrl: string; apiKey?: string; models: string[] },
  ): Promise<{ provider: string; hasApiKey: boolean; models: string[] }>
  resolve(
    userId: string,
    provider: string,
  ): Promise<{ baseUrl: string; apiKey: string | null } | null>
  remove(userId: string, provider: string): Promise<void>
}

/** The subset of the per-user-settings service the conformance suite drives. */
export interface UserSettingsProbe {
  get(userId: string): Promise<{ spendMonthlyLimit: number | null }>
  update(
    userId: string,
    input: { spendMonthlyLimit?: number | null },
  ): Promise<{ spendMonthlyLimit: number | null }>
}

/** The subset of the user-secret service the conformance suite drives. */
export interface UserSecretsProbe {
  store(
    userId: string,
    kind: string,
    input: { secret: string; metadata?: Record<string, string>; label?: string },
  ): Promise<{ kind: string; hasSecret: boolean; metadata?: Record<string, string> }>
  resolve(userId: string, kind: string): Promise<string | null>
  describe(kind: string): {
    kind: string
    supportsTest: boolean
    configFields: { key: string; secret?: boolean }[]
  } | null
}

export interface ConformanceHarness {
  /** Label used in test names + skip diagnostics, e.g. `'cloudflare'` or `'node'`. */
  name: string
  /**
   * Build an app wired with a deterministic agent. `agentOptions` are forwarded to
   * the shared {@link FakeAgentExecutor}; the durable runner is replaced with a
   * no-op so the suite advances runs itself via {@link ConformanceApp.drive}.
   *
   * `opts.cloudflareModelsEnabled` forces the Cloudflare-AI opt-in flag (the Worker
   * binds `AI` in tests, Node never has it) so the provider-key assertions —
   * key-driven model selectability + the pipeline-start provider guard — behave
   * identically on every runtime regardless of the deployment's binding.
   */
  makeApp(agentOptions?: FakeAgentOptions, opts?: ConformanceAppOptions): ConformanceApp
}

export interface ConformanceAppOptions {
  cloudflareModelsEnabled?: boolean
  /**
   * Inject the engine's run-repo resolver so the suite can assert a registered custom
   * kind's pre/post-op hooks run + commit via a checkout-free {@link RepoFiles} — on EVERY
   * runtime, without a real GitHub connection. Each facade harness threads it into its
   * core overrides exactly as a real facade composes it from its GitHub client; the suite
   * supplies a fake backed by an in-memory commit capture.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Inject the per-account binary-artifact store resolver so the suite can drive the
   * pipeline-start binary-storage gate deterministically on EVERY runtime — the Worker
   * test env binds R2 (storage ON by default) while Node/local default to OFF, so the two
   * have no common configurable backend. The suite supplies a non-null resolver to assert a
   * storage-reliant pipeline (the UI Tester) starts + drives, and a null-returning resolver
   * to assert it is refused with a `binary_storage_unconfigured` conflict. Each facade
   * harness threads it into its core overrides exactly as a real facade composes it.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * Inject explicit built-in gate providers (e.g. a faked `CiStatusProvider`). A facade
   * build resets the deployment-global gate providers up-front then re-wires from config;
   * each harness threads these into that per-build wiring so a faked provider survives a
   * per-request container rebuild — the seam by which the suite drives the externalized
   * `@cat-factory/gates` CI gate over a controlled verdict on every runtime.
   */
  gateProviders?: GateProviderOverrides
  /**
   * Inject a native environment provider (carrying the optional repo-config lifecycle
   * capabilities) plus the block-less coords→RepoFiles resolver, so the suite can assert
   * the on-demand `validate-repo` route end-to-end — provider expectations + the wired
   * `resolveRepoFilesForCoords` → real controller/service → real store — on EVERY runtime
   * without a real GitHub connection. Each facade harness threads both into its core
   * overrides exactly as a real facade composes them (the worker/node `environmentProvider`
   * seam + the GitHub-derived coords resolver).
   */
  environmentProvider?: EnvironmentProvider
  resolveRepoFilesForCoords?: (
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: 'github' | 'gitlab' },
  ) => Promise<RunRepoContext | null>
  /**
   * Inject the async, container-backed deploy lifecycle seams (slice 9/10) so the suite can
   * drive a `deployer` step through the CONTAINER render path — dispatch a `deploy` job, poll a
   * stubbed view, finalize — on EVERY runtime, asserting the deploy dispatch is accepted by the
   * facade's wiring and the stubbed view settles to an IDENTICAL `ProvisionedEnvironment`. The
   * suite supplies a fake `deployJobClient` (records the dispatch + replays a canned view) and a
   * `resolveDeployCloneTarget`; each facade harness threads them into its core overrides exactly
   * as a real facade composes them (the Worker's `DeployContainer` client / Node's pool client).
   */
  deployJobClient?: DeployJobClient
  resolveDeployCloneTarget?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
  /**
   * Inject the app-owned backend registries (environment + runner kind → provider), pre-loaded
   * with custom backends, so the suite can assert a deployment-registered custom kind connects,
   * round-trips, and is advertised in the snapshot — on EVERY runtime. Each facade harness
   * threads it into its container build (`buildNodeContainer({ backendRegistries })` / the
   * Worker's `buildContainer` overrides). Absent → the facade's default built-in-only registry.
   */
  backendRegistries?: BackendRegistries
  /**
   * Inject the app-owned agent-kind registry, pre-loaded with a CUSTOM kind, so the suite can
   * assert a deployment-registered kind resolves identically on EVERY runtime (its prompt +
   * pre/post-op hooks + snapshot projection) — replacing the old module-global registration.
   * Each facade harness threads the SAME instance into its container build AND the shared
   * {@link FakeAgentExecutor}. Absent → the facade's default built-ins-only registry.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * Inject the app-owned initiative-preset registry, pre-loaded with a CUSTOM preset, so the suite
   * can assert a deployment-registered preset resolves identically on EVERY runtime (its snapshot
   * descriptor + create-with-preset + its per-kind steering folded onto a spawned run) — replacing
   * the old module-global registration. Each facade harness threads the SAME instance into its
   * container build. Absent → the facade's default built-in-only registry.
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * Inject the test quality-control companion's inline reviewer (a deterministic fake in the
   * suite) so the full QC loop — audit a Tester report, loop the Tester on gaps, settle on an
   * adequate report — is driven on EVERY runtime without a real model. Each facade harness
   * threads it into its core overrides (the `testerQualityReviewer` seam `createCore` reads);
   * absent ⇒ the facade's model-derived reviewer (a pass-through with no model wired).
   */
  testerQualityReviewer?: TesterQualityReviewer
  /**
   * Override the facade's default fake task-source providers with pre-seeded ones, so the suite
   * can drive the recurring `bug-intake` step against a controlled issue backlog — intake pickup
   * (a matching issue is imported, linked and seeds the block) and the no-match no-op (the run
   * completes with every remaining step skipped) — on EVERY runtime. Each facade harness threads
   * this into its `taskSourceProviders` core dep in place of its built-in fakes; the suite holds
   * the same {@link FakeTaskSourceProvider} instance to seed issues + inspect the recorded intake
   * query. Absent → the facade's default fakes.
   */
  taskSourceProviders?: TaskSourceProvider[]
  /**
   * Inject the deployment-level detection-convention extensions (`CoreDependencies.detectionConventions`)
   * so the suite can assert that a convention-added compose name is honoured by service-provisioning
   * detection on EVERY runtime. This is the drift-prone part of the feature — the detection LOGIC is a
   * shared pure function, but each facade must thread `config.environments.detectionConventions` from
   * its own config into the core deps. A facade that forgets that wiring (or wires only one runtime)
   * fails the convention assertion here instead of silently reverting to built-ins. Each facade harness
   * threads it into its container build exactly as a real facade composes it from config.
   */
  detectionConventions?: DetectionConventions
}
