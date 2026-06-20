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

  it("surfaces a shared service's recurring schedule on the workspace that mounts it", async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const recurrence = {
      intervalHours: 24,
      weekdays: [] as number[],
      windowStartHour: null,
      windowEndHour: null,
      timezone: 'UTC',
    }
    const schedule = await call<{ id: string; serviceId: string | null }>(
      'POST',
      `/workspaces/${a.workspace.id}/recurring-pipelines`,
      { frameId: frame.body.id, pipelineId: 'pl_dep_update', name: 'Weekly deps', recurrence },
    )
    expect(schedule.status).toBe(201)
    expect(schedule.body.serviceId).toBeTruthy()

    const service = await serviceFor(call, a.workspace.id, frame.body.id)
    await call('POST', `/workspaces/${b.workspace.id}/services/${service.id}`, {})

    // B mounts the service → B's board lists the shared service's recurring schedule.
    const bList = await call<{ id: string }[]>(
      'GET',
      `/workspaces/${b.workspace.id}/recurring-pipelines`,
    )
    expect(bList.body.map((s) => s.id)).toContain(schedule.body.id)
  })

  it('persists a home service frame move (frame layout lives on the mount)', async () => {
    const { call, createWorkspace } = makeApp()
    const { workspace } = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
      type: 'service',
      position: { x: 10, y: 20 },
    })
    // Move the (locally homed) frame, then re-read the board: the new position must stick.
    await call('POST', `/workspaces/${workspace.id}/blocks/${frame.body.id}/move`, {
      position: { x: 99, y: 88 },
    })
    const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${workspace.id}`)
    expect(snap.body.blocks.find((x) => x.id === frame.body.id)?.position).toEqual({ x: 99, y: 88 })
    const mounts = await call<WorkspaceMount[]>('GET', `/workspaces/${workspace.id}/services`)
    const svc = await serviceFor(call, workspace.id, frame.body.id)
    expect(mounts.body.find((m) => m.serviceId === svc.id)?.position).toEqual({ x: 99, y: 88 })
  })

  it('re-homes a task to the destination service when reparented across frames', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frameX = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const frameY = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 300, y: 0 },
    })
    const task = await call<Block>(
      'POST',
      `/workspaces/${a.workspace.id}/blocks/${frameX.body.id}/tasks`,
      { title: 'Movable task' },
    )

    // Move the task from service X's frame into service Y's frame.
    await call('POST', `/workspaces/${a.workspace.id}/blocks/${task.body.id}/reparent`, {
      parentId: frameY.body.id,
      position: { x: 1, y: 1 },
    })

    // Mount ONLY service Y onto B: the reparented task must now render there (it followed Y).
    const serviceY = await serviceFor(call, a.workspace.id, frameY.body.id)
    await call('POST', `/workspaces/${b.workspace.id}/services/${serviceY.id}`, {})
    const bSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${b.workspace.id}`)
    expect(bSnap.body.blocks.map((x) => x.id)).toContain(task.body.id)
  })

  it('drops the service + mounts from the org when its frame is deleted', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const service = await serviceFor(call, a.workspace.id, frame.body.id)
    await call('POST', `/workspaces/${b.workspace.id}/services/${service.id}`, {})

    // Deleting the frame removes the canonical service, so it leaves the org catalog and B's
    // mount (no orphan service rendering an empty frame on B's board).
    await call('DELETE', `/workspaces/${a.workspace.id}/blocks/${frame.body.id}`)
    const catalog = await call<Service[]>('GET', `/workspaces/${a.workspace.id}/services/catalog`)
    expect(catalog.body.map((s) => s.id)).not.toContain(service.id)
    const bMounts = await call<WorkspaceMount[]>('GET', `/workspaces/${b.workspace.id}/services`)
    expect(bMounts.body.map((m) => m.serviceId)).not.toContain(service.id)
  })

  // --- a mounting board is fully interactive on the shared service -----------

  it('edits, adds, moves and deletes a shared service from the mounting board', async () => {
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
      { title: 'Original' },
    )
    const service = await serviceFor(call, a.workspace.id, frame.body.id)
    await call('POST', `/workspaces/${b.workspace.id}/services/${service.id}`, {})

    // B edits the shared task — no 404, and the one shared copy changes for A too.
    const edited = await call('PATCH', `/workspaces/${b.workspace.id}/blocks/${task.body.id}`, {
      title: 'Edited on B',
    })
    expect(edited.status).toBe(200)
    const aSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    expect(aSnap.body.blocks.find((x) => x.id === task.body.id)?.title).toBe('Edited on B')

    // B adds a task to the shared frame; it renders on A (the home) too.
    const added = await call<Block>(
      'POST',
      `/workspaces/${b.workspace.id}/blocks/${frame.body.id}/tasks`,
      { title: 'Added on B' },
    )
    expect(added.status).toBe(201)
    let aSnap2 = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    expect(aSnap2.body.blocks.map((x) => x.id)).toContain(added.body.id)

    // B moves the shared task; the move lands on the shared copy.
    await call('POST', `/workspaces/${b.workspace.id}/blocks/${task.body.id}/move`, {
      position: { x: 42, y: 24 },
    })
    aSnap2 = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    expect(aSnap2.body.blocks.find((x) => x.id === task.body.id)?.position).toEqual({
      x: 42,
      y: 24,
    })

    // B deletes the task it added; it disappears from A's board as well.
    const del = await call('DELETE', `/workspaces/${b.workspace.id}/blocks/${added.body.id}`)
    expect(del.status).toBe(204)
    const aSnap3 = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    expect(aSnap3.body.blocks.map((x) => x.id)).not.toContain(added.body.id)
  })

  it('moving a shared frame on one board does not move it on another', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frame = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 10, y: 10 },
    })
    const service = await serviceFor(call, a.workspace.id, frame.body.id)
    await call('POST', `/workspaces/${b.workspace.id}/services/${service.id}`, {
      position: { x: 500, y: 500 },
    })

    // B drags the shared frame — that is B's per-board layout override, not A's.
    await call('POST', `/workspaces/${b.workspace.id}/blocks/${frame.body.id}/move`, {
      position: { x: 600, y: 600 },
    })
    const aSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    const bSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${b.workspace.id}`)
    expect(aSnap.body.blocks.find((x) => x.id === frame.body.id)?.position).toEqual({
      x: 10,
      y: 10,
    })
    expect(bSnap.body.blocks.find((x) => x.id === frame.body.id)?.position).toEqual({
      x: 600,
      y: 600,
    })
  })

  it('reparents a task across services homed in different workspaces (from a third board)', async () => {
    const { call, createWorkspace } = makeApp()
    const a = await createWorkspace({ seed: false })
    const c = await createWorkspace({ seed: false })
    const b = await createWorkspace({ seed: false })

    const frameX = await call<Block>('POST', `/workspaces/${a.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const frameY = await call<Block>('POST', `/workspaces/${c.workspace.id}/blocks`, {
      type: 'service',
      position: { x: 0, y: 0 },
    })
    const task = await call<Block>(
      'POST',
      `/workspaces/${a.workspace.id}/blocks/${frameX.body.id}/tasks`,
      { title: 'Crosser' },
    )
    const serviceX = await serviceFor(call, a.workspace.id, frameX.body.id)
    const serviceY = await serviceFor(call, c.workspace.id, frameY.body.id)

    // Board B mounts BOTH foreign services, then drags the task from X (home A) into Y (home C).
    await call('POST', `/workspaces/${b.workspace.id}/services/${serviceX.id}`, {})
    await call('POST', `/workspaces/${b.workspace.id}/services/${serviceY.id}`, {})
    const reparented = await call(
      'POST',
      `/workspaces/${b.workspace.id}/blocks/${task.body.id}/reparent`,
      {
        parentId: frameY.body.id,
        position: { x: 1, y: 1 },
      },
    )
    expect(reparented.status).toBe(200)

    // It now belongs to Y: renders on Y's home board (C) and gone from X's home board (A).
    const cSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${c.workspace.id}`)
    expect(cSnap.body.blocks.find((x) => x.id === task.body.id)?.parentId).toBe(frameY.body.id)
    const aSnap = await call<WorkspaceSnapshot>('GET', `/workspaces/${a.workspace.id}`)
    expect(aSnap.body.blocks.map((x) => x.id)).not.toContain(task.body.id)
  })

  it('registers seeded demo frames as shareable services', async () => {
    const { call, createWorkspace } = makeApp()
    const seeded = await createWorkspace({ seed: true })
    const other = await createWorkspace({ seed: false })

    // Each seeded top-level frame is an account-owned service in the org catalog.
    const snap = await call<WorkspaceSnapshot>('GET', `/workspaces/${seeded.workspace.id}`)
    const seededFrames = snap.body.blocks.filter((b) => b.level === 'frame' && b.parentId === null)
    expect(seededFrames.length).toBeGreaterThan(0)
    const catalog = await call<Service[]>(
      'GET',
      `/workspaces/${other.workspace.id}/services/catalog`,
    )
    for (const frame of seededFrames) {
      expect(catalog.body.map((s) => s.frameBlockId)).toContain(frame.id)
    }
  })
})
