import { describe, expect, it } from 'vitest'
import type {
  Block,
  RepoBlueprint,
  ScanRepoResult,
  WorkspaceSnapshot,
} from '@cat-factory/contracts'
import { makeApp } from '../helpers'
import { FakeRepoScanner } from '../fakes/FakeRepoScanner'

// The board-scan feature: blueprint reads always work (the repository is wired
// unconditionally), while the "scan repository" command is gated on the
// RepoScanner being present. Tests inject a fake scanner to exercise the
// orchestration — decompose, persist, and optionally spawn onto the board —
// without GitHub or a real container.

async function newWorkspace(app: ReturnType<typeof makeApp>) {
  const ws = await app.createWorkspace({ seed: false })
  return ws.workspace.id
}

describe('board scan', () => {
  it('is unavailable when no scanner is configured', async () => {
    const app = makeApp()
    const workspaceId = await newWorkspace(app)
    const res = await app.call('POST', `/workspaces/${workspaceId}/board-scan/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
    })
    expect(res.status).toBe(503)
  })

  it('scans a repo into a persisted blueprint and lists/gets it', async () => {
    const scanner = new FakeRepoScanner()
    const app = makeApp(undefined, { repoScanner: scanner })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/board-scan`

    const scan = await app.call<ScanRepoResult>('POST', `${base}/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
      instructions: 'Focus on the public API.',
    })
    expect(scan.status).toBe(201)
    expect(scan.body.blueprint.source).toBe('llm')
    expect(scan.body.blueprint.repoOwner).toBe('acme')
    expect(scan.body.blueprint.repoName).toBe('orders')
    expect(scan.body.blueprint.service.name).toBe('orders')
    expect(scan.body.blueprint.service.modules).toHaveLength(2)
    // No spawn requested → no board blocks created.
    expect(scan.body.spawn).toBeUndefined()

    // The scanner saw the request, instructions and all.
    expect(scanner.calls).toHaveLength(1)
    expect(scanner.calls[0]!.repo).toEqual({ owner: 'acme', name: 'orders' })
    expect(scanner.calls[0]!.instructions).toBe('Focus on the public API.')

    const list = await app.call<RepoBlueprint[]>('GET', `${base}/blueprints`)
    expect(list.status).toBe(200)
    expect(list.body).toHaveLength(1)

    const fetched = await app.call<RepoBlueprint>(
      'GET',
      `${base}/blueprints/${scan.body.blueprint.id}`,
    )
    expect(fetched.status).toBe(200)
    expect(fetched.body.service.modules[0]!.features).toHaveLength(2)
    expect(fetched.body.service.modules[0]!.features[0]!.references).toEqual(['src/auth/login.ts'])
  })

  it('materialises the blueprint onto the board when spawn is requested', async () => {
    const app = makeApp(undefined, { repoScanner: new FakeRepoScanner() })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/board-scan`

    const scan = await app.call<ScanRepoResult>('POST', `${base}/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
      spawn: true,
    })
    expect(scan.status).toBe(201)
    expect(scan.body.spawn).toBeDefined()
    expect(scan.body.spawn!.modules).toBe(2)
    expect(scan.body.spawn!.features).toBe(3)

    const snapshot = await app.call<WorkspaceSnapshot>('GET', `/workspaces/${workspaceId}`)
    const blocks = snapshot.body.blocks
    const frame = blocks.find((b: Block) => b.id === scan.body.spawn!.frameId)
    expect(frame).toBeDefined()
    expect(frame!.level).toBe('frame')
    expect(frame!.title).toBe('orders')

    const modules = blocks.filter((b: Block) => b.level === 'module' && b.parentId === frame!.id)
    expect(modules).toHaveLength(2)
    const tasks = blocks.filter((b: Block) => b.level === 'task')
    expect(tasks).toHaveLength(3)

    // Codebase references are folded into block descriptions, parseably.
    const login = tasks.find((b: Block) => b.title === 'Login endpoint')
    expect(login).toBeDefined()
    expect(login!.description).toContain('Code references:')
    expect(login!.description).toContain('- src/auth/login.ts')
  })

  it('replaces the blueprint in place on re-scan (same id, refreshed tree)', async () => {
    const scanner = new FakeRepoScanner()
    const app = makeApp(undefined, { repoScanner: scanner })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/board-scan`

    const first = await app.call<ScanRepoResult>('POST', `${base}/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
    })

    // A later scan returns a different tree; it must replace the prior blueprint.
    scanner.result = {
      source: 'heuristic',
      service: { type: 'api', name: 'orders', summary: '', references: [], modules: [] },
    }
    const second = await app.call<ScanRepoResult>('POST', `${base}/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
    })

    expect(second.body.blueprint.id).toBe(first.body.blueprint.id)
    expect(second.body.blueprint.source).toBe('heuristic')
    expect(second.body.blueprint.service.modules).toHaveLength(0)
    expect(second.body.blueprint.createdAt).toBe(first.body.blueprint.createdAt)

    const list = await app.call<RepoBlueprint[]>('GET', `${base}/blueprints`)
    expect(list.body).toHaveLength(1)
  })

  it('deletes a blueprint', async () => {
    const app = makeApp(undefined, { repoScanner: new FakeRepoScanner() })
    const workspaceId = await newWorkspace(app)
    const base = `/workspaces/${workspaceId}/board-scan`

    const scan = await app.call<ScanRepoResult>('POST', `${base}/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
    })
    const del = await app.call('DELETE', `${base}/blueprints/${scan.body.blueprint.id}`)
    expect(del.status).toBe(204)

    const after = await app.call<RepoBlueprint[]>('GET', `${base}/blueprints`)
    expect(after.body).toHaveLength(0)
    const missing = await app.call('GET', `${base}/blueprints/${scan.body.blueprint.id}`)
    expect(missing.status).toBe(404)
  })

  it('surfaces a 500 when the scanner fails', async () => {
    const scanner = new FakeRepoScanner()
    scanner.failWith = 'clone failed'
    const app = makeApp(undefined, { repoScanner: scanner })
    const workspaceId = await newWorkspace(app)
    const res = await app.call('POST', `/workspaces/${workspaceId}/board-scan/scans`, {
      repoOwner: 'acme',
      repoName: 'orders',
    })
    expect(res.status).toBe(500)
  })

  it('rejects an invalid repo slug', async () => {
    const app = makeApp(undefined, { repoScanner: new FakeRepoScanner() })
    const workspaceId = await newWorkspace(app)
    const res = await app.call('POST', `/workspaces/${workspaceId}/board-scan/scans`, {
      repoOwner: 'acme/bad',
      repoName: 'orders',
    })
    expect(res.status).toBe(400)
  })
})
