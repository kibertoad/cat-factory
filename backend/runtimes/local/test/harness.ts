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
  deriveWorkerDatabase,
  fakeBuildPreviewJob,
  driveWorkspace,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
} from '@cat-factory/conformance'
import {
  type DrizzleDb,
  DrizzleDocInterviewRepository,
  DrizzleDocumentRepository,
  DrizzleNotificationRepository,
  createApp,
  createDbClient,
  createDrizzleRepositories,
  migrate,
} from '@cat-factory/node-server'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateProviderOverrides } from '@cat-factory/gates'
import type { BackendRegistries } from '@cat-factory/integrations'
import type { Clock, ExecutionInstance, Service, WorkspaceSnapshot } from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopEnvConfigRepairRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type {
  LocalRunner,
  UpsertLocalModelEndpointInput,
  UserSecretKind,
} from '@cat-factory/contracts'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { buildLocalContainer } from '../src/container.js'

const BASE = 'https://cat-factory.test'

// The seed helpers only persist fixtures (no timestamping path is exercised), but
// `createDrizzleRepositories` requires a clock — pass a real one rather than building
// the whole repo set with an undefined clock.
const SEED_CLOCK: Clock = { now: () => Date.now() }

// Test env for the LOCAL facade. Same dev-open gate + non-production ENVIRONMENT as the
// Node harness, plus the two local-mode prerequisites so `buildLocalContainer` composes
// (LOCAL_HARNESS_IMAGE lets the Docker transport construct; GITHUB_PAT selects the PAT
// token source). Neither is exercised here — the conformance suite overrides the agent
// executor with a deterministic fake — but they prove the local composition root wires
// the SAME Core as the Node/Worker facades. The local facade reuses the Node config
// loader, which (like the Worker) demands an ENCRYPTION_KEY for the always-on
// task-source integration or it throws at config load — so provide one (32 zero bytes,
// base64), exactly as the Node harness does.
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  // The shared conformance suite calls the API with NO session (it relies on the dev-open
  // gate), so keep auth genuinely disabled here: opt OUT of the local default that enables
  // password sign-in (which would flip `enabled` true and 401 the suite's open calls). The
  // PAT/password login flow has its own dedicated local spec instead.
  AUTH_PASSWORD_ENABLED: 'false',
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  // Local mode requires AUTH_SESSION_SECRET (a fixed value is fine for the suite; it must
  // clear the 32-char minimum the local config loader enforces).
  AUTH_SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  // Enable the Slack notification transport so its module + channel wire up through
  // the local facade (parity with the Node/Worker test envs); the conformance Slack
  // CRUD asserts persistence parity and the channel bails when no Slack is connected.
  SLACK_ENABLED: 'true',
  // The ephemeral-environment integration wires from ENCRYPTION_KEY (no flag), parity with
  // the Node/Worker test envs, so the conformance env CRUD asserts persistence parity here too.
  // Opt into the prompt-fragment library (ADR 0006) so its module wires up (parity
  // with the Node/Worker test envs); the conformance library CRUD asserts parity.
  PROMPT_LIBRARY_ENABLED: 'true',
  // Enable every document source explicitly so the conformance suite can exercise each
  // provider's connect/list/disconnect on the local facade too.
  DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
  LOCAL_HARNESS_IMAGE: 'cat-factory-executor:test',
  GITHUB_PAT: 'test-pat',
}

/**
 * Connect to the test Postgres and ensure the schema. Each vitest worker gets its OWN
 * database (`<base>_local_<workerId>`, created on demand) so the spec files run with file
 * parallelism without racing on shared tables; the `local` label keeps these databases
 * distinct from the Node suite's on a shared server. Falls back to the base `DATABASE_URL`
 * outside a vitest worker.
 */
export async function setupTestDb(): Promise<DrizzleDb> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required to run the local conformance tests')
  }
  const worker = deriveWorkerDatabase(url, 'local', process.env.VITEST_WORKER_ID)
  if (worker) await ensureDatabase(url, worker.dbName)
  const { db, pool } = createDbClient(worker?.url ?? url)
  await migrate(db, pool)
  return db
}

/**
 * Create `dbName` if absent, over an admin connection to the base `DATABASE_URL`
 * (`CREATE DATABASE` cannot run in a transaction). Tolerates the duplicate-database race
 * (`42P04`) when two workers create their databases concurrently.
 */
async function ensureDatabase(adminUrl: string, dbName: string): Promise<void> {
  const { pool } = createDbClient(adminUrl)
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
 * Build one app over the shared Postgres through the LOCAL composition root, with a
 * deterministic agent + no-op durable runner (the suite advances runs itself via
 * `drive`). A thin adapter over the shared conformance harness, identical to the Node
 * helper apart from `buildLocalContainer`.
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
    testerQualityReviewer?: CoreDependencies['testerQualityReviewer']
    taskSourceProviders?: CoreDependencies['taskSourceProviders']
  },
): ConformanceApp {
  const recorder = new RecordingEventPublisher()
  // The custom-kind suite injects a pre-loaded registry: thread it into BOTH the fake executor
  // (so it detects the custom kind's structured output) and the container build below.
  const agentExecutorOptions: FakeAgentOptions = {
    ...agentOptions,
    ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
  }
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentExecutorOptions)
      : new FakeAgentExecutor(agentExecutorOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    // Deterministic bootstrapper so the suite drives the bootstrap lifecycle through the
    // local composition root without GitHub/Docker (driven via driveBootstrap).
    repoBootstrapper: new FakeRepoBootstrapper(),
    // Deterministic env-config-repairer + no-op runner so the suite drives the repair
    // lifecycle through the local composition root (driven via driveEnvConfigRepair); the
    // module only builds when an env provider is also wired.
    envConfigRepairer: new FakeEnvConfigRepairer(),
    envConfigRepairRunner: new NoopEnvConfigRepairRunner(),
    // Fake browsable-preview transport + job builder — they WIN over the local facade's real
    // Docker-backed transport (spread last in buildNodeContainer), so the runtime-neutral
    // PreviewService lifecycle runs on real Postgres without Docker/GitHub, identically to Node.
    previewTransport: new FakePreviewTransport(),
    buildPreviewJob: fakeBuildPreviewJob,
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
    // binary-storage gate deterministically (local inherits Node's storage-OFF default).
    ...(opts?.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: opts.resolveBinaryArtifactStore }
      : {}),
    // Inject a native environment provider + the block-less coords resolver (both fakes
    // in the suite) so the on-demand repo-config validate route is asserted end-to-end
    // against real Postgres, identically to the Worker/Node. Overrides are spread last in
    // buildNodeContainer (reused by buildLocalContainer), so they win over the default
    // HttpEnvironmentProvider.
    ...(opts?.environmentProvider ? { environmentProvider: opts.environmentProvider } : {}),
    ...(opts?.resolveRepoFilesForCoords
      ? { resolveRepoFilesForCoords: opts.resolveRepoFilesForCoords }
      : {}),
    // Inject the test quality-control companion's inline reviewer (a fake in the suite) so the
    // full QC loop is driven through the local composition root without a model, identically to
    // the Worker/Node.
    ...(opts?.testerQualityReviewer ? { testerQualityReviewer: opts.testerQualityReviewer } : {}),
    // Inject the async deploy lifecycle (a fake deploy-job client + clone-target resolver) so
    // the suite drives the container render path through the local composition root, identically
    // to the Worker/Node. Overrides win over buildLocalContainer's own deploy wiring (spread last).
    ...(opts?.deployJobClient ? { deployJobClient: opts.deployJobClient } : {}),
    ...(opts?.resolveDeployCloneTarget
      ? { resolveDeployCloneTarget: opts.resolveDeployCloneTarget }
      : {}),
  }
  const container = buildLocalContainer({
    db,
    env: TEST_ENV,
    overrides,
    // Default Cloudflare models ON for parity with the Worker test harness (which
    // always binds `AI`). The built-in default model preset routes every agent kind to
    // `kimi-k2.7` (a Cloudflare-served model), so the execution start guard needs that
    // provider available to start a run. The suite still forces this OFF for the
    // provider-key assertions that exercise the unconfigured path.
    cloudflareModelsEnabled: opts?.cloudflareModelsEnabled ?? true,
    // Re-wire any faked gate providers after the build's reset (the suite drives the CI gate).
    gateProviders: opts?.gateProviders,
    // Inject the app-owned backend registries (pre-loaded with custom kinds in the custom-backend
    // suite) so a registered custom backend is resolved by reference, exactly like a real deployment.
    ...(opts?.backendRegistries ? { backendRegistries: opts.backendRegistries } : {}),
    // Inject the app-owned agent-kind registry (pre-loaded with a custom kind in the custom-kind
    // suite) so buildLocalContainer forwards it into buildNodeContainer — the SAME instance the
    // fake executor above got.
    ...(opts?.agentKindRegistry ? { agentKindRegistry: opts.agentKindRegistry } : {}),
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
  // so the HTTP account flow can't create the owning org). Mirrors the Node helper.
  async function createOrgWorkspace(
    options: { name?: string; seed?: boolean } = {},
  ): Promise<WorkspaceSnapshot> {
    const user = { id: 'usr_org-owner', login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await container.accountService.createOrg(user, { name: `${name} org` })
    return container.workspaceService.create({ name, seed: options.seed ?? false }, user.id, org.id)
  }

  // Drive every active run to a standstill through the SHARED production driver
  // (`driveExecution`, via `driveWorkspace`) — the local facade reuses Node's pg-boss
  // runner, so this is the same loop production runs; no hand-rolled twin to drift.
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

  // Seed a block's incorporated requirements review directly into the (shared
  // Postgres) store so the engine's reworked-requirements substitution can be driven
  // without running the reviewer LLM — the same Drizzle persistence the Node harness
  // writes through (the local facade reuses the Node repositories).
  function seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string) {
    return createDrizzleRepositories(db, SEED_CLOCK).requirementReviewRepository.upsert(
      workspaceId,
      makeIncorporatedReview(blockId, requirements),
    )
  }

  function seedReadyReview(workspaceId: string, blockId: string) {
    return createDrizzleRepositories(db, SEED_CLOCK).requirementReviewRepository.upsert(
      workspaceId,
      makeReadyReviewWithOpenItem(blockId),
    )
  }

  function seedIncorporatedClarityReview(workspaceId: string, blockId: string, report: string) {
    return createDrizzleRepositories(db, SEED_CLOCK).clarityReviewRepository.upsert(
      workspaceId,
      makeIncorporatedClarityReview(blockId, report),
    )
  }

  function seedService(service: Service) {
    return createDrizzleRepositories(db, SEED_CLOCK).serviceRepository.insert(service)
  }

  function getService(id: string) {
    return createDrizzleRepositories(db, SEED_CLOCK).serviceRepository.get(id)
  }

  return {
    call,
    createWorkspace,
    createOrgWorkspace,
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
    blockRepository: () => createDrizzleRepositories(db, SEED_CLOCK).blockRepository,
    notificationRepository: () => new DrizzleNotificationRepository(db),
    documentRepository: () => new DrizzleDocumentRepository(db),
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
  }
}
