import {
  AsyncFakeAgentExecutor,
  type ConformanceApp,
  FakeAgentExecutor,
  type FakeAgentOptions,
  RecordingEventPublisher,
  makeIncorporatedReview,
} from '@cat-factory/conformance'
import {
  type DrizzleDb,
  createApp,
  createDbClient,
  createDrizzleRepositories,
  migrate,
} from '@cat-factory/node-server'
import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { buildLocalContainer } from '../src/container.js'

const BASE = 'https://cat-factory.test'

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
export function makeConformanceApp(db: DrizzleDb, agentOptions?: FakeAgentOptions): ConformanceApp {
  const recorder = new RecordingEventPublisher()
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentOptions)
      : new FakeAgentExecutor(agentOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    executionEventPublisher: recorder,
  }
  const container = buildLocalContainer({ db, env: TEST_ENV, overrides })
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
    const user = { id: 1, login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await container.accountService.createOrg(user, { name: `${name} org` })
    return container.workspaceService.create({ name, seed: false }, user.id, org.id)
  }

  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    for (let round = 0; round < maxRounds; round++) {
      const { executions } = await container.workspaceService.snapshot(workspaceId)
      const active = executions.filter((e) => e.status === 'running' || e.status === 'paused')
      if (active.length === 0) break
      for (const e of active) {
        const exec = container.executionService
        let r = await exec.advanceInstance(workspaceId, e.id)
        for (let hops = 0; hops < 500; hops++) {
          if (r.kind === 'awaiting_job') r = await exec.pollAgentJob(workspaceId, e.id)
          else if (r.kind === 'awaiting_ci') r = await exec.pollCi(workspaceId, e.id)
          else if (r.kind === 'awaiting_conflicts') r = await exec.pollConflicts(workspaceId, e.id)
          else break
        }
      }
    }
    return (await container.workspaceService.snapshot(workspaceId)).executions
  }

  function executionEmits(blockId?: string): ExecutionInstance[] {
    return blockId ? recorder.emits.filter((e) => e.blockId === blockId) : recorder.emits
  }

  // Seed a block's incorporated requirements review directly into the (shared
  // Postgres) store so the engine's reworked-requirements substitution can be driven
  // without running the reviewer LLM — the same Drizzle persistence the Node harness
  // writes through (the local facade reuses the Node repositories).
  function seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string) {
    return createDrizzleRepositories(db).requirementReviewRepository.upsert(
      workspaceId,
      makeIncorporatedReview(blockId, requirements),
    )
  }

  return {
    call,
    createWorkspace,
    createOrgWorkspace,
    drive,
    executionEmits,
    seedIncorporatedReview,
  }
}
