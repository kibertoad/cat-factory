import type { Workspace, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'

describe('workspaces', () => {
  it('creates a seeded board and returns a full snapshot', async () => {
    const { call } = makeApp()
    const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { name: 'My board' })

    expect(res.status).toBe(201)
    expect(res.body.workspace.name).toBe('My board')
    expect(res.body.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
    expect(res.body.pipelines).toHaveLength(7)
    expect(res.body.executions).toHaveLength(0)
  })

  it('creates a board with no sample blocks when seed=false (pipelines always seeded)', async () => {
    const { call } = makeApp()
    const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

    expect(res.body.blocks).toHaveLength(0)
    // The pipeline catalog is product config, not sample data — always present.
    expect(res.body.pipelines).toHaveLength(7)
  })

  it('lists and deletes boards', async () => {
    const { call, createWorkspace } = makeApp()
    const { workspace } = await createWorkspace()

    const list = await call<Workspace[]>('GET', '/workspaces')
    expect(list.body.map((w) => w.id)).toContain(workspace.id)

    const del = await call('DELETE', `/workspaces/${workspace.id}`)
    expect(del.status).toBe(204)

    const after = await call('GET', `/workspaces/${workspace.id}`)
    expect(after.status).toBe(404)
  })

  it('returns 404 for an unknown board', async () => {
    const { call } = makeApp()
    const res = await call<{ error: { code: string } }>('GET', '/workspaces/missing')

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('isolates blocks between boards', async () => {
    const { createWorkspace } = makeApp()
    const a = await createWorkspace()
    const b = await createWorkspace()

    // Both seeded with the same stable ids, but scoped per workspace.
    expect(a.workspace.id).not.toBe(b.workspace.id)
    expect(a.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
    expect(b.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
  })
})
