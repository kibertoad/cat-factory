import { beforeAll, describe, expect, it } from 'vitest'
import type { Block, Service } from '@cat-factory/kernel'
import type { DrizzleDb } from '../src/db/client.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Parity with the Cloudflare `add-service-from-repo` workspace-delete regression: deleting a
// board must reclaim its account-owned `services` (+ every board's mount of them), so a dangling
// service — looked up by (installation_id, repo_github_id) with no workspace scope — can't keep
// the same repo from being re-added on another board in the account.
describe('DrizzleWorkspaceRepository.delete reclaims the workspace services', () => {
  let db: DrizzleDb

  beforeAll(async () => {
    db = await setupTestDb()
  })

  function frame(id: string): Block {
    return {
      id,
      title: id,
      type: 'service',
      description: '',
      position: { x: 0, y: 0 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
  }

  it('deletes the account-owned service + mount when its home board is deleted', async () => {
    const repos = createDrizzleRepositories(db, { now: () => 0 })
    const wsId = `ws_del_${Math.floor(performance.now())}`
    const frameId = `blk_${wsId}`
    const service: Service = {
      id: `svc_${wsId}`,
      accountId: null,
      frameBlockId: frameId,
      installationId: 4242,
      repoGithubId: 9999,
      directory: null,
      createdAt: 0,
    }

    await repos.workspaceRepository.create(
      { id: wsId, name: 'Doomed', description: null, createdAt: 0, accountId: null },
      null,
      null,
    )
    await repos.blockRepository.insert(wsId, frame(frameId), service.id)
    await repos.serviceRepository.insert(service)
    await repos.workspaceMountRepository.upsert({
      workspaceId: wsId,
      serviceId: service.id,
      position: { x: 0, y: 0 },
      size: null,
      createdAt: 0,
    })

    // Sanity: the repo is linked before the board is deleted.
    expect(await repos.serviceRepository.getByRepo(4242, 9999)).not.toBeNull()

    await repos.workspaceRepository.delete(wsId)

    // The service + its mount are gone, so the repo is re-addable elsewhere in the account.
    expect(await repos.serviceRepository.getByRepo(4242, 9999)).toBeNull()
    expect(await repos.serviceRepository.getByFrameBlock(frameId)).toBeNull()
    expect(await repos.workspaceMountRepository.listByService(service.id)).toEqual([])
  })

  it('re-homes a shared service to a surviving board instead of deleting it', async () => {
    // A service another board still mounts must NOT be destroyed with its home board — the cascade
    // re-homes its blocks (+ run history) to the surviving mounting board. Mirrors the Cloudflare
    // `services` re-home test.
    const repos = createDrizzleRepositories(db, { now: () => 0 })
    const stamp = Math.floor(performance.now())
    const home = `ws_home_${stamp}`
    const other = `ws_other_${stamp}`
    const frameId = `blk_${stamp}`
    const taskId = `task_${stamp}`
    const service: Service = {
      id: `svc_${stamp}`,
      accountId: null,
      frameBlockId: frameId,
      installationId: 7,
      repoGithubId: 77,
      directory: null,
      createdAt: 0,
    }
    const task: Block = {
      ...frame(taskId),
      level: 'task',
      parentId: frameId,
      status: 'in_progress',
    }

    for (const ws of [home, other]) {
      await repos.workspaceRepository.create(
        { id: ws, name: ws, description: null, createdAt: 0, accountId: null },
        null,
        null,
      )
    }
    // Home owns the frame + a task, both stamped with the service id (the shared-subtree linkage).
    await repos.blockRepository.insert(home, frame(frameId), service.id)
    await repos.blockRepository.insert(home, task, service.id)
    await repos.serviceRepository.insert(service)
    await repos.workspaceMountRepository.upsert({
      workspaceId: home,
      serviceId: service.id,
      position: { x: 0, y: 0 },
      size: null,
      createdAt: 0,
    })
    await repos.workspaceMountRepository.upsert({
      workspaceId: other,
      serviceId: service.id,
      position: { x: 0, y: 0 },
      size: null,
      createdAt: 1,
    })

    // Delete home, re-homing the shared service to `other`.
    await repos.workspaceRepository.delete(home, [{ serviceId: service.id, toWorkspaceId: other }])

    // The service survives, its whole subtree moved to `other`, and `other`'s mount is intact.
    expect(await repos.serviceRepository.getByFrameBlock(frameId)).not.toBeNull()
    const moved = await repos.blockRepository.listByWorkspace(other)
    expect(moved.map((b) => b.id).sort()).toEqual([frameId, taskId].sort())
    expect(await repos.blockRepository.listByWorkspace(home)).toEqual([])
    expect(
      (await repos.workspaceMountRepository.listByService(service.id)).map((m) => m.workspaceId),
    ).toEqual([other])
  })
})
