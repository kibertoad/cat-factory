import { AsyncFakeAgentExecutor } from '@cat-factory/conformance'
import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { logger } from '@cat-factory/server'
import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { type DrizzleDb, createDbClient } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { startExecutionWorker } from '../src/execution/pgBossRunner.js'
import { createApp } from '../src/server.js'

// End-to-end test of the Node durable execution path: a started run is driven to
// completion by the pg-boss worker (the Node analogue of the Worker's Cloudflare
// Workflows driver), exercising `PgBossWorkRunner` + `driveExecution` against a real
// Postgres + a real pg-boss instance — NOT the NoopWorkRunner the conformance suite uses.
// The `coder` step runs as a POLLED async job, so `driveExecution`'s real `awaiting_job`
// poll loop (sleep → pollAgentJob → repeat) is exercised durably, not just inline steps.

const BASE = 'https://cat-factory.test'
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AUTH_DEV_OPEN: 'true',
  ENVIRONMENT: 'test',
  // Always-on task-source integration → `loadNodeConfig` requires this key (32 zero bytes).
  TASKS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
}

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('node durable execution (pg-boss)', () => {
  let db: DrizzleDb
  let pool: Pool
  let boss: PgBoss
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    const client = createDbClient(databaseUrl!)
    db = client.db
    pool = client.pool
    await migrate(db, pool)

    boss = new PgBoss(databaseUrl!)
    await boss.start()

    const container = buildNodeContainer({
      db,
      boss,
      env: TEST_ENV,
      overrides: {
        agentExecutor: new AsyncFakeAgentExecutor({
          confidence: 1,
          asyncKinds: ['coder'],
          asyncPolls: 2,
        }),
      },
    })
    await startExecutionWorker(
      boss,
      container,
      {
        jobPollIntervalMs: 50,
        jobMaxPolls: 40,
        jobPollFailureTolerance: 6,
        ciPollIntervalMs: 50,
        ciMaxPolls: 40,
      },
      logger,
    )
    app = createApp(container, TEST_ENV)
  }, 30_000)

  afterAll(async () => {
    await boss?.stop({ graceful: false })
    await pool?.end()
  })

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

  it('drives a started run to completion via the pg-boss worker', async () => {
    const { body: snapshot } = await call<WorkspaceSnapshot>('POST', '/workspaces', {})
    const wsId = snapshot.workspace.id

    const start = await call<ExecutionInstance>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: 'pl_quick' },
    )
    expect(start.status).toBe(201)
    expect(start.body.status).toBe('running')

    // The pg-boss worker (not this test) advances the run. Poll the snapshot until it
    // settles, proving startRun → queue → driveExecution → done works durably.
    const deadline = Date.now() + 20_000
    let exec: ExecutionInstance | undefined
    while (Date.now() < deadline) {
      const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
      exec = snap.body.executions.find((e) => e.blockId === 'task_login')
      if (exec && exec.status !== 'running' && exec.status !== 'paused') break
      await new Promise((r) => setTimeout(r, 200))
    }

    expect(exec?.status).toBe('done')
    expect(exec?.steps.every((s) => s.state === 'done')).toBe(true)
    // The coder step could only have reached `done` by the durable driver polling its
    // async job to completion (startJob → awaiting_job → pollJob → done).
    expect(exec?.steps.find((s) => s.agentKind === 'coder')?.output).toContain('[coder]')
  }, 30_000)
})
