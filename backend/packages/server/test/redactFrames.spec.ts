import type { Block, ExecutionInstance, Service } from '@cat-factory/contracts'
import type { GitHubRepo, UserRepoAccessRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { redactBoard, resolveDeniedFrameIds } from '../src/modules/workspaces/redactFrames.js'

function block(id: string, level: Block['level'], parentId: string | null): Block {
  return {
    id,
    title: `title-${id}`,
    type: 'service',
    description: `desc-${id}`,
    position: { x: 1, y: 2 },
    status: 'ready',
    progress: 0.5,
    dependsOn: [],
    executionId: null,
    level,
    parentId,
  }
}

function service(frameBlockId: string, repoGithubId: number | null): Service {
  return {
    id: `svc-${frameBlockId}`,
    accountId: null,
    frameBlockId,
    installationId: 42,
    repoGithubId,
    directory: null,
    createdAt: 0,
  }
}

function repo(githubId: number, linkedVia: 'app' | 'user_pat'): GitHubRepo {
  return {
    githubId,
    installationId: 42,
    owner: 'acme',
    name: `r${githubId}`,
    defaultBranch: 'main',
    private: true,
    linkedVia,
    syncedAt: 0,
  }
}

/** A fake access repo whose accessible set is fixed per user. */
function accessRepo(byUser: Record<string, number[]>): UserRepoAccessRepository {
  return {
    replaceForUser: async () => {},
    recordAccessible: async () => {},
    listAccessibleRepoIds: async (userId, ids) => {
      const set = new Set(byUser[userId] ?? [])
      return ids.filter((id) => set.has(id))
    },
    listByUser: async () => [],
    removeForUser: async () => {},
  }
}

describe('resolveDeniedFrameIds', () => {
  const services = [service('frameApp', 1), service('framePat', 2), service('frameNoRepo', null)]
  const repos = [repo(1, 'app'), repo(2, 'user_pat')]

  it('denies a personal-repo frame the viewer has no recorded access to', async () => {
    const denied = await resolveDeniedFrameIds({
      viewerUserId: 'usr_b',
      services,
      repos,
      userRepoAccess: accessRepo({ usr_b: [] }),
    })
    expect([...denied]).toEqual(['framePat'])
  })

  it('allows a personal-repo frame the viewer CAN reach', async () => {
    const denied = await resolveDeniedFrameIds({
      viewerUserId: 'usr_a',
      services,
      repos,
      userRepoAccess: accessRepo({ usr_a: [2] }),
    })
    expect(denied.size).toBe(0)
  })

  it('never denies an App-reachable frame', async () => {
    const denied = await resolveDeniedFrameIds({
      viewerUserId: 'usr_b',
      services: [service('frameApp', 1)],
      repos: [repo(1, 'app')],
      userRepoAccess: accessRepo({}),
    })
    expect(denied.size).toBe(0)
  })

  it('fails closed for an anonymous viewer (no user id)', async () => {
    const denied = await resolveDeniedFrameIds({
      viewerUserId: undefined,
      services,
      repos,
      userRepoAccess: accessRepo({}),
    })
    expect([...denied]).toEqual(['framePat'])
  })

  it('is a no-op when the access repo is not wired', async () => {
    const denied = await resolveDeniedFrameIds({
      viewerUserId: 'usr_b',
      services,
      repos,
      userRepoAccess: undefined,
    })
    expect(denied.size).toBe(0)
  })
})

describe('redactBoard', () => {
  // A board: an App frame with a task, a personal frame with a module + task, and executions.
  const blocks = [
    block('frameApp', 'frame', null),
    block('taskApp', 'task', 'frameApp'),
    block('framePat', 'frame', null),
    block('modPat', 'module', 'framePat'),
    block('taskPat', 'task', 'modPat'),
  ]
  const executions: ExecutionInstance[] = [
    { id: 'e1', blockId: 'taskApp' } as ExecutionInstance,
    { id: 'e2', blockId: 'taskPat' } as ExecutionInstance,
  ]

  it('scrubs the denied frame, drops its subtree + executions, and blanks its service repo', () => {
    const out = redactBoard(
      {
        blocks,
        executions,
        services: [service('frameApp', 1), service('framePat', 2)],
        bootstrapJobs: [{ blockId: 'framePat' }, { blockId: 'frameApp' }],
        notifications: [{ blockId: 'taskPat' }, { blockId: 'taskApp' }],
      },
      new Set(['framePat']),
    )

    // The App frame + its task survive untouched.
    expect(out.blocks.map((b) => b.id).sort()).toEqual(['frameApp', 'framePat', 'taskApp'])
    const app = out.blocks.find((b) => b.id === 'frameApp')!
    expect(app.title).toBe('title-frameApp')

    // The personal frame is scrubbed to a locked stub; its module + task are gone.
    const pat = out.blocks.find((b) => b.id === 'framePat')!
    expect(pat.accessDenied).toBe(true)
    expect(pat.title).toBe('')
    expect(pat.description).toBe('')
    expect(pat.level).toBe('frame')
    expect(pat.position).toEqual({ x: 1, y: 2 })

    // The redacted subtree's executions / bootstrap jobs / notifications are dropped.
    expect(out.executions.map((e) => e.id)).toEqual(['e1'])
    expect(out.bootstrapJobs).toEqual([{ blockId: 'frameApp' }])
    expect(out.notifications).toEqual([{ blockId: 'taskApp' }])

    // The denied frame's service loses its repo linkage (so the repo id isn't leaked).
    const patSvc = out.services!.find((s) => s.frameBlockId === 'framePat')!
    expect(patSvc.repoGithubId).toBeNull()
    expect(patSvc.installationId).toBeNull()
    const appSvc = out.services!.find((s) => s.frameBlockId === 'frameApp')!
    expect(appSvc.repoGithubId).toBe(1)
  })

  it('is a no-op (same reference) when nothing is denied', () => {
    const board = { blocks, executions }
    expect(redactBoard(board, new Set())).toBe(board)
  })
})
