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
  BoardChange,
  DocInterviewRepository,
  AccountRiskPolicyRepository,
  AccountSettingsRepository,
  DocumentRepository,
  DeployCloneTarget,
  EnvironmentProvider,
  RouteProbe,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  GateRegistry,
  JudgeAssessor,
  BugHuntAssessor,
  FragmentBriefGenerator,
  JudgeRegistry,
  InitiativePresetRegistry,
  StepResolverRegistry,
  InitiativeRepository,
  LlmCallActivity,
  NotificationRepository,
  Pipeline,
  PipelineRegistry,
  PromptFragmentRegistry,
  PrVerificationReportPublisher,
  RequirementReviewRepository,
  ResolveBinaryArtifactStore,
  ResolveRunRepoContext,
  RunRepoContext,
  Service,
  TaskRepository,
  TaskSourceProvider,
  TaskTypeRegistry,
  InlineUseCaseRegistry,
  InlineUseCaseGenerator,
  WorkspaceMemberRepository,
  WorkspaceRepository,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type { DispatchToolServers, LocalModelDeclaration } from '@cat-factory/contracts'
import { boardChangeSubject } from '@cat-factory/kernel'
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
   * Every `boardChanged` the engine/board service pushed, in order, so the suite can assert a
   * human board mutation (add/rename/move/reparent/delete) emits a real-time signal on every
   * runtime, not just returns over REST. `hasBlock` records whether the change carried its block
   * as a PAYLOAD (the targeted shape) or only named one (the coarse shape).
   */
  readonly boardEvents: {
    workspaceId: string
    reason: string
    blockId: string | null
    hasBlock: boolean
  }[] = []

  async executionChanged(_workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // Clone so the engine's later in-place mutations don't rewrite recorded history.
    this.emits.push(structuredClone(instance))
  }

  async boardChanged(workspaceId: string, change: BoardChange): Promise<void> {
    this.boardEvents.push({
      workspaceId,
      reason: change.reason,
      // The same subject rule the real fan-out decorator resolves its targets through, so a
      // suite asserting a change reached a mount is asserting the production rule.
      blockId: boardChangeSubject(change),
      hasBlock: change.block != null,
    })
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
  /**
   * Issue a request whose success carries BYTES rather than JSON (the artifact blob endpoint).
   *
   * A separate method rather than a flag on {@link ConformanceApp.call}: that one JSON-decodes
   * every body, so a PNG reaches it as a parse error rather than a response. Returns the recorded
   * content type beside the bytes, because clamping it to the image allow-list is half of what
   * the endpoint promises: an artifact served as something a browser would execute is the bug.
   */
  callBinary(
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }>
  /** Create (and optionally seed) a workspace, returning its snapshot. */
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Whether this harness runs auth-ENABLED — i.e. it has a `config.auth.sessionSecret`, so a
   * signed session resolves to its user and the workspace-RBAC gate actually enforces. The
   * dev-open harnesses resolve no access object and allow everything, so the RBAC suite gates
   * every assertion on this (a dev-open harness would pass vacuously).
   */
  authEnabled: boolean
  /**
   * Mint a real signed user session (`Authorization: Bearer <token>`) for a chosen user, so the
   * RBAC suite can drive requests AS a specific member/viewer/admin. Requires {@link authEnabled}.
   */
  session(user: { id: string; login?: string; name?: string | null }): Promise<string>
  /**
   * Create a workspace owned by `ownerUserId` inside `accountId`, straight through the facade's
   * `WorkspaceService` — the seam the RBAC suite needs to place a board in a SPECIFIC account
   * with a SPECIFIC (or no) creator. A `null` owner skips the creator auto-enroll, so the suite
   * can exercise the account-admin escape hatch (an admin with no explicit member row).
   */
  createWorkspaceInAccount(
    accountId: string,
    ownerUserId: string | null,
    options?: { name?: string; seed?: boolean },
  ): Promise<WorkspaceSnapshot>
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
   * Every `boardChanged` the board service pushed, in order, so the suite can assert a human board
   * mutation emits a real-time signal on every runtime. Optionally filtered to events naming a
   * specific block.
   *
   * `hasBlock` is the targeted-vs-coarse decision: `true` when the change carried the changed block
   * as a PAYLOAD subscribers upsert, `false` when it only named one and every board must re-read.
   * That decision is what turns a busy board's live updates from a snapshot each into a small patch
   * each, so it is asserted rather than left to whichever facade happens to be exercised.
   */
  boardEmits(blockId?: string): {
    workspaceId: string
    reason: string
    blockId: string | null
    hasBlock: boolean
  }[]
  /**
   * Insert a pipeline row STRAIGHT into the facade's pipeline store, bypassing
   * `PipelineService.create` and with it the authoring rules
   * (`validatePipelineAuthoring`).
   *
   * The suite needs this for the shapes those rules refuse but the ENGINE must still handle,
   * because they remain reachable as stored state: a pipeline authored before the rule existed,
   * or a workspace's seeded copy of a built-in that predates it. The environment-lifecycle
   * behaviours are exactly that set: a deploy-only run whose environment outlives it and is
   * torn down by hand afterwards, and a test-only run whose PR report has to say that no
   * deployer ever stood anything up. Driving those through the authoring door would assert the
   * refusal instead of the behaviour, and adding the missing steps to make the save legal would
   * change the very thing under test.
   *
   * A pipeline whose shape the builder WOULD accept is still created through `POST /pipelines`:
   * this is for legacy state, not a shortcut around validation.
   */
  seedPipeline(workspaceId: string, pipeline: Pipeline): Promise<void>
  /**
   * Seed an already-"incorporated" requirements review for a block straight into the
   * facade's real review store, so the suite can assert the engine substitutes the
   * reworked requirements into the agent context — on EVERY runtime, not just the one
   * a feature-specific spec happens to cover. (The review/rework run themselves call a
   * real LLM, so the suite seeds the persisted outcome rather than driving them.)
   */
  seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string): Promise<void>
  /**
   * Seed a `ready` review with `openItems` still-open findings (one by default) straight into the
   * facade's real review store, so the suite can assert the async-incorporate route's pre-LLM
   * guard (incorporation refused while a finding is unanswered) on every runtime without a live
   * reviewer model.
   *
   * Seed MORE than one when the assertion must answer a finding WITHOUT settling the review:
   * answering the last open finding legitimately triggers incorporation, which calls a real model
   * no conformance harness has (the tracker-webhook suite's ticket replies need exactly that).
   */
  seedReadyReview(workspaceId: string, blockId: string, openItems?: number): Promise<void>
  /**
   * Seed an already-"incorporated" clarity (bug-report triage) review for a block straight
   * into the facade's real clarity store, so the suite can assert the engine substitutes the
   * clarified report into the agent context — on EVERY runtime (the clarity mirror of
   * {@link seedIncorporatedReview}).
   */
  seedIncorporatedClarityReview(workspaceId: string, blockId: string, report: string): Promise<void>
  /**
   * Seed a `ready` clarity review with `openItems` still-open findings (two by default) into the
   * facade's real clarity store — a bug-report triage parked on a human.
   *
   * What it buys the suite is the half of the ticket-reply loop that is per-facade: the reply
   * gateway for the CLARITY subject has to be composed against that facade's own clarity store
   * and engine actions, and a facade that wired only the requirements one answers a bug
   * reporter's comment with silence.
   */
  seedReadyClarityReview(workspaceId: string, blockId: string, openItems?: number): Promise<void>
  /**
   * The facade's execution-scoped run repository over its real store, so the suite can
   * assert the optimistic-concurrency `compareAndSwap` semantics (a stale write is
   * refused, not clobbering) identically on D1 and Postgres.
   */
  executionRepository(): ExecutionRepository
  /**
   * The facade's requirements-review store, so the suite can assert the review surface's own
   * optimistic-concurrency contract — a stale `compareAndSwap` refused rather than clobbering a
   * concurrent editor's answer, and `replaceForBlock` leaving exactly ONE live review per block
   * — identically on D1 and Postgres. Reviews are produced by a real reviewer LLM the harnesses
   * don't have, so (like the document role-link probe) this is exercised through the repository.
   */
  requirementReviewRepository(): RequirementReviewRepository
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
   * The facade's workspace repository over its real store, so the workspace-RBAC suite can
   * assert the `accessRowOf` / `setAccessMode` access-mode round-trip identically on D1 and
   * Postgres (no HTTP route sets the access mode until a later slice wires the members API).
   */
  workspaceRepository(): WorkspaceRepository
  /**
   * The facade's workspace-member repository over its real store, so the workspace-RBAC suite
   * can assert the roster CRUD, the batched `getRolesForUserInWorkspaces`, and the
   * `removeByAccountMembership` cascade identically on D1 and Postgres.
   */
  workspaceMemberRepository(): WorkspaceMemberRepository
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
   * The facade's imported-issue (task) repository over its real store, so the suite can assert
   * the batched `listByRefs` read (one chunked-`IN` per source, the N+1-free counterpart to
   * `get`) resolves a mixed set of (source, externalId) refs — matching, missing, wrong-source —
   * identically on D1 and Postgres. The import WRITE path needs a live source the dev-open HTTP
   * `call` path can't reach, so — like the document role-link probe — the persistence is
   * exercised through the repository directly.
   */
  taskRepository(): TaskRepository
  /**
   * The facade's interactive document-interview session repository over its real store, so the
   * suite can assert the WS5 session persistence (upsert / getByBlock-newest-wins / get /
   * deleteByBlock) identically on D1 and Postgres. A session is created by the interviewer LLM
   * (off in conformance), so — like the document role-link probe — the persistence is exercised
   * through the repository directly rather than an HTTP flow.
   */
  docInterviewRepository(): DocInterviewRepository
  /**
   * The facade's account-settings repository over its real store, so the suite can assert the
   * NON-SECRET config read (`getConfigByAccount`) behaves identically on D1 and Postgres.
   *
   * Exercised through the repository rather than an HTTP flow because no route reads this
   * method: the admin settings endpoint goes through `getByAccount` (the full row, secrets
   * included), while `getConfigByAccount` exists precisely so the run path — and a mothership
   * node over the machine API — can read the account's credential floor WITHOUT the secrets.
   * A store that diverged here would not blank a panel; it would stop enforcing an account
   * admin's refusal on one runtime only.
   */
  accountSettingsRepository(): AccountSettingsRepository
  /**
   * The facade's ACCOUNT-tier risk policy store (ADR 0055), so the tier-merge suite can author an
   * account policy and then assert what a BOARD in that account resolves.
   *
   * Seeded through the repository rather than the account HTTP route because that route requires a
   * signed session and account membership, which the dev-open harnesses have no user for. What the
   * suite is asserting is not the account controller (a server test covers it) but the part only a
   * real store can answer: that each facade's account table, its board table and the suppression
   * table compose into the SAME visible library, and that the engine resolves a task pinning an
   * inherited policy through it. A facade whose account read mapped one column differently would
   * hand a run a merge posture nobody chose, silently.
   */
  accountRiskPolicyRepository(): AccountRiskPolicyRepository
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
   * Link a service FRAME to a repository, so `resolveRepoTarget` resolves for that frame and
   * every block under it.
   *
   * ONE method for what is three stores expressing one fact (the workspace's VCS installation,
   * the repo projection row, the frame's own service→repo link), because a suite that had to
   * write them separately would be encoding this facade's storage shape rather than asserting
   * behaviour. Each facade implements it over its OWN repositories, which is what makes an
   * assertion built on it a real cross-runtime one: the ancestry walk reads three different
   * stores per runtime and a mapping that drifts in any of them fails here.
   *
   * Patches the service the frame ALREADY has (every top-level frame gets one at creation)
   * rather than inserting a second: `getByFrameBlock` is an unordered single-row read, so two
   * rows for one frame would resolve nondeterministically.
   *
   * **Pass a frame the test CREATED, never a seeded one.** `getByFrameBlock` matches on the frame
   * id alone (block ids are unique per workspace, not per database) and every seeded board in a
   * facade's shared test database reuses the same fixed ids, so `blk_auth` names one service row
   * per workspace created so far and this would patch an arbitrary one of them.
   */
  linkFrameRepo(input: {
    workspaceId: string
    frameBlockId: string
    installationId: number
    githubId: number
    owner: string
    name: string
  }): Promise<void>
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
  /**
   * The facade's TOOL-SERVER (MCP) dispatch resolution over its own composed capability-credential
   * chain: the half of both subsystems no HTTP route exposes, since the credential values are
   * write-only on the wire and the resolution happens inside a job body nothing else can see.
   *
   * The conformance suite runs a `FakeAgentExecutor`, which composes no job body, so without this
   * a facade that wired its credential chain differently (or not at all) passes every assertion
   * and hands its agents an unauthenticated tool server. Built with
   * {@link makeToolServerDispatchProbe} over the facade's container, so it observes the real
   * wiring rather than restating it. Undefined when the facade did not build a container the suite
   * can reach.
   */
  toolServerDispatch?(): ToolServerDispatchProbe | undefined
}

/** What one dispatch resolved for its tool servers: the run's record, plus the job-body specs. */
export interface ToolServerDispatchResult {
  /**
   * The non-secret projection the RUN records on its step, which the SPA renders as chips. Carries
   * no credential by construction, which is half of what the suite asserts.
   */
  record: DispatchToolServers
  /**
   * The job-body `mcpServers` field, credentials included. The only place the resolved VALUES are
   * observable, which is what lets the suite assert that a workspace's stored credential reaches a
   * dispatch under the channel its declaration named.
   */
  mcpServers: {
    id: string
    transport: string
    env?: Record<string, string>
    headers?: Record<string, string>
    secretKeys?: string[]
  }[]
}

/** The dispatch-side subset of the tool-server resolution the conformance suite drives. */
export interface ToolServerDispatchProbe {
  resolveForDispatch(input: {
    workspaceId: string
    agentKind: string
    /** The CLI this dispatch would run on, which decides whether MCP is reachable at all. */
    harness: string
  }): Promise<ToolServerDispatchResult>
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
  list(userId: string): Promise<
    {
      provider: string
      baseUrl: string
      hasApiKey: boolean
      models: LocalModelDeclaration[]
      /** Whether the store had to discard part of the row's stored model list. */
      unreadableModels: boolean
    }[]
  >
  upsert(
    userId: string,
    input: {
      provider: string
      label?: string
      baseUrl: string
      apiKey?: string
      models: LocalModelDeclaration[]
    },
  ): Promise<{ provider: string; hasApiKey: boolean; models: LocalModelDeclaration[] }>
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
   * The app-owned prompt-fragment registry this app resolves its standards from: the seam a
   * DEPLOYMENT registers on. The suite passes a fresh `promptFragmentRegistryWithBuiltins()` with
   * its own fragments already registered, so the "a deployment ships an org standard" flow is
   * driven through the real injection path on EVERY runtime.
   *
   * It has to be a per-app option rather than a module-global registration made before
   * `makeApp()`: that global is exactly what this seam replaced, and a suite still reaching for
   * one would be asserting the failure mode rather than the fix. Absent → the facade's own
   * default (the shipped catalog).
   */
  promptFragmentRegistry?: PromptFragmentRegistry
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
   * Inject the PR verification-report publisher (the suite supplies a
   * {@link FakePrReportPublisher}) so the engine's report hook can be driven on EVERY runtime
   * without a VCS connection: the suite asserts the COMPOSED report — and that a retry
   * rewrites it in place rather than appending a second copy — identically on D1 and Postgres.
   * Each facade harness threads it into its core overrides exactly as a real facade composes
   * it from its engine VCS client. Absent → the engine publishes nothing, as today.
   */
  prVerificationReportPublisher?: PrVerificationReportPublisher
  /**
   * The deployment's public SPA base URL, so the suite can assert the report's observability
   * deep link is built from config rather than a hardcoded host.
   */
  appBaseUrl?: string
  /**
   * The deployment's own public BACKEND base URL, so the suite can assert that the report links
   * captured artifacts to their bytes rather than listing opaque ids — and that the link is built
   * from THIS config rather than from the SPA origin beside it, which is a different host the
   * moment the SPA is served separately.
   */
  apiBaseUrl?: string
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
  /**
   * The probe the deployer proves a provisioned environment's route with.
   *
   * ALWAYS injected, never left to the facade's real wiring, and the default each harness supplies
   * answers `carried`. A conformance app's environment URLs are fixtures on reserved TLDs that
   * resolve nowhere, so a real probe would fail every deploy in this suite on the machine's DNS
   * rather than on anything the suite is asserting. A case that wants the unreachable path supplies
   * a probe that says so, which is also the only way to assert it deterministically.
   */
  routeProbe?: RouteProbe
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
   * Inject the app-owned polling-gate registry, pre-loaded (built-in `@cat-factory/gates` suite +
   * a CUSTOM `license-check` gate), so the suite can assert a deployment-registered gate resolves +
   * drives identically on EVERY runtime — replacing the old module-global `registerGate`. Each
   * facade harness threads the SAME instance into its container build. Absent → the facade's default
   * (built-ins-only) gate registry.
   */
  gateRegistry?: GateRegistry
  /**
   * Inject the app-owned step-completion-resolver registry, pre-loaded with a CUSTOM resolver, so
   * the suite can assert a deployment-registered resolver runs identically on EVERY runtime —
   * replacing the old module-global `registerStepResolver`. Each facade harness threads the SAME
   * instance into its container build. Absent → the facade's default (empty) resolver registry.
   */
  stepResolverRegistry?: StepResolverRegistry
  /**
   * Inject the app-owned JUDGE registry (the fourth step-taxonomy bucket), pre-loaded with a
   * rubric judge, so the suite can assert a deployment-registered judge resolves + drives
   * identically on EVERY runtime. Each facade harness threads the SAME instance into its
   * container build. Absent → the facade's default (empty) judge registry.
   */
  judgeRegistry?: JudgeRegistry
  /**
   * Inject the judge's verdict producer (a deterministic fake in the suite) so the whole loop —
   * pass / park / bounce / fail — is driven on EVERY runtime without a real model, and so the
   * UNWIRED pass-through can be asserted by handing over a disabled one. Each facade harness
   * threads it into its core overrides (the `judgeAssessor` seam `createCore` reads); absent ⇒
   * the facade's model-derived assessor (a pass-through with no model wired).
   */
  judgeAssessor?: JudgeAssessor
  /**
   * Inject the bug hunt's ranking producer (a deterministic fake in the suite) so both hunt
   * outcomes — a RANKED board and the unranked degradation when no model is wired — are driven
   * on EVERY runtime without a real model. Each facade harness threads it into its core
   * overrides (the `bugHuntAssessor` seam `createCore` reads); absent ⇒ the facade's
   * model-derived assessor, which is disabled with no model wired.
   */
  bugHuntAssessor?: BugHuntAssessor
  /**
   * Inject the fragment-BRIEF condensation model (a deterministic fake), so the suite can drive
   * the generated-brief store end to end — condense on first dispatch, reuse on the next,
   * REGENERATE once the standard's body moves — on EVERY runtime with no model. Each facade
   * harness threads it into its core overrides exactly where a real facade builds the inline
   * `LlmFragmentBriefGenerator`. Absent → the facade's own (unwired in tests) generator, so a
   * long standard folds in full.
   */
  fragmentBriefGenerator?: FragmentBriefGenerator
  /**
   * Inject the app-owned initiative-preset registry, pre-loaded with a CUSTOM preset, so the suite
   * can assert a deployment-registered preset resolves identically on EVERY runtime (its snapshot
   * descriptor + create-with-preset + its per-kind steering folded onto a spawned run) — replacing
   * the old module-global registration. Each facade harness threads the SAME instance into its
   * container build. Absent → the facade's default built-in-only registry.
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * Inject the app-owned custom task-type registry, pre-loaded with a CUSTOM task type, so the
   * suite can assert a deployment-registered task type round-trips identically on EVERY runtime
   * (its snapshot `customTaskTypes` projection + a task created with its namespaced id defaulting
   * to its registered pipeline). Each facade harness threads the SAME instance into its container
   * build. Absent → the facade's default (empty) task-type registry.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * Inject the app-owned INLINE USE-CASE registry, pre-loaded with a deployment's use case, so the
   * suite can assert the public `/api/v1/use-cases` surface resolves identically on EVERY runtime
   * (its catalog projection, its model narrowing and one invocation). Each facade harness threads
   * the SAME instance into its container build. Absent → the facade's default (empty) registry,
   * which is what the "an empty catalog is not a missing surface" assertion drives.
   */
  inlineUseCaseRegistry?: InlineUseCaseRegistry
  /**
   * Inject the use-case surface's model producer (a deterministic fake in the suite) so an
   * invocation, its composed prompt and the per-model availability projection are driven on EVERY
   * runtime without a real model. Each facade harness threads it into its core overrides (the
   * `inlineUseCaseGenerator` seam `createCore` reads); absent ⇒ the facade's model-derived
   * generator, which is disabled with no model wired.
   */
  inlineUseCaseGenerator?: InlineUseCaseGenerator
  /**
   * Inject the app-owned pipeline registry, pre-loaded with a registered pipeline and/or a
   * RETIREMENT, so the suite can drive the pipeline lifecycle end to end on EVERY runtime: a
   * deployment pipeline seeds into a new workspace, and a withdrawn one is advertised on the
   * snapshot + deletable from a board that already stored it (a built-in the catalog still ships
   * stays read-only). Retirement is only ever a POSITIVE assertion on this registry, so it cannot
   * be exercised through the built-in catalog — which ships no tombstones — without one.
   * Each facade harness threads the SAME instance into its container build; absent → the facade's
   * default (empty) pipeline registry.
   */
  pipelineRegistry?: PipelineRegistry
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
