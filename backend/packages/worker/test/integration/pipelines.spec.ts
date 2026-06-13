import type { Pipeline } from '@cat-factory/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeApp, type TestApp } from '../helpers'

describe('pipelines', () => {
  let app: TestApp
  let wsId: string

  beforeEach(async () => {
    app = makeApp()
    const { workspace } = await app.createWorkspace()
    wsId = workspace.id
  })

  it('lists the seeded pipelines', async () => {
    const res = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(res.body.map((p) => p.id)).toEqual(['pl_full', 'pl_quick', 'pl_integrate'])
  })

  it('creates a custom pipeline', async () => {
    const res = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Docs only',
      agentKinds: ['documenter'],
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Docs only')
    expect(res.body.agentKinds).toEqual(['documenter'])
  })

  it('rejects a pipeline with no agents', async () => {
    const res = await app.call('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Empty',
      agentKinds: [],
    })
    expect(res.status).toBe(400)
  })

  it('deletes a pipeline', async () => {
    const del = await app.call('DELETE', `/workspaces/${wsId}/pipelines/pl_quick`)
    expect(del.status).toBe(204)

    const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(list.body.map((p) => p.id)).not.toContain('pl_quick')
  })

  it('returns 404 when deleting an unknown pipeline', async () => {
    const res = await app.call('DELETE', `/workspaces/${wsId}/pipelines/missing`)
    expect(res.status).toBe(404)
  })
})
