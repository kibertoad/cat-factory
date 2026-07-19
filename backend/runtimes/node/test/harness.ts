import {
  AsyncFakeAgentExecutor,
  type ConformanceApp,
  FakeAgentExecutor,
  type FakeAgentOptions,
  FakeEnvConfigRepairer,
  FakePreviewTransport,
  FakeRepoBootstrapper,
  FakeTaskSourceProvider,
  RecordingEventPublisher,
  fakeBuildPreviewJob,
  adminDatabaseUrl,
  deriveWorkerDatabase,
  driveWorkspace,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
  mintSession,
} from '@cat-factory/conformance'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateProviderOverrides } from '@cat-factory/gates'
import type { BackendRegistries } from '@cat-factory/integrations'
import type { ExecutionInstance, Service, WorkspaceSnapshot } from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopEnvConfigRepairRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type {
  LocalRunner,
  UpsertLocalModelEndpointInput,
  UserSecretKind,
} from '@cat-factory/contracts'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { buildNodeContainer } from '../src/container.js'
import { type DrizzleDb, createDbClient } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import {
  DrizzleClarityReviewRepository,
  DrizzleDocInterviewRepository,
  DrizzleRequirementReviewRepository,
  DrizzleServiceRepository,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceRepository,
  createDrizzleRepositories,
} from '../src/repositories/drizzle.js'
import { DrizzleNotificationRepository } from '../src/repositories/notifications.js'
import { DrizzleDocumentRepository } from '../src/repositories/documents.js'
import { DrizzleTaskRepository } from '../src/repositories/tasks.js'
import { createApp } from '../src/server.js'

const BASE = 'https://cat-factory.test'

// Test env: open the auth gate (dev-open) exactly as the Worker pool does, and pin a
// non-production ENVIRONMENT so `devOpen` is honoured. The integration toggles stay off
// (this MVP wires only the runtime-neutral core), matching the Node config defaults.
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  // A session secret so the workspace-RBAC conformance suite can drive requests as real signed
  // sessions (a dev-open harness resolves no access and passes RBAC assertions vacuously). Harmless
  // to the other suites: with no OAuth/password provider configured, `enabled` stays false and
  // dev-open still passes anonymous (token-less) requests through unchanged.
  AUTH_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  // The always-on task-source integration makes `loadNodeConfig` require the shared
  // ENCRYPTION_KEY (32 zero bytes, base64) or it throws at config load. Integration
  // toggles that need extra wiring (GitHub/runners) stay off — matching Node defaults.
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  // Enable the Slack notification transport so its module + channel wire up (parity
  // with the Worker test env); the conformance Slack CRUD asserts persistence parity,
  // and the channel bails (best-effort) when a workspace has no Slack connection.
  SLACK_ENABLED: 'true',
  // Enable the observability integration (release-health module + connection API) so the
  // post-release-health gate conformance can connect a provider and create a pipeline carrying
  // the observability-gated `post-release-health` step. Parity with the Worker test env; the
  // gate's runtime verdict comes from a faked ReleaseHealthProvider, not a real Datadog call.
  OBSERVABILITY_ENABLED: 'true',
  // The ephemeral-environment integration wires from ENCRYPTION_KEY (no flag), parity with
  // the Worker test env; the conformance env CRUD asserts persistence parity.
  // Opt into the prompt-fragment library (ADR 0006) so its module wires up; the
  // conformance library CRUD asserts persistence parity across stores.
  PROMPT_LIBRARY_ENABLED: 'true',
  // Enable every document source explicitly so the conformance suite can exercise each
  // provider's connect/list/disconnect on this facade.
  DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
}

/**
 * Connect to the test Postgres and ensure the schema. Each vitest worker gets its OWN
 * database (`<base>_node_<workerId>`, created on demand) so the spec files can run with
 * file parallelism without racing on shared tables; the migrator is idempotent, so a
 * worker reusing its database across files just finds nothing to apply. Falls back to the
 * base `DATABASE_URL` when not under a vitest worker. Returns the Drizzle client every app
 * in the file is built over — exactly as the Worker pool shares one local D1.
 */
export async function setupTestDb(): Promise<DrizzleDb> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required to run the Node conformance/integration tests')
  }
  // Require a per-worker database: never fall back to migrating the base DATABASE_URL. A test
  // run must only ever create/migrate a `<base>_node_<id>` database, so it can't pollute or
  // desync a developer's dev DB (the drizzle-kit 1.0 ledger↔schema split originates exactly here).
  const worker = deriveWorkerDatabase(url, 'node', process.env.VITEST_WORKER_ID)
  if (!worker) {
    throw new Error(
      'The Node test suite requires a VITEST_WORKER_ID-scoped database; refusing to run against ' +
        'the base DATABASE_URL. Run via vitest (which sets VITEST_WORKER_ID).',
    )
  }
  await ensureDatabase(url, worker.dbName)
  const { db, pool } = createDbClient(worker.url)
  await migrate(db, pool)
  return db
}

/**
 * Create `dbName` if it does not already exist, over an admin connection to the `postgres`
 * maintenance database (NOT the app's base DATABASE_URL — see `adminDatabaseUrl`), so the
 * admin pool never touches a developer's dev DB. `CREATE DATABASE` cannot run inside a
 * transaction, so this uses the pool's autocommit path. Tolerates the duplicate-database race
 * (error `42P04`) when two workers create their databases at once.
 */
async function ensureDatabase(baseUrl: string, dbName: string): Promise<void> {
  const { pool } = createDbClient(adminDatabaseUrl(baseUrl))
  try {
    const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (existing.rowCount === 0) {
      try {
        await pool.query(`CREATE DATABASE "${dbName}"`)
      } catch (err) {
        if ((err as { code?: string }).code !== '42P04') throw err
      }
    }
  } finally {
    await pool.end()
  }
}

/**
 * Build one app over the shared Postgres with a deterministic agent + no-op durable
 * runner (the suite advances runs itself via `drive`). Mirrors the Worker test
 * helper's `makeApp`, so the shared conformance harness is a thin adapter.
 */
export function makeConformanceApp(
  db: DrizzleDb,
  agentOptions?: FakeAgentOptions,
  opts?: {
    cloudflareModelsEnabled?: boolean
    resolveRunRepoContext?: CoreDependencies['resolveRunRepoContext']
    resolveBinaryArtifactStore?: CoreDependencies['resolveBinaryArtifactStore']
    gateProviders?: GateProviderOverrides
    environmentProvider?: CoreDependencies['environmentProvider']
    resolveRepoFilesForCoords?: CoreDependencies['resolveRepoFilesForCoords']
    deployJobClient?: CoreDependencies['deployJobClient']
    resolveDeployCloneTarget?: CoreDependencies['resolveDeployCloneTarget']
    backendRegistries?: BackendRegistries
    agentKindRegistry?: AgentKindRegistry
    gateRegistry?: CoreDependencies['gateRegistry']
    stepResolverRegistry?: CoreDependencies['stepResolverRegistry']
    initiativePresetRegistry?: CoreDependencies['initiativePresetRegistry']
    testerQualityReviewer?: CoreDependencies['testerQualityReviewer']
    taskSourceProviders?: CoreDependencies['taskSourceProviders']
    detectionConventions?: CoreDependencies['detectionConventions']
  },
): ConformanceApp {
  // The custom-kind suite injects a pre-loaded registry: thread it into BOTH the fake executor
  // (so it detects the custom kind's structured output) and the container (prompts + snapshot).
  const agentExecutorOptions: FakeAgentOptions = {
    ...agentOptions,
    ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
  }
  // Record emitted run snapshots so the suite can assert intermediate transitions
  // (e.g. the model present on the first "spinning up container" emit).
  const recorder = new RecordingEventPublisher()
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentExecutorOptions)
      : new FakeAgentExecutor(agentExecutorOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    // A deterministic bootstrapper so the suite can drive the dispatch→poll→finalise
    // lifecycle without GitHub or a container (the suite drives it via driveBootstrap).
    repoBootstrapper: new FakeRepoBootstrapper(),
    // Fake browsable-preview transport + job builder so the runtime-neutral PreviewService
    // lifecycle + its ephemeral `environments`-row persistence run on real Postgres without a
    // container/GitHub (the real transport is a per-runtime differentiator, wired only in local).
    previewTransport: new FakePreviewTransport(),
    buildPreviewJob: fakeBuildPreviewJob,
    // A deterministic env-config-repairer + no-op runner so the suite can drive the
    // repair dispatch→poll→re-validate lifecycle without GitHub or a container (driven via
    // driveEnvConfigRepair). The module only builds when an env provider is also wired.
    envConfigRepairer: new FakeEnvConfigRepairer(),
    envConfigRepairRunner: new NoopEnvConfigRepairRunner(),
    executionEventPublisher: recorder,
    // Swap the config-wired real Jira provider for a deterministic fake (the Drizzle
    // task repos stay), so the shared suite asserts create-task-from-issue against
    // Postgres without hitting the network. Override wins over the config providers.
    taskSourceProviders: opts?.taskSourceProviders ?? [
      new FakeTaskSourceProvider('jira'),
      new FakeTaskSourceProvider('linear'),
    ],
    // Inject the engine's run-repo resolver (a fake in the suite) so the registered
    // custom kind's pre/post-op hooks run + commit identically to a real GitHub-wired facade.
    ...(opts?.resolveRunRepoContext ? { resolveRunRepoContext: opts.resolveRunRepoContext } : {}),
    // Inject the binary-artifact store resolver so the suite drives the start-time
    // binary-storage gate deterministically (Node defaults storage OFF, so a non-null
    // resolver is needed to assert a storage-reliant pipeline starts).
    ...(opts?.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: opts.resolveBinaryArtifactStore }
      : {}),
    // Inject a fake environment provider (the internal override) + the block-less coords
    // resolver (both fakes in the suite) so the on-demand repo-config validate route is
    // asserted end-to-end against real Postgres, identically to the Worker.
    ...(opts?.environmentProvider ? { environmentProvider: opts.environmentProvider } : {}),
    ...(opts?.resolveRepoFilesForCoords
      ? { resolveRepoFilesForCoords: opts.resolveRepoFilesForCoords }
      : {}),
    // Inject the deployment-level detection-convention extensions (a fake in the suite) so
    // convention-honouring service-provisioning detection is asserted against real Postgres,
    // identically to the Worker — catching a facade that forgot the config→deps threading.
    ...(opts?.detectionConventions ? { detectionConventions: opts.detectionConventions } : {}),
    // Inject the test quality-control companion's inline reviewer (a fake in the suite) so the
    // full QC loop is driven against real Postgres without a model, identically to the Worker.
    ...(opts?.testerQualityReviewer ? { testerQualityReviewer: opts.testerQualityReviewer } : {}),
    // Inject the async deploy lifecycle (a fake deploy-job client + clone-target resolver) so
    // the suite drives the container render path through Node's wiring, identically to the Worker.
    ...(opts?.deployJobClient ? { deployJobClient: opts.deployJobClient } : {}),
    ...(opts?.resolveDeployCloneTarget
      ? { resolveDeployCloneTarget: opts.resolveDeployCloneTarget }
      : {}),
  }
  const container = buildNodeContainer({
    db,
    env: TEST_ENV,
    overrides,
    // Default Cloudflare models ON for parity with the Worker test harness, which
    // always binds `AI`. The built-in default model preset points every agent kind at
    // `kimi-k2.7` (a Cloudflare-served model), so the execution start guard needs that
    // provider available to start a run — exactly as the Worker does. The suite still
    // forces this OFF for the provider-key assertions that exercise the unconfigured path.
    cloudflareModelsEnabled: opts?.cloudflareModelsEnabled ?? true,
    // Re-wire any faked gate providers after the build's reset (the suite drives the CI gate).
    gateProviders: opts?.gateProviders,
    // Inject the app-owned backend registries (pre-loaded with custom kinds in the custom-backend
    // suite) so a registered custom backend is resolved by reference, exactly like a real deployment.
    ...(opts?.backendRegistries ? { backendRegistries: opts.backendRegistries } : {}),
    // Inject the app-owned agent-kind registry (pre-loaded with a custom kind in the custom-kind
    // suite) so the container resolves it by reference — the SAME instance the fake executor got.
    ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
    ...(opts?.gateRegistry ? { gateRegistry: opts.gateRegistry } : {}),
    ...(opts?.stepResolverRegistry ? { stepResolverRegistry: opts.stepResolverRegistry } : {}),
    // Inject the app-owned initiative-preset registry (pre-loaded with a custom preset in the
    // custom-preset suite) so the container resolves it by reference on this runtime.
    ...(opts?.initiativePresetRegistry
      ? { initiativePresetRegistry: opts.initiativePresetRegistry }
      : {}),
  })
  const app = createApp(container, TEST_ENV)

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const hasBody = body !== undefined
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    return (await call<WorkspaceSnapshot>('POST', '/workspaces', options)).body
  }

  // Org-scoped workspace via the container's services (dev-open has no signed-in user,
  // so the HTTP account flow can't create the owning org). Mirrors the Worker helper.
  async function createOrgWorkspace(
    options: { name?: string; seed?: boolean } = {},
  ): Promise<WorkspaceSnapshot> {
    // The org creator must be a real users row — the accounts/memberships FKs to users(id)
    // reject a nonexistent owner. Production always mints it at login, so do the same here
    // (mirrors the conformance `makeOrgOwner` probe) instead of a phantom id.
    const owner = await container.userService.findOrCreateByIdentity('github', 'org-owner', {
      name: 'Org Owner',
    })
    const user = { id: owner.id, login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await container.accountService.createOrg(user, { name: `${name} org` })
    return container.workspaceService.create({ name, seed: options.seed ?? false }, user.id, org.id)
  }

  // Drive every active run to a standstill through the SHARED production driver
  // (`driveExecution`, via `driveWorkspace`) — the same loop the pg-boss runner uses, so
  // the suite can't pass against a hand-rolled twin that diverges from production.
  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    return driveWorkspace(
      container.executionService,
      workspaceId,
      // Enumerate runs straight from the repository (as production does — it drives by run id),
      // NOT via the SPA snapshot, which now hides the public-API "initiative" runs' executions.
      () => container.executionRepository.listByWorkspace(workspaceId),
      maxRounds,
    )
  }

  function executionEmits(blockId?: string): ExecutionInstance[] {
    return blockId ? recorder.emits.filter((e) => e.blockId === blockId) : recorder.emits
  }

  function boardEmits(blockId?: string) {
    return blockId
      ? recorder.boardEvents.filter((e) => e.blockId === blockId)
      : recorder.boardEvents
  }

  // Poll a bootstrap run to terminal directly (production drives this via pg-boss).
  async function driveBootstrap(
    workspaceId: string,
    jobId: string,
    maxPolls = 50,
  ): Promise<number> {
    if (!container.bootstrap) throw new Error('bootstrap module is not configured in this app')
    for (let p = 0; p < maxPolls; p++) {
      const result = await container.bootstrap.service.pollBootstrapJob(workspaceId, jobId)
      if (result.state !== 'running') return p + 1
    }
    return maxPolls
  }

  // Poll an env-config-repair run to terminal directly (production drives this via pg-boss).
  async function driveEnvConfigRepair(
    workspaceId: string,
    jobId: string,
    maxPolls = 50,
  ): Promise<number> {
    if (!container.envConfigRepair) {
      throw new Error('env-config-repair module is not configured in this app')
    }
    for (let p = 0; p < maxPolls; p++) {
      const result = await container.envConfigRepair.service.pollJob(workspaceId, jobId)
      if (result.state !== 'running') return p + 1
    }
    return maxPolls
  }

  function seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string) {
    return new DrizzleRequirementReviewRepository(db).upsert(
      workspaceId,
      makeIncorporatedReview(blockId, requirements),
    )
  }

  function seedReadyReview(workspaceId: string, blockId: string) {
    return new DrizzleRequirementReviewRepository(db).upsert(
      workspaceId,
      makeReadyReviewWithOpenItem(blockId),
    )
  }

  function seedIncorporatedClarityReview(workspaceId: string, blockId: string, report: string) {
    return new DrizzleClarityReviewRepository(db).upsert(
      workspaceId,
      makeIncorporatedClarityReview(blockId, report),
    )
  }

  function seedService(service: Service) {
    return new DrizzleServiceRepository(db).insert(service)
  }

  function getService(id: string) {
    return new DrizzleServiceRepository(db).get(id)
  }

  return {
    call,
    createWorkspace,
    createOrgWorkspace,
    authEnabled: Boolean(TEST_ENV.AUTH_SESSION_SECRET),
    session: (user) => mintSession(TEST_ENV.AUTH_SESSION_SECRET!, user),
    createWorkspaceInAccount: (accountId, ownerUserId, options) =>
      container.workspaceService.create(
        { name: options?.name ?? 'RBAC board', seed: options?.seed ?? false },
        ownerUserId,
        accountId,
      ),
    drive,
    startExecution: (workspaceId, blockId, pipelineId, opts) =>
      container.executionService.start(
        workspaceId,
        blockId,
        pipelineId,
        undefined,
        undefined,
        undefined,
        opts?.gates,
      ),
    driveBootstrap,
    driveEnvConfigRepair,
    executionEmits,
    boardEmits,
    seedIncorporatedReview,
    seedReadyReview,
    seedIncorporatedClarityReview,
    executionRepository: () => container.executionRepository,
    agentRunRepository: () => container.agentRunRepository,
    blockRepository: () => createDrizzleRepositories(db, { now: () => Date.now() }).blockRepository,
    workspaceRepository: () => new DrizzleWorkspaceRepository(db),
    workspaceMemberRepository: () => new DrizzleWorkspaceMemberRepository(db),
    initiativeRepository: () =>
      createDrizzleRepositories(db, { now: () => Date.now() }).initiativeRepository,
    notificationRepository: () => new DrizzleNotificationRepository(db),
    documentRepository: () => new DrizzleDocumentRepository(db),
    taskRepository: () => new DrizzleTaskRepository(db),
    docInterviewRepository: () => new DrizzleDocInterviewRepository(db),
    seedService,
    getService,
    onboarding: () => makeOnboardingProbe(container),
    localModelEndpoints: () => {
      const svc = container.localModelEndpoints
      if (!svc) return undefined
      return {
        list: (userId: string) => svc.list(userId),
        upsert: (userId: string, input) =>
          svc.upsert(userId, input as UpsertLocalModelEndpointInput),
        resolve: (userId: string, provider: string) => svc.resolve(userId, provider),
        remove: (userId: string, provider: string) => svc.remove(userId, provider as LocalRunner),
      }
    },
    openRouterCatalog: () => {
      const svc = container.openRouterCatalog
      if (!svc) return undefined
      return {
        get: (workspaceId: string) => svc.get(workspaceId),
        upsert: (workspaceId: string, input) => svc.upsert(workspaceId, input),
      }
    },
    userSecrets: () => {
      const svc = container.userSecrets
      if (!svc) return undefined
      return {
        store: (userId, kind, input) => svc.store(userId, kind as UserSecretKind, input),
        resolve: (userId, kind) => svc.resolve(userId, kind as UserSecretKind),
        describe: (kind) => svc.describe(kind as UserSecretKind),
      }
    },
    userSettings: () => {
      const svc = container.userSettings?.service
      if (!svc) return undefined
      return {
        get: (userId) => svc.get(userId),
        update: (userId, input) => svc.update(userId, input),
      }
    },
    packageRegistries: () => {
      const svc = container.packageRegistries?.service
      if (!svc) return undefined
      return {
        resolveForDispatch: (workspaceId: string) => svc.resolveForDispatch(workspaceId),
      }
    },
  }
}
