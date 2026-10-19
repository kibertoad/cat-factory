import type { Pipeline, WorkspaceSnapshot } from '@cat-factory/kernel'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DrizzleDb } from '@cat-factory/node-server'
import { makeConformanceApp, setupTestDb } from './harness.js'

// The local-mode "delegate container agents to a runner pool" opt-in start gate. When a
// workspace flips `delegateAgentsToRunnerPool` on but has no pool registered, the run must
// be refused at START with a clean 409 (`agent_backend_unconfigured`) carrying an actionable
// message — NOT an opaque 500. (The pool resolver throws a plain Error that the HTTP error
// handler maps to a 500 with the message suppressed, so the guard checks pool existence
// itself and throws a ConflictError instead.)

// The pool a deployment declares for every account: the `{ config, secrets }` an admin submits.
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

describe('[local] delegate-agents-to-runner-pool start gate', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  it('refuses a delegated run with a clean 409 when no runner pool is registered', async () => {
    const app = makeConformanceApp(db)
    const snapshot = (await app.createWorkspace()) as WorkspaceSnapshot
    const wsId = snapshot.workspace.id

    // Opt the workspace into delegating container agents to its runner pool.
    const settings = await app.call('PUT', `/workspaces/${wsId}/settings`, {
      delegateAgentsToRunnerPool: true,
    })
    expect(settings.status).toBe(200)

    // A coder-only pipeline (no Tester step) isolates the agent-backend gate from the
    // Tester-infra gate.
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Code only',
      purpose: 'build',
      agentKinds: ['coder'],
    })
    expect(pipeline.status).toBe(201)

    // No runner pool is registered for the workspace → the start gate refuses the run with
    // a 409 and the actionable reason, instead of a mid-run dispatch failure / opaque 500.
    const res = await app.call<{ error?: { code?: string; details?: { reason?: string } } }>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )

    expect(res.status).toBe(409)
    expect(res.body.error?.details?.reason).toBe('agent_backend_unconfigured')
  })

  it('admits a delegated run on a board that inherits its account pool from the declared seed', async () => {
    // The guard reads the same EFFECTIVE pool dispatch does. It used to read the board's own row
    // only, so a board whose account pool came from `startLocal({ seedAccountRunnerPool })` was
    // refused at start with the very reason above, while dispatch would have found the pool.
    const app = makeConformanceApp(db, undefined, { seedAccountRunnerPool: () => SEED })
    const snapshot = await app.createOrgWorkspace({ seed: true })
    const wsId = snapshot.workspace.id
    await app.call('PUT', `/workspaces/${wsId}/settings`, { delegateAgentsToRunnerPool: true })
    const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Code only',
      purpose: 'build',
      agentKinds: ['coder'],
    })

    const res = await app.call<{ error?: { details?: { reason?: string } } }>(
      'POST',
      `/workspaces/${wsId}/blocks/task_login/executions`,
      { pipelineId: pipeline.body.id },
    )

    expect(res.body.error?.details?.reason).toBeUndefined()
    expect(res.status).toBe(201)
  })
})
