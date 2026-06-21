import {
  AsyncFakeAgentExecutor,
  type ConformanceApp,
  FakeAgentExecutor,
  type FakeAgentOptions,
  RecordingEventPublisher,
  makeIncorporatedReview,
} from '@cat-factory/conformance'
import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { buildNodeContainer } from '../src/container.js'
import { type DrizzleDb, createDbClient } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { DrizzleRequirementReviewRepository } from '../src/repositories/drizzle.js'
import { createApp } from '../src/server.js'

const BASE = 'https://cat-factory.test'

// Test env: open the auth gate (dev-open) exactly as the Worker pool does, and pin a
// non-production ENVIRONMENT so `devOpen` is honoured. The integration toggles stay off
// (this MVP wires only the runtime-neutral core), matching the Node config defaults.
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  // The always-on task-source integration makes `loadNodeConfig` require the shared
  // ENCRYPTION_KEY (32 zero bytes, base64) or it throws at config load. Integration
  // toggles that need extra wiring (GitHub/runners) stay off — matching Node defaults.
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
}

/**
 * Connect to the test Postgres (`DATABASE_URL`) and ensure the schema. Idempotent
 * (`CREATE TABLE IF NOT EXISTS`), so each spec file may call it. Returns the shared
 * Drizzle client every app in the file is built over — exactly as the Worker pool
 * shares one local D1.
 */
export async function setupTestDb(): Promise<DrizzleDb> {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required to run the Node conformance/integration tests')
  }
  const { db, pool } = createDbClient(url)
  await migrate(db, pool)
  return db
}

/**
 * Build one app over the shared Postgres with a deterministic agent + no-op durable
 * runner (the suite advances runs itself via `drive`). Mirrors the Worker test
 * helper's `makeApp`, so the shared conformance harness is a thin adapter.
 */
export function makeConformanceApp(db: DrizzleDb, agentOptions?: FakeAgentOptions): ConformanceApp {
  // Record emitted run snapshots so the suite can assert intermediate transitions
  // (e.g. the model present on the first "spinning up container" emit).
  const recorder = new RecordingEventPublisher()
  const overrides: Partial<CoreDependencies> = {
    agentExecutor: agentOptions?.asyncKinds?.length
      ? new AsyncFakeAgentExecutor(agentOptions)
      : new FakeAgentExecutor(agentOptions),
    workRunner: new NoopWorkRunner(),
    bootstrapRunner: new NoopBootstrapRunner(),
    executionEventPublisher: recorder,
  }
  const container = buildNodeContainer({ db, env: TEST_ENV, overrides })
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

  // Drive every active run to a standstill via the engine directly — the Node analogue
  // of the Worker helper's `drive` (production uses the pg-boss durable runner).
  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    for (let round = 0; round < maxRounds; round++) {
      const { executions } = await container.workspaceService.snapshot(workspaceId)
      // The suite also advances `paused` (spend-gated) runs so a spend pause→resume is
      // exercised deterministically. Production diverges intentionally: `driveExecution`
      // parks on `paused` and the stale-run sweeper only re-drives `running`, so a real
      // spend-paused run resumes on an explicit signal, not automatically — that resume
      // path is out of the cross-runtime conformance suite's scope (see drive.ts).
      const active = executions.filter((e) => e.status === 'running' || e.status === 'paused')
      if (active.length === 0) break
      for (const e of active) {
        // Mirror the durable driver: an advance that parks on an async job / CI / conflicts
        // gate is drained by polling, so a polled (container-style) agent step completes
        // here exactly as it does under pg-boss. Inert for the inline fake (never parks).
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

  function seedIncorporatedReview(workspaceId: string, blockId: string, requirements: string) {
    return new DrizzleRequirementReviewRepository(db).upsert(
      workspaceId,
      makeIncorporatedReview(blockId, requirements),
    )
  }

  return { call, createWorkspace, drive, executionEmits, seedIncorporatedReview }
}
