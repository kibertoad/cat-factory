import type { GateProviderOverrides } from '@cat-factory/gates'
import type { BackendRegistries } from '@cat-factory/integrations'
import type {
  EnvironmentProvider,
  ExecutionEventPublisher,
  ExecutionInstance,
  LlmCallActivity,
  ResolveRunRepoContext,
  RunRepoContext,
  Service,
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
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  /** Create (and optionally seed) a workspace, returning its snapshot. */
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Create an unseeded workspace owned by an ORG account (a fresh org + owner created
   * straight through the facade's services, since dev-open has no signed-in user to
   * drive the HTTP account flow). Backs the conformance assertion that an individual-only
   * subscription (Claude) is refused for org-owned workspaces on every runtime.
   */
  createOrgWorkspace(options?: { name?: string }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate) and return the latest executions. In production a
   * durable driver does this (Cloudflare Workflows / pg-boss); the suite drives the
   * engine directly so assertions are deterministic and runtime-independent.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
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
   * The facade's per-workspace OpenRouter dynamic-catalog service over its real store, so the
   * suite can assert repository/service parity (enabled-subset round-trip) across D1 and
   * Postgres. The HTTP routes need a signed-in user the dev-open `call` path lacks, so the
   * persistence is exercised through the service directly. Undefined when the facade did not
   * wire the store (no ENCRYPTION_KEY / API-key pool).
   */
  openRouterCatalog?(): OpenRouterCatalogProbe | undefined
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
   * Inject the app-owned backend registries (environment + runner kind → provider), pre-loaded
   * with custom backends, so the suite can assert a deployment-registered custom kind connects,
   * round-trips, and is advertised in the snapshot — on EVERY runtime. Each facade harness
   * threads it into its container build (`buildNodeContainer({ backendRegistries })` / the
   * Worker's `buildContainer` overrides). Absent → the facade's default built-in-only registry.
   */
  backendRegistries?: BackendRegistries
}
