import { describe, expect, it } from 'vitest'
import type { BootstrapJob, ReferenceArchitecture } from '@cat-factory/contracts'
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

  it('creates a repo from a reference architecture and records a succeeded job', async () => {
    const bootstrapper = new FakeRepoBootstrapper()
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
      repoName: 'new-service',
      description: 'a new service',
      private: true,
      instructions: 'Rename to new-service.',
    })
    expect(job.status).toBe(201)
    expect(job.body.status).toBe('succeeded')
    expect(job.body.repoUrl).toBe('https://github.com/acme/new-service')
    expect(job.body.repoOwner).toBe('acme')
    expect(job.body.referenceArchitectureName).toBe('Service Template')

    // The composed instructions fold the reference defaults in front of the extras.
    expect(bootstrapper.calls).toHaveLength(1)
    expect(bootstrapper.calls[0]!.instructions).toBe(
      'Keep the structure; update names.\n\nRename to new-service.',
    )
    expect(bootstrapper.calls[0]!.referenceRepo).toEqual({
      owner: 'acme',
      name: 'service-template',
    })

    const list = await app.call<BootstrapJob[]>('GET', `${base}/jobs`)
    expect(list.body).toHaveLength(1)
    const fetched = await app.call<BootstrapJob>('GET', `${base}/jobs/${job.body.id}`)
    expect(fetched.body.status).toBe('succeeded')
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
    expect(job.body.status).toBe('succeeded')
    expect(job.body.referenceArchitectureId).toBeNull()
    expect(job.body.referenceArchitectureName).toBeNull()
    expect(job.body.instructions).toBe('Scaffold a TypeScript Hono API with a /health route.')

    // The bootstrapper is invoked with no reference repo to clone.
    expect(bootstrapper.calls).toHaveLength(1)
    expect(bootstrapper.calls[0]!.referenceRepo).toBeUndefined()
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
