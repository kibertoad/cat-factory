import {
  AsyncFakeAgentExecutor,
  type ConformanceApp,
  FakeAgentExecutor,
  type FakeAgentOptions,
  FakeRepoBootstrapper,
  FakeTaskSourceProvider,
  RecordingEventPublisher,
  driveWorkspace,
  makeIncorporatedClarityReview,
  makeIncorporatedReview,
  makeOnboardingProbe,
  makeReadyReviewWithOpenItem,
} from '@cat-factory/conformance'
import {
  type DrizzleDb,
  createApp,
  createDbClient,
  createDrizzleRepositories,
  migrate,
} from '@cat-factory/node-server'
import type { Clock, ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type { LocalRunner, UpsertLocalModelEndpointInput } from '@cat-factory/contracts'
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
  ENVIRONMENT: 'test',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  // Enable the Slack notification transport so its module + channel wire up through
  // the local facade (parity with the Node/Worker test envs); the conformance Slack
  // CRUD asserts persistence parity and the channel bails when no Slack is connected.
  SLACK_ENABLED: 'true',
  // Opt into the ephemeral-environment integration (parity with the Node/Worker test
  // envs) so the conformance env CRUD asserts persistence parity here too.
  ENVIRONMENTS_ENABLED: 'true',
  // Opt into the prompt-fragment library (ADR 0006) so its module wires up (parity
  // with the Node/Worker test envs); the conformance library CRUD asserts parity.
  PROMPT_LIBRARY_ENABLED: 'true',
  LOCAL_HARNESS_IMAGE: 'cat-factory-executor:test',
  GITHUB_PAT: 'test-pat',
}

/** Connect to the test Postgres (`DATABASE_URL`) and ensure the schema. Idempotent. */
export async function setupTestDb(): Promise<DrizzleDb> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required to run the local conformance tests')
  }
  const { db, pool } = createDbClient(url)
  await migrate(db, pool)
  return db
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
  },
): ConformanceApp {
  const recorder = new RecordingEventPublisher()
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentOptions)
      : new FakeAgentExecutor(agentOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    // Deterministic bootstrapper so the suite drives the bootstrap lifecycle through the
    // local composition root without GitHub/Docker (driven via driveBootstrap).
    repoBootstrapper: new FakeRepoBootstrapper(),
    executionEventPublisher: recorder,
    // Swap the config-wired real Jira provider for a deterministic fake (the Drizzle
    // task repos stay), so the shared suite asserts create-task-from-issue against
    // Postgres without hitting the network. Override wins over the config providers.
    taskSourceProviders: [new FakeTaskSourceProvider('jira')],
    // Inject the engine's run-repo resolver (a fake in the suite) so the registered
    // custom kind's pre/post-op hooks run + commit identically to a real GitHub-wired facade.
    ...(opts?.resolveRunRepoContext ? { resolveRunRepoContext: opts.resolveRunRepoContext } : {}),
  }
  const container = buildLocalContainer({
    db,
    env: TEST_ENV,
    overrides,
    cloudflareModelsEnabled: opts?.cloudflareModelsEnabled,
  })
  const app = createApp(container, TEST_ENV)

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

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    return (await call<WorkspaceSnapshot>('POST', '/workspaces', options)).body
  }

  // Org-scoped workspace via the container's services (dev-open has no signed-in user,
  // so the HTTP account flow can't create the owning org). Mirrors the Node helper.
  async function createOrgWorkspace(options: { name?: string } = {}): Promise<WorkspaceSnapshot> {
    const user = { id: 'usr_org-owner', login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await container.accountService.createOrg(user, { name: `${name} org` })
    return container.workspaceService.create({ name, seed: false }, user.id, org.id)
  }

  // Drive every active run to a standstill through the SHARED production driver
  // (`driveExecution`, via `driveWorkspace`) — the local facade reuses Node's pg-boss
  // runner, so this is the same loop production runs; no hand-rolled twin to drift.
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

  return {
    call,
    createWorkspace,
    createOrgWorkspace,
    drive,
    driveBootstrap,
    executionEmits,
    seedIncorporatedReview,
    seedReadyReview,
    seedIncorporatedClarityReview,
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
