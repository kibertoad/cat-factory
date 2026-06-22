import { type Pipeline, seedPipelines } from '@cat-factory/kernel'
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
    // The endpoint returns exactly the built-in catalog the kernel seeds — assert
    // against that source of truth rather than a hardcoded list, so adding or
    // removing a built-in pipeline doesn't churn this test.
    expect(res.body).toEqual(seedPipelines())
  })

  it('seeds well-formed, usable pipelines', async () => {
    const res = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(res.body.length).toBeGreaterThan(0)
    // Every seeded pipeline must be runnable: a stable id, a name, and at least one
    // agent step. A gates array (when present) must line up with the steps.
    const ids = new Set<string>()
    for (const p of res.body) {
      expect(p.id).toBeTruthy()
      expect(ids.has(p.id)).toBe(false) // ids are unique across the catalog
      ids.add(p.id)
      expect(p.name.trim()).not.toBe('')
      expect(p.agentKinds.length).toBeGreaterThan(0)
      expect(p.agentKinds.every((k) => k.length > 0)).toBe(true)
      if (p.gates) expect(p.gates.length).toBeLessThanOrEqual(p.agentKinds.length)
    }
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

  it('flags built-in pipelines as builtin and custom ones as not', async () => {
    const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(list.body.find((p) => p.id === 'pl_quick')?.builtin).toBe(true)

    const custom = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
      name: 'Docs only',
      agentKinds: ['documenter'],
    })
    expect(custom.body.builtin ?? false).toBe(false)
  })

  it('clones a pipeline into an editable, non-builtin copy', async () => {
    const res = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines/pl_quick/clone`, {
      name: 'My quick',
    })
    expect(res.status).toBe(201)
    expect(res.body.id).not.toBe('pl_quick')
    expect(res.body.name).toBe('My quick')
    expect(res.body.builtin ?? false).toBe(false)
    // The copy carries the source's steps verbatim.
    const source = (await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)).body.find(
      (p) => p.id === 'pl_quick',
    )!
    expect(res.body.agentKinds).toEqual(source.agentKinds)
    // And it now lives in the catalog alongside the original.
    const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(list.body.map((p) => p.id)).toContain(res.body.id)
  })

  it('defaults a clone name to "<source> (copy)"', async () => {
    const res = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines/pl_spec/clone`, {})
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Write spec (copy)')
  })

  it('refuses to edit a built-in pipeline (must clone first)', async () => {
    const res = await app.call('PATCH', `/workspaces/${wsId}/pipelines/pl_quick`, {
      name: 'Renamed default',
    })
    expect(res.status).toBe(422)
    // The built-in is untouched.
    const list = await app.call<Pipeline[]>('GET', `/workspaces/${wsId}/pipelines`)
    expect(list.body.find((p) => p.id === 'pl_quick')?.name).toBe('Quick implement')
  })

  it('edits a cloned pipeline in place, including disabling a step', async () => {
    const clone = await app.call<Pipeline>(
      'POST',
      `/workspaces/${wsId}/pipelines/pl_quick/clone`,
      {},
    )
    const id = clone.body.id
    const steps = clone.body.agentKinds
    // Disable the last step and rename; the id (and catalog position) is preserved.
    const enabled = steps.map((_, i) => i !== steps.length - 1)
    const res = await app.call<Pipeline>('PATCH', `/workspaces/${wsId}/pipelines/${id}`, {
      name: 'Quick minus tail',
      enabled,
    })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(id)
    expect(res.body.name).toBe('Quick minus tail')
    expect(res.body.enabled).toEqual(enabled)
    expect(res.body.builtin ?? false).toBe(false)
  })

  it('rejects an edit that disables every step', async () => {
    const clone = await app.call<Pipeline>(
      'POST',
      `/workspaces/${wsId}/pipelines/pl_spec/clone`,
      {},
    )
    const res = await app.call('PATCH', `/workspaces/${wsId}/pipelines/${clone.body.id}`, {
      enabled: clone.body.agentKinds.map(() => false),
    })
    expect(res.status).toBe(422)
  })
})
