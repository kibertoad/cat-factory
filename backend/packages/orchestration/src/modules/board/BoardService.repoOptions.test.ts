import { describe, expect, it } from 'vitest'
import type { GitHubRepo } from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// `listRepoOptions`, the discovery read behind headless service creation (`GET /api/v1/repos`).
//
// It answers two things a caller needs before it can create a service: which repositories this
// workspace has connected, and which of them are already spoken for. The second is what stops a
// provisioning integration re-running its own setup from discovering its previous run through a
// `409`, and it is the part with a rule worth pinning: a WHOLE-REPO repository backs at most one
// service, while a monorepo can back several, one per subdirectory.
describe('BoardService — repository options for service creation', () => {
  const WS = 'ws_1'

  const frame = (id: string, over: Partial<Block> = {}): Block => ({
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
    ...over,
  })

  const repo = (githubId: number, over: Partial<GitHubRepo> = {}): GitHubRepo => ({
    githubId,
    installationId: 1,
    owner: 'acme',
    name: `repo-${githubId}`,
    defaultBranch: 'main',
    private: false,
    syncedAt: 0,
    ...over,
  })

  function build(options: {
    repos?: GitHubRepo[]
    blocks?: Block[]
    services?: { frameBlockId: string; repoGithubId?: number; directory?: string | null }[]
    wired?: boolean
  }) {
    const blocks = options.blocks ?? []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => 'acc_1' },
      blockRepository: {
        get: async (ws: string, id: string) =>
          ws === WS ? (blocks.find((b) => b.id === id) ?? null) : null,
        listByWorkspace: async (ws: string) => (ws === WS ? blocks : []),
      },
      ...(options.wired === false
        ? {}
        : {
            repoProjectionRepository: {
              list: async (ws: string) => (ws === WS ? (options.repos ?? []) : []),
            },
            serviceRepository: {
              listByFrameBlocks: async (ids: string[]) =>
                (options.services ?? []).filter((s) => ids.includes(s.frameBlockId)),
            },
          }),
    } as unknown as BoardServiceDependencies
    return new BoardService(deps)
  }

  it('pairs a whole-repo repository with the service that already backs it', async () => {
    const service = build({
      repos: [repo(1), repo(2)],
      blocks: [frame('f1')],
      services: [{ frameBlockId: 'f1', repoGithubId: 1, directory: null }],
    })
    expect(
      (await service.listRepoOptions(WS)).map((o) => [o.repo.githubId, o.serviceBlockId]),
    ).toEqual([
      [1, 'f1'],
      [2, null],
    ])
  })

  it('leaves a MONOREPO free even when its subdirectories back services', async () => {
    // The choice is not spent: a monorepo backs one service per subdirectory, so reporting the
    // first one would tell a caller it cannot create the second, which is the opposite of the rule.
    const service = build({
      repos: [repo(1, { isMonorepo: true })],
      blocks: [frame('f1')],
      services: [{ frameBlockId: 'f1', repoGithubId: 1, directory: 'packages/api' }],
    })
    expect((await service.listRepoOptions(WS))[0]?.serviceBlockId).toBeNull()
  })

  it('does not name a frame this board cannot see', async () => {
    // A service homed on ANOTHER board (one this workspace merely mounts) is not a frame of this
    // workspace, so naming it would hand a key an id it cannot read back through `/api/v1/services`.
    const service = build({
      repos: [repo(1)],
      blocks: [frame('f1')],
      services: [{ frameBlockId: 'f_elsewhere', repoGithubId: 1, directory: null }],
    })
    expect((await service.listRepoOptions(WS))[0]?.serviceBlockId).toBeNull()
  })

  it('ignores archived and internal frames when resolving what backs a repository', async () => {
    const service = build({
      repos: [repo(1)],
      blocks: [frame('f1', { archived: true }), frame('f2', { internal: true })],
      services: [
        { frameBlockId: 'f1', repoGithubId: 1, directory: null },
        { frameBlockId: 'f2', repoGithubId: 1, directory: null },
      ],
    })
    expect((await service.listRepoOptions(WS))[0]?.serviceBlockId).toBeNull()
  })

  it('answers EMPTY rather than throwing when no VCS integration is wired', async () => {
    // A discovery read: "you have connected no repositories" and "this deployment has no VCS
    // integration" are the same instruction to a caller, and it is the CREATE that distinguishes
    // them by refusing with a reason.
    expect(await build({ wired: false }).listRepoOptions(WS)).toEqual([])
  })

  it('reads nothing beyond the projection when the workspace has no repositories', async () => {
    // The short-circuit: with no rows there is nothing to pair, so the frame read and the service
    // read are not issued at all. Asserted through a deps object that would THROW if they were.
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => 'acc_1' },
      blockRepository: {
        listByWorkspace: () => {
          throw new Error('listByWorkspace must not be called when the workspace projects no repos')
        },
      },
      repoProjectionRepository: { list: async () => [] },
    } as unknown as BoardServiceDependencies
    expect(await new BoardService(deps).listRepoOptions(WS)).toEqual([])
  })
})
