import type { Block, GitHubInstallation, GitHubRepo, Service } from '@cat-factory/kernel'
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
    blockId: null,
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

  it('falls back to the legacy block_id link (no directory) when no service is wired', async () => {
    const resolve = harness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'platform', blockId: 'frame' })],
      blocks: [block('frame', null, 'frame'), block('task', 'frame', 'task')],
      services: [],
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
        repo({ githubId: 1, owner: 'acme', name: 'auth', blockId: 'frameAuth' }),
        repo({ githubId: 2, owner: 'acme', name: 'email', blockId: 'frameEmail' }),
      ],
      blocks: [
        block('frameAuth', null, 'frame'),
        block('taskLogin', 'frameAuth', 'task'),
        block('frameEmail', null, 'frame'),
      ],
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
        repo({ githubId: 1, owner: 'acme', name: 'own', blockId: 'frameOwn' }),
        repo({ githubId: 2, owner: 'acme', name: 'mono', isMonorepo: true }),
      ],
      blocks: [
        block('frameOwn', null, 'frame'),
        block('taskX', 'frameOwn', 'task'),
        block('frameA', null, 'frame'),
        block('frameB', null, 'frame'),
      ],
      services: [service('frameA', 2, 'packages/a'), service('frameB', 2, 'packages/b')],
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
    expect(checkouts[0].involved).toEqual([
      { frameId: 'framePeer', serviceDirectory: 'packages/peer' },
    ])
  })

  it('SKIPS an involved service with no linked repo (provisions an env but is not coded)', async () => {
    const resolve = multiHarness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'auth', blockId: 'frameAuth' })],
      blocks: [
        block('frameAuth', null, 'frame'),
        block('taskLogin', 'frameAuth', 'task'),
        block('frameOrphan', null, 'frame'),
      ],
    })
    const { checkouts } = await resolve('ws', 'taskLogin', ['frameOrphan'])
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0].primary).toBe(true)
  })

  it('throws when the PRIMARY block is under no repo-linked service', async () => {
    const resolve = multiHarness({
      repos: [repo({ githubId: 1, owner: 'acme', name: 'auth', blockId: 'other' })],
      blocks: [block('frameAuth', null, 'frame'), block('taskLogin', 'frameAuth', 'task')],
    })
    await expect(resolve('ws', 'taskLogin', [])).rejects.toThrow(/not under a service linked/)
  })
})
