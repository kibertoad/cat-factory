import { describe, expect, it } from 'vitest'
import type { Block, BootstrapJob, ReferenceArchitecture, WorkspaceSnapshot } from '@cat-factory/contracts'
import { makeApp } from '../helpers'
import { FakeRepoBootstrapper } from '../fakes/FakeRepoBootstrapper'

// The repo-bootstrap feature: reference-architecture CRUD always works (its
// repositories are wired unconditionally), while the "bootstrap repo" run path is
// gated on the RepoBootstrapper being present. Tests inject a fake bootstrapper to
// exercise the orchestration without GitHub or a real container.

async function newWorkspace(app: ReturnType<typeof makeApp>) {
  const ws = await app.createWorkspace({ seed: false })
  return ws.workspace.id
}

const sampleArch = {
  name: 'Service Template',
  description: 'Golden-path microservice',
  repoOwner: 'acme',
  repoName: 'service-template',
  defaultInstructions: 'Keep the structure; update names.',
}

describe('reference architecture management', () => {
  it('creates, lists, updates and deletes reference architectures', async () => {
    const app = makeApp()
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap/reference-architectures`

    const created = await app.call<ReferenceArchitecture>('POST', base, sampleArch)
    expect(created.status).toBe(201)
    expect(created.body.name).toBe('Service Template')
    expect(created.body.repoOwner).toBe('acme')
    expect(created.body.id).toBeTruthy()

    const list = await app.call<ReferenceArchitecture[]>('GET', base)
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)

    const updated = await app.call<ReferenceArchitecture>('PATCH', `${base}/${created.body.id}`, {
      name: 'Renamed Template',
    })
    expect(updated.status).toBe(200)
    expect(updated.body.name).toBe('Renamed Template')
    expect(updated.body.repoOwner).toBe('acme')

    const del = await app.call('DELETE', `${base}/${created.body.id}`)
    expect(del.status).toBe(204)

    const after = await app.call<ReferenceArchitecture[]>('GET', base)
    expect(after.body).toHaveLength(0)
  })

  it('defaults optional fields and 404s an unknown architecture on update', async () => {
    const app = makeApp()
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap/reference-architectures`

    const created = await app.call<ReferenceArchitecture>('POST', base, {
      name: 'Minimal',
      repoOwner: 'acme',
      repoName: 'minimal',
    })
    expect(created.status).toBe(201)
    expect(created.body.description).toBe('')
    expect(created.body.defaultInstructions).toBe('')

    const missing = await app.call('PATCH', `${base}/refarch_does_not_exist`, { name: 'x' })
    expect(missing.status).toBe(404)
  })
})

describe('bootstrap repo', () => {
  it('is unavailable when no bootstrapper is configured', async () => {
    const app = makeApp()
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const arch = await app.call<ReferenceArchitecture>(
      'POST',
      `${base}/reference-architectures`,
      sampleArch,
    )
    const res = await app.call('POST', `${base}/jobs`, {
      referenceArchitectureId: arch.body.id,
      repoName: 'new-service',
    })
    expect(res.status).toBe(503)
  })

  it('dispatches a run, shows a provisional service frame, then links the repo on success', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const arch = await app.call<ReferenceArchitecture>(
      'POST',
      `${base}/reference-architectures`,
      sampleArch,
    )

    // Kicking off a run returns immediately with a `running` job and a provisional
    // board frame (the "bootstrapping…" card) — it does NOT block on the container.
    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      referenceArchitectureId: arch.body.id,
      repoName: 'new-service',
      description: 'a new service',
      private: true,
      instructions: 'Rename to new-service.',
    })
    expect(job.status).toBe(201)
    expect(job.body.status).toBe('running')
    expect(job.body.repoUrl).toBeNull()
    expect(job.body.blockId).toBeTruthy()
    expect(job.body.referenceArchitectureName).toBe('Service Template')

    // The provisional frame is a real, in-progress service block on the board.
    const provisional = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const frame = provisional.body.blocks.find((b: Block) => b.id === job.body.blockId)
    expect(frame).toBeDefined()
    expect(frame!.level).toBe('frame')
    expect(frame!.type).toBe('service')
    expect(frame!.status).toBe('in_progress')
    expect(frame!.title).toBe('new-service')

    // The running bootstrap is carried in the snapshot (so the board can render its
    // progress/failure the moment it loads, without a separate fetch).
    expect(provisional.body.bootstrapJobs?.some((j) => j.id === job.body.id)).toBe(true)

    // The composed instructions fold the reference defaults in front of the extras,
    // captured at dispatch time.
    expect(bootstrapper.calls).toHaveLength(1)
    expect(bootstrapper.calls[0]!.instructions).toBe(
      'Keep the structure; update names.\n\nRename to new-service.',
    )
    expect(bootstrapper.calls[0]!.referenceRepo).toEqual({
      owner: 'acme',
      name: 'service-template',
    })

    // Drive the poll loop (the BootstrapWorkflow's job in production) to completion.
    await app.driveBootstrap(workspaceId, job.body.id)

    const fetched = await app.call<BootstrapJob>('GET', `${base}/jobs/${job.body.id}`)
    expect(fetched.body.status).toBe('succeeded')
    expect(fetched.body.repoUrl).toBe('https://github.com/acme/new-service')
    expect(fetched.body.repoOwner).toBe('acme')

    // The repo is linked to the frame, and the frame becomes a ready service.
    expect(bootstrapper.links).toHaveLength(1)
    expect(bootstrapper.links[0]!.blockId).toBe(job.body.blockId)
    const after = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const ready = after.body.blocks.find((b: Block) => b.id === job.body.blockId)
    expect(ready!.status).toBe('ready')
  })

  it('streams subtask progress onto the job while the container runs', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    bootstrapper.progressScript = [
      { completed: 1, inProgress: 1, total: 3 },
      { completed: 3, inProgress: 0, total: 3 },
    ]
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      repoName: 'progressive',
      instructions: 'Scaffold a service.',
    })
    expect(job.body.status).toBe('running')

    await app.driveBootstrap(workspaceId, job.body.id)
    const fetched = await app.call<BootstrapJob>('GET', `${base}/jobs/${job.body.id}`)
    expect(fetched.body.status).toBe('succeeded')
    // The last reported counts persist on the job (the board renders them as a bar).
    expect(fetched.body.subtasks).toEqual({ completed: 3, inProgress: 0, total: 3 })
  })

  it('marks the job failed and the frame blocked when the run fails mid-flight', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    bootstrapper.failPollWith = 'push rejected'
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      repoName: 'doomed-run',
      instructions: 'Scaffold a service.',
    })
    expect(job.body.status).toBe('running')
    expect(job.body.blockId).toBeTruthy()

    await app.driveBootstrap(workspaceId, job.body.id)
    const fetched = await app.call<BootstrapJob>('GET', `${base}/jobs/${job.body.id}`)
    expect(fetched.body.status).toBe('failed')
    expect(fetched.body.error).toBe('push rejected')
    // Structured diagnostics are captured alongside the one-line error, and the
    // per-run container is reclaimed best-effort.
    expect(fetched.body.failure?.kind).toBe('agent')
    expect(fetched.body.failure?.message).toBe('push rejected')
    expect(fetched.body.failure?.hint).toBeTruthy()
    expect(bootstrapper.stopped).toContain(job.body.id)

    const snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const frame = snap.body.blocks.find((b: Block) => b.id === job.body.blockId)
    expect(frame!.status).toBe('blocked')
  })

  it('retries a failed run: a fresh run reuses the frame and drives it to success', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    bootstrapper.failPollWith = 'push rejected'
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      repoName: 'retry-me',
      instructions: 'Scaffold a service.',
    })
    await app.driveBootstrap(workspaceId, job.body.id)
    const failed = await app.call<BootstrapJob>('GET', `${base}/jobs/${job.body.id}`)
    expect(failed.body.status).toBe('failed')

    // Clear the fault and retry via the unified agent-run endpoint: a NEW job is
    // created that reuses the original frame.
    bootstrapper.failPollWith = null
    const retry = await app.call<{ kind: string; run: BootstrapJob }>(
      'POST',
      `/workspaces/${workspaceId}/agent-runs/${job.body.id}/retry`,
    )
    expect(retry.status).toBe(201)
    expect(retry.body.kind).toBe('bootstrap')
    expect(retry.body.run.status).toBe('running')
    expect(retry.body.run.id).not.toBe(job.body.id)
    expect(retry.body.run.blockId).toBe(job.body.blockId)
    expect(retry.body.run.failure).toBeNull()

    // The reused frame flips back to in-progress while the retry runs.
    let snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    let frame = snap.body.blocks.find((b: Block) => b.id === job.body.blockId)
    expect(frame!.status).toBe('in_progress')

    // Drive the retry to success: the same frame becomes a ready, linked service.
    await app.driveBootstrap(workspaceId, retry.body.run.id)
    const done = await app.call<BootstrapJob>('GET', `${base}/jobs/${retry.body.run.id}`)
    expect(done.body.status).toBe('succeeded')
    snap = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    frame = snap.body.blocks.find((b: Block) => b.id === job.body.blockId)
    expect(frame!.status).toBe('ready')
  })

  it('409s retrying a job that is not in a failed state', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      repoName: 'still-running',
      instructions: 'Scaffold a service.',
    })
    expect(job.body.status).toBe('running')

    const retry = await app.call(
      'POST',
      `/workspaces/${workspaceId}/agent-runs/${job.body.id}/retry`,
    )
    expect(retry.status).toBe(409)
  })

  it('409s without recording a job when the workspace is not connected to GitHub', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    bootstrapper.connected = false
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const res = await app.call('POST', `${base}/jobs`, {
      repoName: 'unconnected',
      instructions: 'Scaffold something.',
    })
    expect(res.status).toBe(409)

    // The pre-flight check runs before any job is recorded and before the
    // bootstrapper's side-effecting run is invoked.
    expect(bootstrapper.calls).toHaveLength(0)
    const list = await app.call<BootstrapJob[]>('GET', `${base}/jobs`)
    expect(list.body).toHaveLength(0)
  })

  it('records a failed job when the bootstrapper throws', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    bootstrapper.failWith = 'repo already exists'
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/bootstrap`

    const arch = await app.call<ReferenceArchitecture>(
      'POST',
      `${base}/reference-architectures`,
      sampleArch,
    )
    const job = await app.call<BootstrapJob>('POST', `${base}/jobs`, {
      referenceArchitectureId: arch.body.id,
      repoName: 'doomed',
    })
    expect(job.status).toBe(201)
    expect(job.body.status).toBe('failed')
    expect(job.body.error).toBe('repo already exists')
    expect(job.body.repoUrl).toBeNull()
  })

  it('bootstraps from a freeform prompt with no reference architecture', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
    const app = makeApp(undefined, { repoBootstrapper: bootstrapper })
    const workspaceId = await newWorkspace(app)

    const job = await app.call<BootstrapJob>('POST', `/workspaces/${workspaceId}/bootstrap/jobs`, {
      repoName: 'from-scratch',
      instructions: 'Scaffold a TypeScript Hono API with a /health route.',
    })
    expect(job.status).toBe(201)
    expect(job.body.status).toBe('running')
    expect(job.body.referenceArchitectureId).toBeNull()
    expect(job.body.referenceArchitectureName).toBeNull()
    expect(job.body.instructions).toBe('Scaffold a TypeScript Hono API with a /health route.')

    // The bootstrapper is dispatched with no reference repo to clone.
    expect(bootstrapper.calls).toHaveLength(1)
    expect(bootstrapper.calls[0]!.referenceRepo).toBeUndefined()

    await app.driveBootstrap(workspaceId, job.body.id)
    const fetched = await app.call<BootstrapJob>(
      'GET',
      `/workspaces/${workspaceId}/bootstrap/jobs/${job.body.id}`,
    )
    expect(fetched.body.status).toBe('succeeded')
  })

  it('rejects a bootstrap with neither a reference architecture nor instructions', async () => {
    const app = makeApp(undefined, { repoBootstrapper: new FakeRepoBootstrapper() })
    const workspaceId = await newWorkspace(app)
    const res = await app.call('POST', `/workspaces/${workspaceId}/bootstrap/jobs`, {
      repoName: 'no-brief',
    })
    expect(res.status).toBe(400)
  })

  it('404s a bootstrap against an unknown reference architecture', async () => {
    const app = makeApp(undefined, { repoBootstrapper: new FakeRepoBootstrapper() })
    const workspaceId = await newWorkspace(app)
    const res = await app.call('POST', `/workspaces/${workspaceId}/bootstrap/jobs`, {
      referenceArchitectureId: 'refarch_missing',
      repoName: 'whatever',
    })
    expect(res.status).toBe(404)
  })
})
