import { describe, expect, it } from 'vitest'
import type { Block, GitHubRepo, Service, WorkspaceMount } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Importing a repo that already backs an account-owned service MOUNTS the shared service onto the
// board (so two teams in one org share it) rather than minting a rival — the account-scoped dedup.
describe('BoardService.addServiceFromRepo — shared-service mount', () => {
  const WS = 'ws_b'
  const HOME_WS = 'ws_a'
  const ACC = 'acc_1'

  function repo(over: Partial<GitHubRepo> = {}): GitHubRepo {
    return {
      githubId: 101,
      installationId: 500,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      private: true,
      syncedAt: 0,
      ...over,
    } as GitHubRepo
  }

  function homeFrame(): Block {
    return {
      id: 'frame_shared',
      title: 'web',
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

  function existingService(): Service {
    return {
      id: 'svc_shared',
      accountId: ACC,
      frameBlockId: 'frame_shared',
      installationId: 999, // a DIFFERENT installation than the importing board — account dedup
      repoGithubId: 101,
      directory: null,
      createdAt: 0,
    }
  }

  function build(existing: Service | null, alreadyMountedHere = false, homeWorkspaceId = HOME_WS) {
    const upserts: WorkspaceMount[] = []
    const deps = {
      workspaceRepository: {
        get: async (id: string) => ({ id }),
        accountOf: async () => ACC,
      },
      repoProjectionRepository: {
        get: async () => repo(),
      },
      serviceRepository: {
        listByAccount: async (acc: string | null) => (acc === ACC && existing ? [existing] : []),
      },
      blockRepository: {
        findById: async (id: string) =>
          existing && id === existing.frameBlockId
            ? { workspaceId: homeWorkspaceId, serviceId: existing.id, block: homeFrame() }
            : null,
        listByWorkspace: async () => [],
      },
      workspaceMountRepository: {
        get: async () =>
          alreadyMountedHere
            ? {
                workspaceId: WS,
                serviceId: 'svc_shared',
                position: { x: 0, y: 0 },
                size: null,
                createdAt: 0,
              }
            : null,
        listByWorkspace: async () => [],
        upsert: async (m: WorkspaceMount) => {
          upserts.push(m)
        },
      },
      idGenerator: { next: (p: string) => `${p}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies

    return { service: new BoardService(deps), upserts }
  }

  it('mounts the existing account service and returns its frame block', async () => {
    const { service, upserts } = build(existingService())
    const block = await service.addServiceFromRepo(WS, { repoGithubId: 101 })
    expect(block.id).toBe('frame_shared')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ workspaceId: WS, serviceId: 'svc_shared' })
  })

  it('is idempotent when the service is already mounted here (no second mount)', async () => {
    const { service, upserts } = build(existingService(), true)
    const block = await service.addServiceFromRepo(WS, { repoGithubId: 101 })
    expect(block.id).toBe('frame_shared')
    expect(upserts).toHaveLength(0)
  })

  it('REFUSES a foreign-homed service for a caller that cannot address it, and mounts nothing', async () => {
    // The public API's policy. Its every read is workspace-scoped, so answering 201 with the frame
    // homed on `ws_a` would hand a key a `serviceId` that `GET /api/v1/services` does not list and
    // `POST /api/v1/services/{id}/tasks` 404s on — a success that reads as one and is not.
    const { service, upserts } = build(existingService())
    await expect(
      service.addServiceFromRepo(WS, { repoGithubId: 101 }, 'refuse'),
    ).rejects.toMatchObject({ details: { reason: 'repo_service_homed_elsewhere' } })
    // Refused BEFORE the write: the board does not quietly acquire a service the caller asked to
    // CREATE and cannot then see.
    expect(upserts).toHaveLength(0)
  })

  it('still answers under `refuse` when the service is homed on THIS board', async () => {
    // `refuse` is about ADDRESSABILITY, not about sharing: a service whose frame is homed here is
    // one the caller can read back, so the ordinary idempotent answer stands. Without this the
    // policy would refuse a provisioning integration its OWN previous run's service.
    const { service } = build(existingService(), true, WS)
    const block = await service.addServiceFromRepo(WS, { repoGithubId: 101 }, 'refuse')
    expect(block.id).toBe('frame_shared')
  })
})
