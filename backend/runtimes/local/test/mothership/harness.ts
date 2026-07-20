import {
  AsyncFakeAgentExecutor,
  type ConformanceApp,
  FakeAgentExecutor,
  type FakeAgentOptions,
  FakeEnvConfigRepairer,
  FakeRepoBootstrapper,
  FakeTaskSourceProvider,
  RecordingEventPublisher,
  adminDatabaseUrl,
  deriveWorkerDatabase,
  driveWorkspace,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
} from '@cat-factory/conformance'
import {
  type CoreRepositories,
  type DrizzleDb,
  DrizzleDocInterviewRepository,
  DrizzleDocumentRepository,
  DrizzleNotificationRepository,
  DrizzleTaskRepository,
  DrizzleWorkspaceMemberRepository,
  DrizzleWorkspaceRepository,
  buildNodeContainer,
  createApp,
  createDbClient,
  createDrizzleRepositories,
  migrate,
  schema,
} from '@cat-factory/node-server'
import {
  type PersistenceRpcClient,
  type PersistenceRpcRequest,
  type PersistenceRpcResponse,
  type ServerContainer,
  createRemoteRepositoryRegistry,
} from '@cat-factory/server'
import type { GateProviderOverrides } from '@cat-factory/gates'
import type { BackendRegistries } from '@cat-factory/integrations'
import type {
  Account,
  Clock,
  ExecutionInstance,
  Service,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopEnvConfigRepairRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type { LocalRunner, UpsertLocalModelEndpointInput } from '@cat-factory/contracts'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { createLocalCredentialStore } from '../../src/sqlite/credentialStore.js'
import { ENCRYPTION_KEY, SESSION_SECRET, buildMothershipEnv, mintMachineToken } from './setup.js'

// ---------------------------------------------------------------------------
// Mothership-mode conformance harness (docs/initiatives/mothership-mode.md).
//
// This binds the SHARED cross-runtime conformance suite to a THIRD configuration: a
// no-Postgres, mothership-mode node whose `CoreRepositories` are the RPC-backed remote
// registry, talking to a real in-process Node mothership. The SAME assertions run, so any
// org/durable repository method that isn't correctly proxied (un-allow-listed, mis-scoped,
// a direct-db store never routed remotely, or a serialization bug) fails an EXISTING test
// instead of a developer's first board load — without writing the test twice.
//
// Topology (no socket — the RPC is in-process over `app.fetch` for speed):
//   - The MOTHERSHIP is a stock Node facade (`buildNodeContainer` over real Postgres). It
//     owns the org/durable state and answers `POST /internal/persistence` (machine-token
//     gated, allow-list + account scope). Built once per worker db and shared across apps.
//   - The SYSTEM UNDER TEST is a `buildNodeContainer` with NO database (`db` undefined): its
//     `CoreRepositories` are `createRemoteRepositoryRegistry` pointed at an in-process client
//     that calls the mothership's `app.fetch`. Credentials stay in a `:memory:` node:sqlite
//     store, exactly as `composeMothership` wires them. This is the "remote-node" config.
//
// The behavioural assertions (`call` / `drive`) hit the SUT, so every org/durable read+write
// travels through the allow-list; the seed/probe helpers operate on the MOTHERSHIP directly
// (the source of truth), mirroring the existing harnesses' direct-store seams.
// ---------------------------------------------------------------------------

const SEED_CLOCK: Clock = { now: () => Date.now() }

// The fixed conformance user that owns every workspace the harness seeds on the mothership.
// The machine token is signed for this user (so `selfUser`-scoped reads — `findPersonalByUser`,
// `membership.listByUser` — resolve), and scoped to the accounts created below.
const CONF_USER = {
  id: 'usr_conformance-owner',
  login: 'conformance-owner',
  name: 'Conformance Owner',
}

// The mothership runs a stock Node backend with every integration the SUT delegates to it
// ENABLED, so its repository registry actually wires those repos (a remote call to an unwired
// repo otherwise comes back `... is not wired`). It is NOT dev-open — it only answers the
// machine-token RPC — so a login provider is configured to satisfy the boot guard (password
// over the shared session secret); the harness never makes a user-authenticated HTTP call to it.
const MOTHERSHIP_ENV: NodeJS.ProcessEnv = buildMothershipEnv({ SLACK_ENABLED: 'true' })

// The system-under-test env: dev-open (the shared suite calls with no session), no local
// Postgres. Same integration toggles as the mothership so the engine builds the same modules.
const SUT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY,
  AUTH_SESSION_SECRET: SESSION_SECRET,
  // Local mode requires the harness inbound-auth secret (the SUT boots through applyLocalDefaults).
  HARNESS_SHARED_SECRET: 'mothership-test-harness-secret',
  SLACK_ENABLED: 'true',
  PROMPT_LIBRARY_ENABLED: 'true',
  DOCUMENT_SOURCES: 'confluence,notion,github,figma,zeplin,linear',
}

const BASE = 'https://cat-factory.test'

/**
 * Connect to the test Postgres and ensure the schema for the MOTHERSHIP. Each vitest worker
 * gets its OWN database (`<base>_mship_<workerId>`) so the mothership-mode spec files run with
 * file parallelism without racing — and the `mship` label keeps these distinct from the Node
 * (`_node_`) and local (`_local_`) suites' databases on a shared server.
 */
export async function setupMothershipDb(): Promise<DrizzleDb> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required to run the mothership conformance tests')
  // Require a per-worker database: never fall back to the base DATABASE_URL — this suite DROPS +
  // recreates its database each run, so running against the base DB would destroy a dev DB.
  const worker = deriveWorkerDatabase(url, 'mship', process.env.VITEST_WORKER_ID)
  if (!worker) {
    throw new Error(
      'The mothership test suite requires a VITEST_WORKER_ID-scoped database; refusing to run ' +
        '(and drop/recreate) against the base DATABASE_URL. Run via vitest (which sets VITEST_WORKER_ID).',
    )
  }
  // The mothership starts FRESH each run (drop + recreate the worker db). Unlike the Node/local
  // suites — which tolerate a reused db because they never enforce scope — the seeded demo boards
  // reuse FIXED block ids (`blk_auth`, …) across workspaces, so a stale row left from a previous
  // run would make an entity-id read (`findById`) resolve to an account outside the current run's
  // token scope and 404. A clean db keeps every such row owned by a this-run (in-scope) account.
  await recreateDatabase(url, worker.dbName)
  const { db, pool } = createDbClient(worker.url)
  await migrate(db, pool)
  // The mothership enforces the accounts/memberships → users(id) FKs, so the fixed org owner
  // the machine token is signed for (CONF_USER) must exist as a real users row before any
  // createOrg. Production always mints it at login; the machine-token harness bypasses login,
  // so seed it once per db. Idempotent.
  await db
    .insert(schema.users)
    .values({
      id: CONF_USER.id,
      name: CONF_USER.name,
      email: null,
      avatar_url: null,
      created_at: Date.now(),
    })
    .onConflictDoNothing()
  return db
}

async function recreateDatabase(baseUrl: string, dbName: string): Promise<void> {
  // Admin over the `postgres` maintenance DB (not the app's base DATABASE_URL): DROP DATABASE
  // cannot run against the database you are connected to, and this keeps the admin pool off a
  // developer's dev DB entirely.
  const { pool } = createDbClient(adminDatabaseUrl(baseUrl))
  try {
    // FORCE terminates any lingering backends so the drop can't be blocked by a stale connection.
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    try {
      await pool.query(`CREATE DATABASE "${dbName}"`)
    } catch (err) {
      if ((err as { code?: string }).code !== '42P04') throw err
    }
  } finally {
    await pool.end()
  }
}

interface Mothership {
  container: ServerContainer
  app: ReturnType<typeof createApp>
  // Every account seeded across the spec file's apps. The machine token is signed over this
  // SHARED set, not a per-app one: the seeded demo boards reuse FIXED block ids
  // (`blk_frontend`, `mod_sessions`, …) across workspaces in the one shared mothership db, so
  // entity-id-keyed reads (`blockRepository.findById`, `serviceRepository.getByFrameBlock`)
  // resolve an arbitrary matching row — which may belong to another app's account. Scoping the
  // token to ALL seeded accounts keeps such a read in-scope (the suite never asserts
  // cross-app isolation; scope ENFORCEMENT is unit-tested in persistenceRpc.spec.ts).
  scopeAccountIds: Set<string>
}

// One mothership backend + machine API per worker db, shared across every `makeApp` call in a
// spec file. Only the SUT is rebuilt per app, so the per-`makeApp` cost matches the existing
// single-container harnesses.
const mothershipByDb = new WeakMap<DrizzleDb, Mothership>()
function getMothership(db: DrizzleDb): Mothership {
  let ms = mothershipByDb.get(db)
  if (!ms) {
    const container = buildNodeContainer({ db, env: MOTHERSHIP_ENV })
    ms = {
      container,
      app: createApp(container, MOTHERSHIP_ENV),
      scopeAccountIds: new Set<string>(),
    }
    mothershipByDb.set(db, ms)
  }
  return ms
}

/**
 * Build one mothership-mode conformance app over the shared Postgres mothership. The SUT is a
 * no-database `buildNodeContainer` whose repositories are RPC-backed; the deterministic fake
 * agent + no-op runner let the suite advance runs itself via `drive`.
 */
export function makeMothershipConformanceApp(
  db: DrizzleDb,
  agentOptions?: FakeAgentOptions,
  opts?: {
    cloudflareModelsEnabled?: boolean
    resolveRunRepoContext?: CoreDependencies['resolveRunRepoContext']
    resolveBinaryArtifactStore?: CoreDependencies['resolveBinaryArtifactStore']
    gateProviders?: GateProviderOverrides
    environmentProvider?: CoreDependencies['environmentProvider']
    resolveRepoFilesForCoords?: CoreDependencies['resolveRepoFilesForCoords']
    backendRegistries?: BackendRegistries
    initiativePresetRegistry?: CoreDependencies['initiativePresetRegistry']
    testerQualityReviewer?: CoreDependencies['testerQualityReviewer']
    detectionConventions?: CoreDependencies['detectionConventions']
  },
): ConformanceApp {
  const ms = getMothership(db)

  // The machine token's account scope grows as the harness seeds workspaces (each under a real,
  // scoped account on the mothership — a dev-open node's null/personal account would 404 over
  // the scoped RPC). The in-process client signs a fresh token over the CURRENT scope per call,
  // so a workspace created after the SUT was built is still reachable. (Scope enforcement itself
  // is unit-tested in persistenceRpc.spec.ts; here a broad self-authored token just lets the
  // repository-surface assertions run.)
  const scopeAccountIds = ms.scopeAccountIds
  const client: PersistenceRpcClient = {
    async call(request: PersistenceRpcRequest): Promise<PersistenceRpcResponse> {
      const { token } = await mintMachineToken(SESSION_SECRET, {
        userId: CONF_USER.id,
        accountIds: [...scopeAccountIds],
        nodeId: 'node_conformance',
      })
      const res = await ms.app.fetch(
        new Request('http://mothership.internal/internal/persistence', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(request),
        }),
      )
      const body = (await res.json().catch(() => null)) as PersistenceRpcResponse | null
      if (body && typeof body === 'object' && 'ok' in body) {
        if (!body.ok && process.env.MSHIP_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(
            `[rpc] ${request.repo}.${request.method}(${JSON.stringify(request.args)}) -> ${body.error.code}: ${body.error.message} (scope=${[...scopeAccountIds].join(',')})`,
          )
        }
        return body
      }
      return {
        ok: false,
        error: { code: 'internal', message: `persistence RPC failed (HTTP ${res.status})` },
      }
    },
  }

  const repos = createRemoteRepositoryRegistry(client) as unknown as CoreRepositories
  const credentialStore = createLocalCredentialStore(':memory:')
  const recorder = new RecordingEventPublisher()
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentOptions)
      : new FakeAgentExecutor(agentOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    repoBootstrapper: new FakeRepoBootstrapper(),
    envConfigRepairer: new FakeEnvConfigRepairer(),
    envConfigRepairRunner: new NoopEnvConfigRepairRunner(),
    executionEventPublisher: recorder,
    taskSourceProviders: [new FakeTaskSourceProvider('jira'), new FakeTaskSourceProvider('linear')],
    ...(opts?.resolveRunRepoContext ? { resolveRunRepoContext: opts.resolveRunRepoContext } : {}),
    ...(opts?.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: opts.resolveBinaryArtifactStore }
      : {}),
    ...(opts?.environmentProvider ? { environmentProvider: opts.environmentProvider } : {}),
    ...(opts?.resolveRepoFilesForCoords
      ? { resolveRepoFilesForCoords: opts.resolveRepoFilesForCoords }
      : {}),
    ...(opts?.detectionConventions ? { detectionConventions: opts.detectionConventions } : {}),
    // Inject the test quality-control companion's inline reviewer (a fake in the suite) so the
    // full QC loop is driven through the mothership composition root without a model, identically
    // to the Worker/Node/local-standalone harnesses.
    ...(opts?.testerQualityReviewer ? { testerQualityReviewer: opts.testerQualityReviewer } : {}),
  }

  const container = buildNodeContainer({
    // No `db`: org/durable state is the remote registry, credentials are the local sqlite store.
    repos,
    env: SUT_ENV,
    overrides,
    providerApiKeyRepository: credentialStore.providerApiKeyRepository,
    localModelEndpointRepository: credentialStore.localModelEndpointRepository,
    // Inject the subscription-credential trio from the local sqlite store too, exactly as
    // `buildLocalContainer` does in production — so the mothership SUT wires these buckets locally
    // (subscription + personal-subscription services ON, activation cleared into the local bucket)
    // instead of routing them remotely. Keeps the conformance topology faithful to the real local
    // facade and makes the engine core's activation clear-on-completion hit the local repo.
    providerSubscriptionTokenRepository: credentialStore.providerSubscriptionTokenRepository,
    personalSubscriptionRepository: credentialStore.personalSubscriptionRepository,
    subscriptionActivationRepository: credentialStore.subscriptionActivationRepository,
    cloudflareModelsEnabled: opts?.cloudflareModelsEnabled ?? true,
    gateProviders: opts?.gateProviders,
    ...(opts?.backendRegistries ? { backendRegistries: opts.backendRegistries } : {}),
    // Inject the app-owned initiative-preset registry (pre-loaded with a custom preset in the
    // custom-preset suite) so the SUT container resolves it by reference on this runtime — the
    // same DI seam the Worker/Node/local-standalone harnesses wire.
    ...(opts?.initiativePresetRegistry
      ? { initiativePresetRegistry: opts.initiativePresetRegistry }
      : {}),
  })
  const app = createApp(container, SUT_ENV)

  async function call<T>(method: string, path: string, body?: unknown) {
    const hasBody = body !== undefined
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  // Seed workspaces on the MOTHERSHIP directly (org/account creation is an onboarding concern,
  // deliberately NOT exposed over the persistence RPC — a machine token scopes accounts, it can't
  // mint them). Each new account id is added to the token scope so the SUT can reach it remotely.
  async function seedWorkspace(account: Account, options: { name?: string; seed?: boolean }) {
    scopeAccountIds.add(account.id)
    return (await ms.container.workspaceService.create(
      // Match the HTTP `POST /workspaces` default (`input.seed ?? true`) the other harnesses
      // get for free — most execution assertions reference the seeded demo board (`task_login`,
      // `pl_quick`, `mod_sessions`). `createOrgWorkspace` overrides this to `false`.
      { name: options.name ?? 'Board', seed: options.seed ?? true },
      CONF_USER.id,
      account.id,
    )) as WorkspaceSnapshot
  }

  // Each workspace gets its OWN fresh account. The seeded demo board uses FIXED block ids
  // (`blk_frontend`, …) and services are uniquely keyed `(account_id, frame_block_id)`, so two
  // seeded workspaces sharing one account would collide on that index. The default Node/local
  // harness sidesteps this because dev-open workspaces get a NULL account (NULLs don't collide),
  // but a scoped machine RPC needs a real in-scope account — so isolate per workspace instead.
  let accountSeq = 0
  async function freshAccount(label: string): Promise<Account> {
    const account = await ms.container.accountService.createOrg(CONF_USER, {
      name: `${label} ${(accountSeq += 1)}`,
    })
    return account
  }

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    return seedWorkspace(await freshAccount('WS'), options)
  }

  async function createOrgWorkspace(options: { name?: string } = {}): Promise<WorkspaceSnapshot> {
    const name = options.name ?? 'Org board'
    return seedWorkspace(await freshAccount(`${name} org`), { name, seed: false })
  }

  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    return driveWorkspace(
      container.executionService,
      workspaceId,
      async () => (await container.workspaceService.snapshot(workspaceId)).executions,
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

  // Seed/probe helpers write to the MOTHERSHIP's own Drizzle repos (the source of truth), so the
  // SUT then reads them back over the RPC — exactly as the engine does in production.
  const mothershipRepos = () => createDrizzleRepositories(db, SEED_CLOCK)

  function seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string) {
    return mothershipRepos().requirementReviewRepository.upsert(
      workspaceId,
      makeIncorporatedReview(blockId, requirements),
    )
  }
  function seedReadyReview(workspaceId: string, blockId: string) {
    return mothershipRepos().requirementReviewRepository.upsert(
      workspaceId,
      makeReadyReviewWithOpenItem(blockId),
    )
  }
  function seedIncorporatedClarityReview(workspaceId: string, blockId: string, report: string) {
    return mothershipRepos().clarityReviewRepository.upsert(
      workspaceId,
      makeIncorporatedClarityReview(blockId, report),
    )
  }
  function seedService(service: Service) {
    return mothershipRepos().serviceRepository.insert(service)
  }
  function getService(id: string) {
    return mothershipRepos().serviceRepository.get(id)
  }

  return {
    call,
    createWorkspace,
    createOrgWorkspace,
    // The mothership harness routes persistence over the RPC and does not run the auth-enabled
    // workspace-RBAC suite; expose the fields to satisfy the type, with auth reported off.
    authEnabled: false,
    session: async () => {
      throw new Error('mothership harness does not run the auth-enabled workspace-RBAC suite')
    },
    createWorkspaceInAccount: (accountId, ownerUserId, options) =>
      container.workspaceService.create(
        { name: options?.name ?? 'RBAC board', seed: options?.seed ?? false },
        ownerUserId,
        accountId,
      ),
    drive,
    startExecution: (workspaceId, blockId, pipelineId, opts) =>
      container.executionService.start(workspaceId, blockId, pipelineId, {
        gatesOverride: opts?.gates,
      }),
    driveBootstrap,
    driveEnvConfigRepair,
    executionEmits,
    boardEmits,
    seedIncorporatedReview,
    seedReadyReview,
    seedIncorporatedClarityReview,
    // The execution-scoped CAS assertion reads the MOTHERSHIP's execution store (the authority).
    executionRepository: () => ms.container.executionRepository,
    agentRunRepository: () => ms.container.agentRunRepository,
    // Direct-store probes read the mothership's authoritative Postgres, like seedService.
    blockRepository: () => mothershipRepos().blockRepository,
    workspaceRepository: () => new DrizzleWorkspaceRepository(db),
    workspaceMemberRepository: () => new DrizzleWorkspaceMemberRepository(db),
    initiativeRepository: () => mothershipRepos().initiativeRepository,
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
  }
}
