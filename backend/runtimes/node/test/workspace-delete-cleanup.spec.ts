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
      { id: wsId, name: 'Doomed', description: null, createdAt: 0 },
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
})
