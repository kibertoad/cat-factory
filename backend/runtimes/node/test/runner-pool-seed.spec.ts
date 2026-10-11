import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshot } from '@cat-factory/contracts'
import { buildNodeContainer } from '../src/container.js'
import { createApp } from '../src/server.js'
import { setupTestDb, TEST_ENV } from './harness.js'

// A declared runner pool, end to end on the stock Node facade against real Postgres: the seed
// rides `buildNodeContainer` into `createCore`, `WorkspaceService.create` registers it on a new
// board, and the board's setup projection then reports an executor. This is the gap the seed
// exists to close: on stock Node a runner pool is the only executor, so without it every new
// board starts unable to run an agent.

const SEED = {
  config: {
    kind: 'kubernetes' as const,
    kubernetes: {
      label: 'Seeded pool',
      apiServerUrl: 'https://k8s.example:6443',
      namespace: 'cat-factory',
      image: 'ghcr.io/acme/executor:1',
    },
  },
  secrets: { apiToken: 'seeded-token' },
}

const describeDb = process.env.DATABASE_URL ? describe : describe.skip

describeDb('declared runner pool (seedRunnerPool)', () => {
  async function appWith(seedRunnerPool?: typeof SEED) {
    const db = await setupTestDb()
    const container = buildNodeContainer({ db, env: TEST_ENV, seedRunnerPool })
    const app = createApp(container, TEST_ENV)
    async function call<T>(method: string, path: string, body?: unknown) {
      const res = await app.fetch(
        new Request(`http://test${path}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: res.status, body: (await res.json()) as T }
    }
    return { container, call }
  }

  it('registers the seed on a new board, so its executor reads as configured', async () => {
    const { call } = await appWith(SEED)

    const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
    expect(created.status).toBe(201)
    expect(created.body.infraSetup?.agentExecutor).toBe('configured')

    const got = await call<{ connection: { kind: string; secretKeys: string[] } | null }>(
      'GET',
      `/workspaces/${created.body.workspace.id}/runner-pool/connection`,
    )
    expect(got.body.connection?.kind).toBe('kubernetes')
    expect(got.body.connection?.secretKeys).toEqual(['apiToken'])
  })

  it('leaves a new board without a pool when nothing is declared', async () => {
    const { call } = await appWith()

    const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

    expect(created.body.infraSetup?.agentExecutor).toBe('not_defined')
  })

  it('never replaces a pool a board already has', async () => {
    const { container, call } = await appWith(SEED)
    const created = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })
    const id = created.body.workspace.id
    await call('POST', `/workspaces/${id}/runner-pool/connection`, {
      config: { ...SEED.config, kubernetes: { ...SEED.config.kubernetes, label: 'Admin pool' } },
      secrets: { apiToken: 'admin-token' },
    })

    // A second pass (the next boot's backfill) must keep the admin's pool.
    await container.runnerPoolSeeder!.ensureForWorkspace(id)

    const got = await call<{ connection: { label: string } | null }>(
      'GET',
      `/workspaces/${id}/runner-pool/connection`,
    )
    expect(got.body.connection?.label).toBe('Admin pool')
  })
})
