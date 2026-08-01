import type {
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
  GitHubClient,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FoundationalServiceSourceService } from './FoundationalServiceSourceService.js'

// The repo-SOURCE half of the catalog: the one surface that can RETIRE content, and the one the
// autorefresh sweep drives unattended. These tests are about the service's rules — what a unit
// is, when a row is kept alive rather than retired, how a failed attempt is recorded — with the
// real stores' behaviour pinned separately by the conformance suite.

const OPENAPI = [
  'openapi: 3.0.3',
  'info:',
  '  title: File Storage API',
  'paths:',
  '  /files:',
  '    get: {}',
].join('\n')

const SERVICE_MD = ['---', 'name: File Storage', 'summary: Stores uploads.', '---', 'Body.'].join(
  '\n',
)

interface Tree {
  [path: string]: { type: 'dir' | 'file'; content?: string }
}

function githubClient(tree: Tree, headCommit: string | null = 'c1'): GitHubClient {
  return {
    latestCommitSha: async () => headCommit,
    listDirectory: async (_i: number, _r: unknown, path: string) =>
      Object.entries(tree)
        .filter(([p]) => {
          const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
          return parent === path
        })
        .map(([p, node]) => ({
          name: p.slice(p.lastIndexOf('/') + 1),
          path: p,
          type: node.type,
        })),
    getFileContent: async (_i: number, _r: unknown, path: string) => {
      const node = tree[path]
      return node?.content === undefined ? null : { content: node.content, sha: `sha-${path}` }
    },
  } as unknown as GitHubClient
}

function sourceRepo(seed: FoundationalServiceSourceRecord[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]))
  const repo: FoundationalServiceSourceRepository = {
    listByOwner: async (ownerKind, ownerId) =>
      [...rows.values()].filter(
        (r) => r.ownerKind === ownerKind && r.ownerId === ownerId && !r.deletedAt,
      ),
    get: async (id) => rows.get(id) ?? null,
    getByLocation: async (ownerKind, ownerId, location) =>
      [...rows.values()].find(
        (r) =>
          r.ownerKind === ownerKind &&
          r.ownerId === ownerId &&
          r.repoOwner === location.repoOwner &&
          r.repoName === location.repoName &&
          r.gitRef === location.gitRef &&
          r.dirPath === location.dirPath,
      ) ?? null,
    upsert: async (record) => {
      rows.set(record.id, record)
    },
    updateSyncState: async (id, commit, at) => {
      const row = rows.get(id)
      if (row) {
        rows.set(id, {
          ...row,
          lastSyncedCommit: commit,
          lastSyncedAt: at,
          lastAttemptedAt: at,
          lastError: null,
        })
      }
    },
    recordSyncFailure: async (id, at, error) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, lastAttemptedAt: at, lastError: error })
    },
    softDelete: async (id, at) => {
      const row = rows.get(id)
      if (row) rows.set(id, { ...row, deletedAt: at })
    },
    listStale: async () => [...rows.values()].filter((r) => !r.deletedAt),
  }
  return { repo, rows }
}

function serviceRepo(seed: FoundationalServiceRecord[] = []) {
  const rows = new Map(seed.map((r) => [`${r.ownerKind}:${r.ownerId}:${r.serviceId}`, r]))
  const repo: FoundationalServiceRepository = {
    listByOwner: async (ownerKind, ownerId, includeDeleted = false) =>
      [...rows.values()]
        .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
        .filter((r) => includeDeleted || !r.deletedAt),
    get: async (ownerKind, ownerId, serviceId) =>
      rows.get(`${ownerKind}:${ownerId}:${serviceId}`) ?? null,
    upsert: async (record) => {
      rows.set(`${record.ownerKind}:${record.ownerId}:${record.serviceId}`, record)
    },
    softDelete: async (ownerKind, ownerId, serviceId, at) => {
      const key = `${ownerKind}:${ownerId}:${serviceId}`
      const row = rows.get(key)
      if (row) rows.set(key, { ...row, deletedAt: at })
    },
    listBySource: async (sourceId) =>
      [...rows.values()].filter((r) => r.sourceId === sourceId && !r.deletedAt),
    softDeleteBySource: async (sourceId, at) => {
      for (const [key, row] of rows) {
        if (row.sourceId === sourceId) rows.set(key, { ...row, deletedAt: at })
      }
    },
  }
  return { repo, rows }
}

function contractRepo() {
  let rows: ApiContractRecord[] = []
  const repo: ApiContractRepository = {
    listManifestByOwner: async () => [],
    listByServiceIds: async (_k, _o, ids) => rows.filter((r) => ids.includes(r.serviceId)),
    replaceForService: async (ownerKind, ownerId, serviceId, contracts) => {
      rows = rows.filter(
        (r) => !(r.ownerKind === ownerKind && r.ownerId === ownerId && r.serviceId === serviceId),
      )
      rows.push(...contracts)
    },
    deleteForService: async (ownerKind, ownerId, serviceId) => {
      rows = rows.filter(
        (r) => !(r.ownerKind === ownerKind && r.ownerId === ownerId && r.serviceId === serviceId),
      )
    },
  }
  return { repo, all: () => rows }
}

function build(options: {
  tree?: Tree
  headCommit?: string | null
  sources?: FoundationalServiceSourceRecord[]
  services?: FoundationalServiceRecord[]
  installationId?: number | null
  /** Per-OWNER installation, for driving one source to fail while another succeeds. */
  installationByOwner?: Record<string, number | null>
  now?: number
}) {
  const sources = sourceRepo(options.sources ?? [])
  const services = serviceRepo(options.services ?? [])
  const contracts = contractRepo()
  let clock = options.now ?? 1_000
  const service = new FoundationalServiceSourceService({
    foundationalServiceSourceRepository: sources.repo,
    foundationalServiceRepository: services.repo,
    apiContractRepository: contracts.repo,
    githubClient: githubClient(options.tree ?? {}, options.headCommit ?? 'c1'),
    resolveInstallationId: async (_kind, ownerId) => {
      if (options.installationByOwner) return options.installationByOwner[ownerId] ?? null
      return options.installationId === undefined ? 42 : options.installationId
    },
    idGenerator: { next: (prefix: string) => `${prefix}_new` },
    clock: { now: () => clock },
  })
  return { service, sources, services, contracts, tick: (at: number) => (clock = at) }
}

function sourceRow(over: Partial<FoundationalServiceSourceRecord> = {}) {
  return {
    id: 'fndsrc_1',
    ownerKind: 'account' as const,
    ownerId: 'acc_1',
    repoOwner: 'acme',
    repoName: 'platform',
    gitRef: 'HEAD',
    mode: 'directory' as const,
    dirPath: 'foundational',
    filePaths: [],
    serviceId: null,
    serviceName: null,
    serviceSummary: null,
    lastSyncedCommit: null,
    lastSyncedAt: null,
    lastAttemptedAt: null,
    lastError: null,
    createdAt: 1,
    deletedAt: null,
    ...over,
  }
}

const DIRECTORY_TREE: Tree = {
  foundational: { type: 'dir' },
  'foundational/file-storage': { type: 'dir' },
  'foundational/file-storage/service.md': { type: 'file', content: SERVICE_MD },
  'foundational/file-storage/openapi.yaml': { type: 'file', content: OPENAPI },
}

describe('link', () => {
  it('REVIVES a tombstoned link rather than colliding with the unique location index', async () => {
    // An unlink only tombstones, and the location (owner × repo × ref × dir) is unique — so
    // inserting a fresh row here is a constraint violation, i.e. a 500 on an ordinary
    // unlink/relink. The revived row reuses the id and keeps its original createdAt.
    const { service, sources } = build({
      sources: [sourceRow({ deletedAt: 5_000, lastSyncedCommit: 'c1', lastSyncedAt: 4_000 })],
    })

    const linked = await service.link('account', 'acc_1', {
      repoOwner: 'acme',
      repoName: 'platform',
      mode: 'directory',
      dirPath: 'foundational',
    } as never)

    expect(linked.id).toBe('fndsrc_1')
    expect(sources.rows.size).toBe(1)
    expect(sources.rows.get('fndsrc_1')?.deletedAt).toBeNull()
    // The pin is RESET. `unlink` tombstoned every service this source produced, so a retained
    // pin would make the next pass short-circuit on an unchanged head commit and re-create none
    // of them — a source reporting itself synced while producing nothing.
    expect(linked.lastSyncedCommit).toBeNull()
    expect(linked.lastSyncedAt).toBeNull()
  })

  it('refuses a second LIVE link to the same location with a conflict, not a constraint error', async () => {
    const { service } = build({ sources: [sourceRow()] })
    await expect(
      service.link('account', 'acc_1', {
        repoOwner: 'acme',
        repoName: 'platform',
        mode: 'directory',
        dirPath: 'foundational',
      } as never),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'foundational_source_exists' } })
  })

  it('anchors a `files` link on the linked paths deepest common directory', async () => {
    const { service } = build({})
    const linked = await service.link('account', 'acc_1', {
      repoOwner: 'acme',
      repoName: 'platform',
      mode: 'files',
      filePaths: ['./api/v1/openapi.yaml', 'api/v1/contracts.ts'],
      serviceId: 'audit',
      serviceName: 'Audit',
    } as never)
    // One head-commit probe over the common ancestor covers every linked file.
    expect(linked.dirPath).toBe('api/v1')
    expect(linked.filePaths).toEqual(['api/v1/openapi.yaml', 'api/v1/contracts.ts'])
  })
})

describe('sync', () => {
  it('registers one service per manifest-bearing directory, titling contracts from the document', async () => {
    const { service, services, contracts } = build({
      tree: DIRECTORY_TREE,
      sources: [sourceRow()],
    })

    const result = await service.sync('account', 'acc_1', 'fndsrc_1')

    expect(result.upserted).toBe(1)
    expect(services.rows.get('account:acc_1:file-storage')?.name).toBe('File Storage')
    // The document's own `info.title`, not `openapi.yaml` — every service's file has that name.
    expect(contracts.all().map((c) => c.title)).toEqual(['File Storage API'])
    expect(contracts.all()[0]?.operations).toEqual(['GET /files'])
  })

  it('keeps a prior row alive when its manifest reads back unparseable, and holds the pin back', async () => {
    // The retire-safety property: a transient read failure must never strip a capability from
    // every subsequent design, and the pin must stay behind so the next pass re-reads.
    const { service, services, sources } = build({
      tree: {
        foundational: { type: 'dir' },
        'foundational/file-storage': { type: 'dir' },
        'foundational/file-storage/service.md': { type: 'file', content: 'no frontmatter here' },
      },
      sources: [sourceRow({ lastSyncedCommit: 'c0' })],
      services: [
        {
          serviceId: 'file-storage',
          ownerKind: 'account',
          ownerId: 'acc_1',
          name: 'File Storage',
          summary: 's',
          description: '',
          capabilities: [],
          sourceId: 'fndsrc_1',
          sourcePath: 'foundational/file-storage',
          pinnedCommit: 'c0',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    })

    await service.sync('account', 'acc_1', 'fndsrc_1')

    expect(services.rows.get('account:acc_1:file-storage')?.deletedAt).toBeNull()
    expect(sources.rows.get('fndsrc_1')?.lastSyncedCommit).toBe('c0')
  })

  it('retires a service whose directory LOST its manifest', async () => {
    // The other half: a real removal upstream must actually retire, or a withdrawn service keeps
    // being offered to designs forever.
    const { service, services } = build({
      tree: { foundational: { type: 'dir' } },
      sources: [sourceRow({ lastSyncedCommit: 'c0' })],
      services: [
        {
          serviceId: 'file-storage',
          ownerKind: 'account',
          ownerId: 'acc_1',
          name: 'File Storage',
          summary: 's',
          description: '',
          capabilities: [],
          sourceId: 'fndsrc_1',
          sourcePath: 'foundational/file-storage',
          pinnedCommit: 'c0',
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
    })

    await service.sync('account', 'acc_1', 'fndsrc_1')
    expect(services.rows.get('account:acc_1:file-storage')?.deletedAt).not.toBeNull()
  })

  it('records a FAILED attempt without advancing the sync state, and still throws', async () => {
    // What keeps the sweep fair: the attempt is stamped so the source rotates out of the batch,
    // while `lastSyncedAt` stays where the last real success left it.
    const { service, sources, tick } = build({
      sources: [sourceRow({ lastSyncedCommit: 'c0', lastSyncedAt: 100, lastAttemptedAt: 100 })],
      installationId: null,
    })
    tick(9_000)

    await expect(service.sync('account', 'acc_1', 'fndsrc_1')).rejects.toMatchObject({
      code: 'validation',
    })

    const row = sources.rows.get('fndsrc_1')
    expect(row?.lastAttemptedAt).toBe(9_000)
    expect(row?.lastError).toContain('No GitHub installation')
    expect(row?.lastSyncedAt).toBe(100)
    expect(row?.lastSyncedCommit).toBe('c0')
  })

  it('clears a recorded failure once a sync succeeds', async () => {
    const { service, sources, tick } = build({
      tree: DIRECTORY_TREE,
      sources: [sourceRow({ lastError: 'installation revoked', lastAttemptedAt: 100 })],
    })
    tick(9_000)

    await service.sync('account', 'acc_1', 'fndsrc_1')

    const row = sources.rows.get('fndsrc_1')
    expect(row?.lastError).toBeNull()
    expect(row?.lastSyncedAt).toBe(9_000)
    expect(row?.lastAttemptedAt).toBe(9_000)
  })
})

describe('refreshStale', () => {
  it('keeps sweeping after one source THROWS, and counts only the ones that synced', async () => {
    // One revoked installation must not stop the pass from refreshing everyone else's — and the
    // failing source still gets its attempt stamped, which is what moves it out of the way.
    const { service, sources, tick } = build({
      tree: DIRECTORY_TREE,
      sources: [
        sourceRow({ id: 'broken', ownerId: 'acc_broken' }),
        sourceRow({ id: 'healthy', ownerId: 'acc_1' }),
      ],
      installationByOwner: { acc_1: 42, acc_broken: null },
    })
    tick(9_000)

    // One synced; the pass did not abort on the other's throw.
    expect(await service.refreshStale(1_000, 10)).toBe(1)

    const broken = sources.rows.get('broken')
    expect(broken?.lastError).toContain('No GitHub installation')
    expect(broken?.lastAttemptedAt).toBe(9_000)
    // …and it did NOT get a sync it never had.
    expect(broken?.lastSyncedAt).toBeNull()

    const healthy = sources.rows.get('healthy')
    expect(healthy?.lastSyncedAt).toBe(9_000)
    expect(healthy?.lastError).toBeNull()
  })

  it('stamps the attempt on every source even when all of them throw', async () => {
    const { service, sources, tick } = build({
      sources: [sourceRow({ id: 'a' }), sourceRow({ id: 'b', dirPath: 'other' })],
      installationId: null,
    })
    tick(9_000)

    expect(await service.refreshStale(1_000, 10)).toBe(0)

    // Both rotated out of the head of the queue rather than re-occupying it forever.
    expect(sources.rows.get('a')?.lastAttemptedAt).toBe(9_000)
    expect(sources.rows.get('b')?.lastAttemptedAt).toBe(9_000)
    expect(sources.rows.get('a')?.lastError).toContain('No GitHub installation')
  })
})
