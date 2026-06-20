import type { Block, Service, WorkspaceMount } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'

describe('in-org shared services', () => {
  it('registers a service + mount when a frame is created', async () => {
    const { call, createWorkspace } = makeApp()
    const { workspace } = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
      type: 'service',
      position: { x: 10, y: 20 },
    })
    expect(frame.status).toBe(201)

    // The frame is now an account-owned service mounted onto its workspace.
    const mounts = await call<WorkspaceMount[]>('GET', `/workspaces/${workspace.id}/services`)
    expect(mounts.body).toHaveLength(1)
    expect(mounts.body[0]!.position).toEqual({ x: 10, y: 20 })

    const catalog = await call<Service[]>('GET', `/workspaces/${workspace.id}/services/catalog`)
    expect(catalog.body).toHaveLength(1)
    expect(catalog.body[0]!.frameBlockId).toBe(frame.body.id)
    expect(catalog.body[0]!.id).toBe(mounts.body[0]!.serviceId)
  })

  it('mounts a service from one workspace onto another in the same org', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    await call('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 5, y: 5 },
    })
    const catalog = await call<Service[]>('GET', `/workspaces/${a.workspace.id}/services/catalog`)
    const serviceId = catalog.body[0]!.id

    // Workspace B (same null-account org in the auth-disabled test path) sees and mounts it.
    const bCatalog = await call<Service[]>('GET', `/workspaces/${b.workspace.id}/services/catalog`)
    expect(bCatalog.body.map((s) => s.id)).toContain(serviceId)

    const mount = await call<WorkspaceMount>(
      'POST',
      `/workspaces/${b.workspace.id}/services/${serviceId}`,
      { position: { x: 100, y: 100 } },
    )
    expect(mount.status).toBe(201)
    expect(mount.body.position).toEqual({ x: 100, y: 100 })

    // The same service is now mounted on both boards with independent layouts.
    const bMounts = await call<WorkspaceMount[]>('GET', `/workspaces/${b.workspace.id}/services`)
    expect(bMounts.body.map((m) => m.serviceId)).toEqual([serviceId])

    // Re-layout on B's mount; A's mount is untouched.
    const relaid = await call<WorkspaceMount>(
      'PATCH',
      `/workspaces/${b.workspace.id}/services/${serviceId}/layout`,
      { position: { x: 7, y: 8 } },
    )
    expect(relaid.body.position).toEqual({ x: 7, y: 8 })
    const aMounts = await call<WorkspaceMount[]>('GET', `/workspaces/${a.workspace.id}/services`)
    expect(aMounts.body[0]!.position).toEqual({ x: 5, y: 5 })

    // Unmounting from B leaves the service in the org catalog (not deleted).
    const del = await call('DELETE', `/workspaces/${b.workspace.id}/services/${serviceId}`)
    expect(del.status).toBe(204)
    const afterUnmount = await call<WorkspaceMount[]>(
      'GET',
      `/workspaces/${b.workspace.id}/services`,
    )
    expect(afterUnmount.body).toHaveLength(0)
    const stillInCatalog = await call<Service[]>(
      'GET',
      `/workspaces/${b.workspace.id}/services/catalog`,
    )
    expect(stillInCatalog.body.map((s) => s.id)).toContain(serviceId)
  })
})
