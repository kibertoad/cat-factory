import type { Block, Service, WorkspaceMount, WorkspaceSnapshot } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { makeApp } from '../helpers'

/** Find the service in a workspace's org catalog that owns the given frame block. */
async function serviceFor(
  call: ReturnType<typeof makeApp>['call'],
  workspaceId: string,
  frameBlockId: string,
): Promise<Service> {
  const catalog = await call<Service[]>('GET', `/workspaces/${workspaceId}/services/catalog`)
  const svc = catalog.body.find((s) => s.frameBlockId === frameBlockId)
  if (!svc) throw new Error(`no service for frame ${frameBlockId}`)
  return svc
}

describe('in-org shared services', () => {
  it('registers a service + mount when a frame is created', async () => {
    const { call, createWorkspace } = makeApp()
    const { workspace } = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
      type: 'service',
      position: { x: 10, y: 20 },
    })
    expect(frame.status).toBe(201)

    const svc = await serviceFor(call, workspace.id, frame.body.id)
    const mounts = await call<WorkspaceMount[]>('GET', `/workspaces/${workspace.id}/services`)
    const mine = mounts.body.find((m) => m.serviceId === svc.id)
    expect(mine).toBeTruthy()
    expect(mine!.position).toEqual({ x: 10, y: 20 })
  })

  it('mounts a service from one workspace onto another in the same org', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 5, y: 5 },
    })
    const service = await serviceFor(call, a.workspace.id, frame.body.id)

    // Workspace B (same null-account org in the auth-disabled test path) sees and mounts it.
    const bCatalog = await call<Service[]>('GET', `/workspaces/${b.workspace.id}/services/catalog`)
    expect(bCatalog.body.map((s) => s.id)).toContain(service.id)

    const mount = await call<WorkspaceMount>(
      'POST',
      `/workspaces/${b.workspace.id}/services/${service.id}`,
      { position: { x: 100, y: 100 } },
    )
    expect(mount.status).toBe(201)
    expect(mount.body.position).toEqual({ x: 100, y: 100 })

    const bMounts = await call<WorkspaceMount[]>('GET', `/workspaces/${b.workspace.id}/services`)
    expect(bMounts.body.map((m) => m.serviceId)).toContain(service.id)

    // Re-layout on B's mount; A's mount is untouched.
    await call('PATCH', `/workspaces/${b.workspace.id}/services/${service.id}/layout`, {
      position: { x: 7, y: 8 },
    })
    const aMounts = await call<WorkspaceMount[]>('GET', `/workspaces/${a.workspace.id}/services`)
    expect(aMounts.body.find((m) => m.serviceId === service.id)!.position).toEqual({ x: 5, y: 5 })

    // Unmounting from B leaves the service in the org catalog (not deleted).
    const del = await call('DELETE', `/workspaces/${b.workspace.id}/services/${service.id}`)
    expect(del.status).toBe(204)
    const afterUnmount = await call<WorkspaceMount[]>(
      'GET',
      `/workspaces/${b.workspace.id}/services`,
    )
    expect(afterUnmount.body.map((m) => m.serviceId)).not.toContain(service.id)
    const stillInCatalog = await call<Service[]>(
      'GET',
      `/workspaces/${b.workspace.id}/services/catalog`,
    )
    expect(stillInCatalog.body.map((s) => s.id)).toContain(service.id)
  })

  it("renders a mounted service's shared subtree + state on the other board", async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await call<Block>(
      'POST',
      `/workspaces/${a.workspace.id}/blocks/${frame.body.id}/tasks`,
      {
        title: 'Shared task',
      },
    )
    const service = await serviceFor(call, a.workspace.id, frame.body.id)

    // B mounts it at its own position; B's board now renders A's frame + task.
    await call('POST', `/workspaces/${b.workspace.id}/services/${service.id}`, {
      position: { x: 200, y: 50 },
    })
    let bSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${b.workspace.id}`)
    const bFrame = bSnap.body.blocks.find((x) => x.id === frame.body.id)
    expect(bFrame).toBeTruthy()
    // Frame uses B's per-workspace layout override, not A's.
    expect(bFrame!.position).toEqual({ x: 200, y: 50 })
    expect(bSnap.body.blocks.find((x) => x.id === task.body.id)?.title).toBe('Shared task')

    // An edit made on A's board is the SAME single physical copy B reads — no per-workspace
    // duplicate, so the shared task list/state stays identical everywhere.
    await call('PATCH', `/workspaces/${a.workspace.id}/blocks/${task.body.id}`, {
      title: 'Renamed on A',
    })
    bSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${b.workspace.id}`)
    expect(bSnap.body.blocks.find((x) => x.id === task.body.id)?.title).toBe('Renamed on A')
  })
})
