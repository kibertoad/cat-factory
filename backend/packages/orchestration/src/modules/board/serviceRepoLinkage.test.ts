import { describe, expect, it } from 'vitest'
import type { GitHubRepo, Service } from '@cat-factory/kernel'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'
import { resolveServiceRepoLinkage } from './serviceRepoLinkage.js'

// The rule deciding how a new service frame is pinned to its repository, and the ordering that
// keeps a REFUSED create from having already changed the repository.
describe('resolveServiceRepoLinkage', () => {
  it('reads an omitted flag as "leave the repository as it is", not as "not a monorepo"', () => {
    // The ordinary monorepo add: somebody already marked the repository, so a later caller names
    // only the subdirectory. Reading the omission as `false` would refuse it.
    expect(resolveServiceRepoLinkage({ directory: 'packages/api' }, true)).toEqual({
      isMonorepo: true,
      directory: 'packages/api',
      flagChanged: false,
    })
  })

  it('refuses a directory on a whole-repo repository even when the flag is OMITTED', () => {
    // The silent case: `resolveRepoTarget` reads a service's directory only while the repo is a
    // monorepo, so this combination stores a pin that dispatch ignores — the agents run at the
    // repository root while the caller and the created service both say otherwise.
    expect(() => resolveServiceRepoLinkage({ directory: 'packages/api' }, false)).toThrow(
      /whole-repo service cannot name a directory/,
    )
    expect(() =>
      resolveServiceRepoLinkage({ directory: 'packages/api', isMonorepo: false }, true),
    ).toThrow(/whole-repo service cannot name a directory/)
  })

  it('refuses a monorepo service with no directory to scope agents to', () => {
    expect(() => resolveServiceRepoLinkage({ isMonorepo: true }, false)).toThrow(
      /Select a service directory/,
    )
    // A directory that normalises to nothing is the same fact as an absent one.
    expect(() => resolveServiceRepoLinkage({ isMonorepo: true, directory: './' }, false)).toThrow(
      /Select a service directory/,
    )
  })

  it('reports the flag write only when the request actually moves it', () => {
    expect(resolveServiceRepoLinkage({ isMonorepo: true, directory: 'a' }, false).flagChanged).toBe(
      true,
    )
    expect(resolveServiceRepoLinkage({ isMonorepo: true, directory: 'a' }, true).flagChanged).toBe(
      false,
    )
  })
})

describe('BoardService.addServiceFromRepo — the monorepo flag is written only on success', () => {
  const WS = 'ws_1'

  function build(stored: Partial<GitHubRepo> = {}) {
    const setMonorepo: boolean[] = []
    const invalidated: string[] = []
    const deps = {
      workspaceRepository: { get: async (id: string) => ({ id }), accountOf: async () => 'acc_1' },
      repoProjectionRepository: {
        get: async (): Promise<GitHubRepo> =>
          ({
            githubId: 7,
            installationId: 1,
            owner: 'acme',
            name: 'web',
            defaultBranch: 'main',
            private: false,
            syncedAt: 0,
            ...stored,
          }) as GitHubRepo,
        setMonorepo: async (_ws: string, _id: number, value: boolean) => {
          setMonorepo.push(value)
        },
      },
      repoProjectionCache: {
        invalidateGroup: async (ws: string) => {
          invalidated.push(ws)
        },
      },
      serviceRepository: {
        listByAccount: async (): Promise<Service[]> => [],
        listByFrameBlocks: async (): Promise<Service[]> => [],
      },
      blockRepository: {
        listByWorkspace: async () => [],
        insert: async () => {},
      },
      idGenerator: { next: (p: string) => `${p}_new` },
      clock: { now: () => 0 },
    } as unknown as BoardServiceDependencies
    return { service: new BoardService(deps), setMonorepo, invalidated }
  }

  it('leaves the repository untouched when the create is refused', async () => {
    // The flag is REPOSITORY-wide: flipping it on the way to a 422 moves the working directory of
    // every service already backed by this repository, because `resolveRepoTarget` hands agents a
    // service's subdirectory only while the flag is on. A refused request must change nothing.
    const { service, setMonorepo, invalidated } = build()
    await expect(
      service.addServiceFromRepo(WS, { repoGithubId: 7, isMonorepo: true }),
    ).rejects.toThrow(/Select a service directory/)
    expect(setMonorepo).toEqual([])
    expect(invalidated).toEqual([])
  })

  it('writes the flag (and drops the cached projection) once the create goes through', async () => {
    const { service, setMonorepo, invalidated } = build()
    await service.addServiceFromRepo(WS, {
      repoGithubId: 7,
      isMonorepo: true,
      directory: 'packages/api',
    })
    expect(setMonorepo).toEqual([true])
    expect(invalidated).toEqual([WS])
  })
})
