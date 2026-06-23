import type { Block, WorkspaceSnapshot } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

describe('board', () => {
  let app: TestApp
  let wsId: string

  beforeEach(async () => {
    app = makeApp()
    const { workspace } = await app.createWorkspace()
    wsId = workspace.id
  })

  it('adds a top-level frame', async () => {
    const res = await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
      type: 'service',
      position: { x: 10, y: 20 },
    })
    expect(res.status).toBe(201)
    expect(res.body.level).toBe('frame')
    expect(res.body.title).toMatch(/^Service \d+$/)
  })

  it('adds a user-authored task, optionally pinning a pipeline + merge policy', async () => {
    const res = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {
      title: 'Add SSO login',
      description: 'Support SAML and OIDC providers.',
      pipelineId: 'pl_quick',
    })
    expect(res.status).toBe(201)
    expect(res.body.level).toBe('task')
    expect(res.body.parentId).toBe('blk_auth')
    expect(res.body.title).toBe('Add SSO login')
    expect(res.body.description).toBe('Support SAML and OIDC providers.')
    expect(res.body.pipelineId).toBe('pl_quick')
  })

  it('rejects a task without a title (no auto-generated names)', async () => {
    const res = await app.call('POST', `/workspaces/${wsId}/blocks/blk_auth/tasks`, {})
    expect(res.status).toBe(400)
  })

  it('adds a module to a service but rejects one on a task', async () => {
    const ok = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/modules`, {
      name: 'Tokens',
    })
    expect(ok.status).toBe(201)
    expect(ok.body.level).toBe('module')

    const bad = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/modules`, {
      name: 'Nope',
    })
    expect(bad.status).toBe(422)
  })

  it('updates and moves a block', async () => {
    const patched = await app.call<Block>('PATCH', `/workspaces/${wsId}/blocks/blk_auth`, {
      description: 'Updated description',
    })
    expect(patched.body.description).toBe('Updated description')

    const moved = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_api/move`, {
      position: { x: 5, y: 6 },
    })
    expect(moved.body.position).toEqual({ x: 5, y: 6 })
  })

  it('reparents a task into a module and rejects illegal moves', async () => {
    const moduleRes = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/blk_auth/modules`, {
      name: 'Tokens',
    })
    const moduleId = moduleRes.body.id

    const ok = await app.call<Block>('POST', `/workspaces/${wsId}/blocks/task_login/reparent`, {
      parentId: moduleId,
      position: { x: 0, y: 0 },
    })
    expect(ok.body.parentId).toBe(moduleId)

    // A module cannot live inside another module.
    const bad = await app.call('POST', `/workspaces/${wsId}/blocks/${moduleId}/reparent`, {
      parentId: moduleId,
      position: { x: 0, y: 0 },
    })
    expect(bad.status).toBe(422)
  })

  it('toggles a dependency edge', async () => {
    // Seed has task_refresh depending on task_login; toggling removes it.
    const removed = await app.call<Block>(
      'POST',
      `/workspaces/${wsId}/blocks/task_refresh/dependencies`,
      { sourceId: 'task_login' },
    )
    expect(removed.body.dependsOn).not.toContain('task_login')

    const readded = await app.call<Block>(
      'POST',
      `/workspaces/${wsId}/blocks/task_refresh/dependencies`,
      { sourceId: 'task_login' },
    )
    expect(readded.body.dependsOn).toContain('task_login')
  })

  it('rejects a self-dependency', async () => {
    const res = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/dependencies`, {
      sourceId: 'task_login',
    })
    expect(res.status).toBe(422)
  })

  it('removes a block, cascading to descendants and dependants', async () => {
    const del = await app.call('DELETE', `/workspaces/${wsId}/blocks/task_login`)
    expect(del.status).toBe(204)

    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    expect(snap.blocks.find((b) => b.id === 'task_login')).toBeUndefined()
    // task_refresh depended on task_login — the dangling edge is dropped.
    const refresh = snap.blocks.find((b) => b.id === 'task_refresh')
    expect(refresh?.dependsOn).not.toContain('task_login')
  })

  it('deletes idempotently — a gone or unknown block is a 204, not a 404', async () => {
    // First delete tears the subtree down; a second delete (or a delete of a never-existed id)
    // must NOT 404. A thing not existing can't block cleanup of whatever DID survive.
    const first = await app.call('DELETE', `/workspaces/${wsId}/blocks/blk_auth`)
    expect(first.status).toBe(204)

    const again = await app.call('DELETE', `/workspaces/${wsId}/blocks/blk_auth`)
    expect(again.status).toBe(204)

    const unknown = await app.call('DELETE', `/workspaces/${wsId}/blocks/blk_does_not_exist`)
    expect(unknown.status).toBe(204)
  })

  it('removes a module and its nested tasks', async () => {
    await app.call('DELETE', `/workspaces/${wsId}/blocks/mod_sessions`)
    const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
    expect(snap.blocks.find((b) => b.id === 'mod_sessions')).toBeUndefined()
    expect(snap.blocks.find((b) => b.id === 'task_session')).toBeUndefined()
  })

  it('rejects an invalid block type', async () => {
    const res = await app.call('POST', `/workspaces/${wsId}/blocks`, {
      type: 'bogus',
      position: { x: 0, y: 0 },
    })
    expect(res.status).toBe(400)
  })
})
