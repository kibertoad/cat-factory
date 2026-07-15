import { FakeAgentExecutor } from '@cat-factory/conformance'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'

// The public external API (`/api/v1`) over the real Hono app + real local D1, inside workerd:
// issue a key, run a public inline "initiative" pipeline headlessly, retrieve the DB-persisted
// result asynchronously, and prove the anchoring block never appears on the board. The Node facade
// asserts the repository + snapshot parity via the cross-runtime conformance suite.

describe('public API — break down an initiative', () => {
  it('issues a key, runs headlessly, retrieves the result, and hides the anchor block', async () => {
    const app = makeApp(new FakeAgentExecutor())
    // Public-API keys are account-scoped, so use a seeded ORG workspace (the seed brings the
    // built-in `pl_initiative_breakdown` pipeline).
    const snapshot = await app.createOrgWorkspace({ seed: true })
    const workspaceId = snapshot.workspace.id

    // Mint a public-API key via the session-authed management route (dev-open in tests).
    const created = await app.call<{ key: { id: string }; secret: string }>(
      'POST',
      `/workspaces/${workspaceId}/public-api-keys`,
      { label: 'external system' },
    )
    expect(created.status).toBe(201)
    const secret = created.body.secret
    expect(secret).toMatch(/^cf_live_pak_[0-9a-f]+\.[0-9a-f]+$/)

    const auth = { authorization: `Bearer ${secret}` }

    // A missing/invalid key is rejected.
    const noKey = await app.call('POST', '/api/v1/initiatives', {
      pipelineId: 'pl_initiative_breakdown',
      input: 'x',
    })
    expect(noKey.status).toBe(401)

    // Start an initiative breakdown.
    const started = await app.call<{ jobId: string; status: string }>(
      'POST',
      '/api/v1/initiatives',
      { pipelineId: 'pl_initiative_breakdown', input: 'Build a cat feeder service' },
      auth,
    )
    expect(started.status).toBe(202)
    const jobId = started.body.jobId
    expect(started.body.status).toBe('running')

    // Drive the durable run to completion (the Workflows driver does this in production).
    await app.drive(workspaceId)

    // The persisted result is retrievable by job id.
    const job = await app.call<{ status: string; result: { output: string } | null }>(
      'GET',
      `/api/v1/jobs/${jobId}`,
      undefined,
      auth,
    )
    expect(job.status).toBe(200)
    expect(job.body.status).toBe('succeeded')
    expect(job.body.result?.output).toBeTruthy()

    // The headless anchor block is excluded from the board snapshot.
    const board = await app.call<{ blocks: { title: string; internal?: boolean }[] }>(
      'GET',
      `/workspaces/${workspaceId}`,
    )
    expect(board.status).toBe(200)
    expect(board.body.blocks.some((b) => b.internal)).toBe(false)
    expect(board.body.blocks.some((b) => b.title === 'Build a cat feeder service')).toBe(false)

    // A non-public pipeline id is refused.
    const nonPublic = await app.call(
      'POST',
      '/api/v1/initiatives',
      { pipelineId: 'pl_blueprint', input: 'x' },
      auth,
    )
    expect(nonPublic.status).toBe(400)

    // After revoking the key it no longer authenticates.
    const revoked = await app.call(
      'DELETE',
      `/workspaces/${workspaceId}/public-api-keys/${created.body.key.id}`,
    )
    expect(revoked.status).toBe(204)
    const afterRevoke = await app.call('GET', `/api/v1/jobs/${jobId}`, undefined, auth)
    expect(afterRevoke.status).toBe(401)
  })
})

// The basic board workloads: list services, create a task under one, read its status, list a
// service's tasks, and start a task — all key-scoped to the caller's workspace. Runtime-neutral
// (shared server + orchestration over already-symmetric repo reads), so the Worker spec is the
// primary guard; the conformance suite covers the underlying repo parity.

interface Svc {
  serviceId: string
  title: string
  type: string
  status: string
}
interface Task {
  taskId: string
  serviceId: string
  title: string
  taskType: string
  status: string
  executionId: string | null
  pullRequestUrl: string | null
}

async function mintKey(app: ReturnType<typeof makeApp>, workspaceId: string) {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: 'external system' },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

describe('public API — basic board workloads (services + tasks)', () => {
  it('lists services, creates/reads/lists tasks, and enforces workspace scoping', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const snapshot = await app.createOrgWorkspace({ seed: true })
    const workspaceId = snapshot.workspace.id
    const auth = await mintKey(app, workspaceId)

    // Seed a fresh service frame via the session board API, then find it over the public API.
    const frame = await app.call<{ id: string }>('POST', `/workspaces/${workspaceId}/blocks`, {
      type: 'service',
      position: { x: 400, y: 400 },
    })
    expect(frame.status).toBe(201)
    const serviceId = frame.body.id

    const services = await app.call<{ services: Svc[] }>('GET', '/api/v1/services', undefined, auth)
    expect(services.status).toBe(200)
    expect(services.body.services.some((s) => s.serviceId === serviceId)).toBe(true)

    // Create a task under the service.
    const created = await app.call<Task>(
      'POST',
      `/api/v1/services/${serviceId}/tasks`,
      { title: 'Add a cat photo endpoint', description: 'GET /cats/:id/photo' },
      auth,
    )
    expect(created.status).toBe(201)
    expect(created.body.serviceId).toBe(serviceId)
    expect(created.body.status).toBe('planned')
    expect(created.body.taskType).toBe('feature')
    expect(created.body.executionId).toBeNull()
    const taskId = created.body.taskId

    // Read its status.
    const got = await app.call<Task>('GET', `/api/v1/tasks/${taskId}`, undefined, auth)
    expect(got.status).toBe(200)
    expect(got.body.status).toBe('planned')
    expect(got.body.serviceId).toBe(serviceId)

    // List the service's tasks.
    const list = await app.call<{ tasks: Task[] }>(
      'GET',
      `/api/v1/services/${serviceId}/tasks`,
      undefined,
      auth,
    )
    expect(list.status).toBe(200)
    expect(list.body.tasks.map((t) => t.taskId)).toContain(taskId)

    // Negatives: unknown ids 404; a non-frame container is rejected; a missing key is 401.
    expect((await app.call('GET', '/api/v1/tasks/task_nope', undefined, auth)).status).toBe(404)
    expect((await app.call('GET', '/api/v1/services/svc_nope/tasks', undefined, auth)).status).toBe(
      404,
    )
    expect(
      (await app.call('POST', '/api/v1/services/svc_nope/tasks', { title: 'x' }, auth)).status,
    ).toBe(404)
    expect((await app.call('GET', `/api/v1/tasks/${taskId}`)).status).toBe(401)

    // Workspace scoping: a key from ANOTHER workspace cannot see this task.
    const other = await app.createOrgWorkspace({ seed: true })
    const otherAuth = await mintKey(app, other.workspace.id)
    expect((await app.call('GET', `/api/v1/tasks/${taskId}`, undefined, otherAuth)).status).toBe(
      404,
    )
    expect(
      (await app.call('GET', `/api/v1/services/${serviceId}/tasks`, undefined, otherAuth)).status,
    ).toBe(404)
  })

  it('starts a task and reflects the run status; refuses an individual-usage model', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const workspaceId = (await app.createOrgWorkspace({ seed: true })).workspace.id
    const auth = await mintKey(app, workspaceId)

    // Start the seeded task via the public API (no pinned pipeline → pass one explicitly).
    const started = await app.call<Task>(
      'POST',
      '/api/v1/tasks/task_login/start',
      { pipelineId: 'pl_quick' },
      auth,
    )
    expect(started.status).toBe(202)
    expect(started.body.status).toBe('in_progress')
    expect(started.body.executionId).toBeTruthy()

    // Drive the durable run to completion and confirm the status surfaces.
    await app.drive(workspaceId)
    const done = await app.call<Task>('GET', '/api/v1/tasks/task_login', undefined, auth)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('done')

    // A task with no pipeline (none pinned, none supplied) can't be started.
    const frame = await app.call<{ id: string }>('POST', `/workspaces/${workspaceId}/blocks`, {
      type: 'service',
      position: { x: 700, y: 700 },
    })
    const task = await app.call<Task>(
      'POST',
      `/api/v1/services/${frame.body.id}/tasks`,
      { title: 'Pin an individual model' },
      auth,
    )
    expect(
      (await app.call('POST', `/api/v1/tasks/${task.body.taskId}/start`, {}, auth)).status,
    ).toBe(400)

    // Pin a subscription-only individual-usage model (no poolable base) → start is refused (no
    // headless personal-credential unlock). A base-backed model like claude-opus would instead
    // run on its OpenRouter base, so it is deliberately NOT the case under test here.
    await app.call('PATCH', `/workspaces/${workspaceId}/blocks/${task.body.taskId}`, {
      modelId: 'claude-sonnet',
    })
    const refused = await app.call<{ error: { code: string } }>(
      'POST',
      `/api/v1/tasks/${task.body.taskId}/start`,
      { pipelineId: 'pl_quick' },
      auth,
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('individual_model_unsupported')
  })
})
