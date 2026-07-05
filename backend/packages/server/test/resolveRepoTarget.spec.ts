import type {
  Block,
  GitHubInstallation,
  GitHubRepo,
  GroupCacheHandle,
  Service,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { buildResolveRepoTarget, buildResolveRepoTargets } from '../src/agents/resolveRepoTarget.js'

// Minimal fakes for the narrow ports `buildResolveRepoTarget` reads. Each test
// wires a tiny in-memory world (one installation, some repos, a block tree, and —
// where relevant — services) and asserts which repo (and service directory) a run
// at a leaf block resolves to.

const installation: GitHubInstallation = {
  installationId: 42,
  workspaceId: 'ws',
  accountId: null,
  accountLogin: 'acme',
  targetType: 'Organization',
  appId: null,
  cachedToken: null,
  tokenExpiresAt: null,
  createdAt: 0,
  deletedAt: null,
}

function repo(
  partial: Partial<GitHubRepo> & Pick<GitHubRepo, 'githubId' | 'owner' | 'name'>,
): GitHubRepo {
  return {
    installationId: 42,
    defaultBranch: 'main',
    private: false,
    syncedAt: 0,
    ...partial,
  }
}

function block(id: string, parentId: string | null, level: Block['level']): Block {
  return {
    id,
    title: id,
    type: 'service',
    description: '',
    position: { x: 0, y: 0 },
    status: 'planned',
    progress: 0,
    dependsOn: [],
    executionId: null,
    level,
    parentId,
  }
}

function harness(opts: {
  repos: GitHubRepo[]
  blocks: Block[]
  services?: Service[]
  installation?: GitHubInstallation | null
}) {
  const blocksById = new Map(opts.blocks.map((b) => [b.id, b]))
  const servicesByFrame = new Map((opts.services ?? []).map((s) => [s.frameBlockId, s]))
  return buildResolveRepoTarget({
    installationRepository: {
      getByWorkspace: async () =>
        opts.installation === undefined ? installation : opts.installation,
    },
    repoProjectionRepository: { list: async () => opts.repos },
    blockRepository: { get: async (_ws, id) => blocksById.get(id) ?? null },
    serviceRepository: { getByFrameBlock: async (id) => servicesByFrame.get(id) ?? null },
  })
}

function service(frameBlockId: string, repoGithubId: number, directory: string | null): Service {
  return {
    id: `svc-${frameBlockId}`,
    accountId: null,
    frameBlockId,
    installationId: 42,
    repoGithubId,
    directory,
    createdAt: 0,
  }
}

describe('buildResolveRepoTarget — monorepo service directories', () => {
  it('returns the service subdirectory when the repo is a monorepo', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', isMonorepo: true })],
      blocks: [block('frame', null, 'frame'), block('task', 'frame', 'task')],
      services: [service('frame', 1, 'packages/api')],
    })
    const target = await resolve('ws', 'task')
    expect(target).toMatchObject({
      installationId: 42,
      owner: 'acme',
      name: 'platform',
      baseBranch: 'main',
      serviceDirectory: 'packages/api',
    })
  })

  it('resolves DIFFERENT directories for two services backed by the same monorepo', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', isMonorepo: true })],
      blocks: [
        block('frameA', null, 'frame'),
        block('taskA', 'frameA', 'task'),
        block('frameB', null, 'frame'),
        block('taskB', 'frameB', 'task'),
      ],
      services: [service('frameA', 1, 'packages/api'), service('frameB', 1, 'packages/web')],
    })
    expect((await resolve('ws', 'taskA'))?.serviceDirectory).toBe('packages/api')
    expect((await resolve('ws', 'taskB'))?.serviceDirectory).toBe('packages/web')
  })

  it('omits the directory when the repo is NOT flagged a monorepo', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', isMonorepo: false })],
      blocks: [block('frame', null, 'frame'), block('task', 'frame', 'task')],
      services: [service('frame', 1, 'packages/api')],
    })
    const target = await resolve('ws', 'task')
    expect(target?.serviceDirectory).toBeUndefined()
    expect(target).toMatchObject({ owner: 'acme', name: 'platform' })
  })

  it('resolves a whole-repo service (no directory) via its Service link', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', isMonorepo: false })],
      blocks: [block('frame', null, 'frame'), block('task', 'frame', 'task')],
      services: [service('frame', 1, null)],
    })
    const target = await resolve('ws', 'task')
    expect(target).toMatchObject({ owner: 'acme', name: 'platform' })
    expect(target?.serviceDirectory).toBeUndefined()
  })

  it('returns null when GitHub is not connected', async () => {
    const resolve = harness({ repos: [], blocks: [], installation: null })
    expect(await resolve('ws', 'task')).toBeNull()
  })

  it('throws when the block is under no repo-linked service', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', isMonorepo: true })],
      blocks: [block('frame', null, 'frame'), block('task', 'frame', 'task')],
      services: [],
    })
    await expect(resolve('ws', 'task')).rejects.toThrow(/not under a service linked/)
  })
})

// The plural resolver (service-connections phase 3): the task's own repo (PRIMARY) plus one
// deduped checkout per connected involved-service frame, with the monorepo asymmetries.
function multiHarness(opts: {
  repos: GitHubRepo[]
  blocks: Block[]
  services?: Service[]
  installation?: GitHubInstallation | null
}) {
  const blocksById = new Map(opts.blocks.map((b) => [b.id, b]))
  const servicesByFrame = new Map((opts.services ?? []).map((s) => [s.frameBlockId, s]))
  return buildResolveRepoTargets({
    installationRepository: {
      getByWorkspace: async () =>
        opts.installation === undefined ? installation : opts.installation,
    },
    repoProjectionRepository: { list: async () => opts.repos },
    blockRepository: { get: async (_ws, id) => blocksById.get(id) ?? null },
    serviceRepository: {
      getByFrameBlock: async (id) => servicesByFrame.get(id) ?? null,
      listByFrameBlocks: async (ids) =>
        ids.map((id) => servicesByFrame.get(id)).filter((s): s is Service => s != null),
    },
  })
}

describe('buildResolveRepoTargets — multi-repo resolution', () => {
  it('resolves the primary plus one distinct peer checkout per involved service repo', async () => {
    const resolve = multiHarness({
      repos: [
        repo({ githubId: 1, owner: 'acme', name: 'auth' }),
        repo({ githubId: 2, owner: 'acme', name: 'email' }),
      ],
      blocks: [
        block('frameAuth', null, 'frame'),
        block('taskLogin', 'frameAuth', 'task'),
        block('frameEmail', null, 'frame'),
      ],
      services: [service('frameAuth', 1, null), service('frameEmail', 2, null)],
    })
    const { checkouts } = await resolve('ws', 'taskLogin', ['frameEmail'])
    expect(checkouts).toHaveLength(2)
    expect(checkouts[0]).toMatchObject({ primary: true, target: { name: 'auth' }, involved: [] })
    expect(checkouts[1]).toMatchObject({
      primary: false,
      target: { name: 'email' },
      involved: [{ frameId: 'frameEmail' }],
    })
  })

  it('DEDUPES two involved services sharing one monorepo into a single checkout with both subdirs', async () => {
    const resolve = multiHarness({
      repos: [
        repo({ githubId: 1, owner: 'acme', name: 'own' }),
        repo({ githubId: 2, owner: 'acme', name: 'mono', isMonorepo: true }),
      ],
      blocks: [
        block('frameOwn', null, 'frame'),
        block('taskX', 'frameOwn', 'task'),
        block('frameA', null, 'frame'),
        block('frameB', null, 'frame'),
      ],
      services: [
        service('frameOwn', 1, null),
        service('frameA', 2, 'packages/a'),
        service('frameB', 2, 'packages/b'),
      ],
    })
    const { checkouts } = await resolve('ws', 'taskX', ['frameA', 'frameB'])
    // One primary + ONE peer checkout for the shared monorepo (not two).
    expect(checkouts).toHaveLength(2)
    const peer = checkouts.find((c) => !c.primary)!
    expect(peer.target.name).toBe('mono')
    expect(peer.involved).toEqual([
      { frameId: 'frameA', serviceDirectory: 'packages/a' },
      { frameId: 'frameB', serviceDirectory: 'packages/b' },
    ])
  })

  it('folds an involved service co-located in the PRIMARY monorepo into the primary checkout (no peer)', async () => {
    const resolve = multiHarness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'mono', isMonorepo: true })],
      blocks: [
        block('frameOwn', null, 'frame'),
        block('taskX', 'frameOwn', 'task'),
        block('framePeer', null, 'frame'),
      ],
      services: [service('frameOwn', 1, 'packages/own'), service('framePeer', 1, 'packages/peer')],
    })
    const { checkouts } = await resolve('ws', 'taskX', ['framePeer'])
    // No separate peer checkout — the co-located service rides the primary's repo.
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]).toMatchObject({ primary: true, target: { name: 'mono' } })
    expect(checkouts[0]!.involved).toEqual([
      { frameId: 'framePeer', serviceDirectory: 'packages/peer' },
    ])
  })

  it('SKIPS an involved service with no linked repo (provisions an env but is not coded)', async () => {
    const resolve = multiHarness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'auth' })],
      blocks: [
        block('frameAuth', null, 'frame'),
        block('taskLogin', 'frameAuth', 'task'),
        block('frameOrphan', null, 'frame'),
      ],
      services: [service('frameAuth', 1, null)],
    })
    const { checkouts } = await resolve('ws', 'taskLogin', ['frameOrphan'])
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]!.primary).toBe(true)
  })

  it('throws when the PRIMARY block is under no repo-linked service', async () => {
    const resolve = multiHarness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'auth' })],
      blocks: [block('frameAuth', null, 'frame'), block('taskLogin', 'frameAuth', 'task')],
    })
    await expect(resolve('ws', 'taskLogin', [])).rejects.toThrow(/not under a service linked/)
  })
})

// A tiny in-memory `GroupCacheHandle` standing in for `AppCaches.repoProjection`. It
// keeps read-through + group invalidation semantics honest without pulling the real
// layered-loader implementation into this package (that behaviour is covered by
// @cat-factory/caching's own tests). Enough to assert that the resolver reads the
// projection THROUGH the cache and that a projection write's `invalidateGroup` makes
// the very next resolve re-list.
function fakeGroupCache<T>(): GroupCacheHandle<T> {
  const byGroup = new Map<string, Map<string, T>>()
  return {
    async get(key, group, load) {
      const entries = byGroup.get(group) ?? new Map<string, T>()
      byGroup.set(group, entries)
      if (entries.has(key)) return entries.get(key) as T
      const value = await load()
      entries.set(key, value)
      return value
    },
    async invalidate(key, group) {
      byGroup.get(group)?.delete(key)
    },
    async invalidateGroup(group) {
      byGroup.delete(group)
    },
    async invalidateAll() {
      byGroup.clear()
    },
  }
}

describe('buildResolveRepoTarget — repoProjection cache (slice 3)', () => {
  function cachingHarness(initialRepos: GitHubRepo[]) {
    const state = { repos: initialRepos, listCalls: 0 }
    const cache = fakeGroupCache<GitHubRepo[]>()
    const resolve = buildResolveRepoTarget({
      installationRepository: { getByWorkspace: async () => installation },
      repoProjectionRepository: {
        list: async () => {
          state.listCalls++
          return state.repos
        },
      },
      blockRepository: {
        get: async (_ws, id) =>
          ({
            ...block(id, id === 'task' ? 'frame' : null, id === 'task' ? 'task' : 'frame'),
          }) as Block,
      },
      serviceRepository: {
        getByFrameBlock: async (id) => (id === 'frame' ? service('frame', 1, null) : null),
      },
      repoProjectionCache: cache,
    })
    return { state, cache, resolve }
  }

  it('reads the projection through the cache — a second resolve does not re-list', async () => {
    const { state, resolve } = cachingHarness([repo({ githubId: 1, owner: 'acme', name: 'a' })])
    expect((await resolve('ws', 'task'))?.name).toBe('a')
    expect((await resolve('ws', 'task'))?.name).toBe('a')
    expect(state.listCalls).toBe(1)
  })

  it('a projection write (invalidateGroup) makes the next resolve re-list fresh repos', async () => {
    const { state, cache, resolve } = cachingHarness([
      repo({ githubId: 1, owner: 'acme', name: 'old' }),
    ])
    expect((await resolve('ws', 'task'))?.name).toBe('old')

    // Simulate a projection write: the source changed, then the write site invalidated.
    state.repos = [repo({ githubId: 1, owner: 'acme', name: 'new' })]
    await cache.invalidateGroup('ws')

    expect((await resolve('ws', 'task'))?.name).toBe('new')
    expect(state.listCalls).toBe(2)
  })

  it('without invalidation the cached (now-stale) projection is served — proving it caches', async () => {
    const { state, resolve } = cachingHarness([repo({ githubId: 1, owner: 'acme', name: 'old' })])
    expect((await resolve('ws', 'task'))?.name).toBe('old')
    state.repos = [repo({ githubId: 1, owner: 'acme', name: 'new' })]
    // No invalidateGroup → the warmed entry stands.
    expect((await resolve('ws', 'task'))?.name).toBe('old')
    expect(state.listCalls).toBe(1)
  })
})
