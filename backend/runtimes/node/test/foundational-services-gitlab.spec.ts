import { FoundationalServiceSourceService } from '@cat-factory/agents'
import { asGitHubClient } from '@cat-factory/gitlab'
import { FetchGitLabClient, StaticGitLabTokenSource } from '@cat-factory/gitlab'
import type {
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// A GITLAB-sourced foundational-service repo link
// (backend/docs/adr/0031-foundational-services.md).
//
// The catalog's source sync reads through the `GitHubClient` port, so the tracker's claim was
// that a GitLab deployment reaches it through `vcsBackedGitHubClient` "like every other repo
// read". That is exactly the kind of claim worth pinning: the sync uses only three of the port's
// methods (`latestCommitSha`, `listDirectory`, `getFileContent`), and each of the three is one
// the GitLab adapter had to REWRITE rather than pass through — GitLab's tree entries are
// `blob`/`tree` where the port speaks `file`/`dir`, its file bodies arrive base64, and its
// commits API takes a `ref_name` query rather than a path segment. A pass-through assumption
// anywhere in that chain would surface as a source that silently syncs nothing.
//
// So this drives the REAL `FoundationalServiceSourceService` over a REAL `FetchGitLabClient`
// (scripted at the HTTP boundary, the same shape the GitLab package's own tests use) and asserts
// a service plus its contract document land in the catalog.
// ---------------------------------------------------------------------------

const PROJECT = 'group%2Fplatform'
const HEAD = 'c0ffee1'
const OWNER = { ownerKind: 'account' as const, ownerId: 'acct-1' }

const MANIFEST = `---
name: File Storage
summary: Stores and serves user uploads.
capabilities: [file-storage, cdn]
---
Use this for any binary blob. Do not build another uploader.
`

const OPENAPI = 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n    post: {}\n'

/** base64 the way GitLab returns a file body, so the adapter's decode is exercised. */
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/** Scripted GitLab API, matched on `METHOD path`. Unknown routes fail loudly. */
function gitlabClient(routes: Record<string, unknown>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.replace('https://gitlab.com/api/v4', '')
    calls.push(`${method} ${path}`)
    const body = routes[`${method} ${path}`]
    if (body === undefined) throw new Error(`Unexpected GitLab request: ${method} ${path}`)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const vcs = new FetchGitLabClient({
    tokenSource: new StaticGitLabTokenSource('tok'),
    clock: { now: () => 1_000 },
    fetchImpl,
  })
  return { githubClient: asGitHubClient({ vcs, provider: 'gitlab' }), calls }
}

function inMemoryRepos() {
  const services = new Map<string, FoundationalServiceRecord>()
  const contracts: ApiContractRecord[] = []
  const key = (r: Pick<FoundationalServiceRecord, 'ownerKind' | 'ownerId' | 'serviceId'>) =>
    `${r.ownerKind}:${r.ownerId}:${r.serviceId}`

  const serviceRepository = {
    listByOwner: async () => [...services.values()].filter((s) => !s.deletedAt),
    get: async (ownerKind, ownerId, serviceId) =>
      services.get(key({ ownerKind, ownerId, serviceId })) ?? null,
    upsert: async (record) => {
      services.set(key(record), record)
    },
    softDelete: async (ownerKind, ownerId, serviceId, at) => {
      const k = key({ ownerKind, ownerId, serviceId })
      const row = services.get(k)
      if (row) services.set(k, { ...row, deletedAt: at })
    },
    hardDelete: async (ownerKind, ownerId, serviceId) => {
      services.delete(key({ ownerKind, ownerId, serviceId }))
    },
    listBySource: async (sourceId) =>
      [...services.values()].filter((s) => s.sourceId === sourceId && !s.deletedAt),
    softDeleteBySource: async () => undefined,
  } satisfies FoundationalServiceRepository

  const contractRepository = {
    listManifestByOwner: async () => [],
    listByServiceIds: async (_kind, _id, serviceIds) =>
      contracts.filter((c) => serviceIds.includes(c.serviceId)),
    replaceForService: async (ownerKind, ownerId, serviceId, next) => {
      for (let i = contracts.length - 1; i >= 0; i--) {
        const c = contracts[i]!
        if (c.ownerKind === ownerKind && c.ownerId === ownerId && c.serviceId === serviceId) {
          contracts.splice(i, 1)
        }
      }
      contracts.push(...next)
    },
    deleteForService: async () => undefined,
  } satisfies ApiContractRepository

  return { services, contracts, serviceRepository, contractRepository }
}

function sourceRepos(source: FoundationalServiceSourceRecord) {
  let row = source
  return {
    read: () => row,
    repository: {
      listByOwner: async () => [row],
      listByRepo: async () => [row],
      get: async (id) => (id === row.id ? row : null),
      upsert: async (record) => {
        row = record
      },
      updateSyncState: async (_id, lastSyncedCommit, lastSyncedAt) => {
        row = { ...row, lastSyncedCommit, lastSyncedAt }
      },
      softDelete: async () => undefined,
      listStale: async () => [],
    } satisfies FoundationalServiceSourceRepository,
  }
}

describe('foundational-service sources over a GitLab connection', () => {
  it('syncs a directory source through vcsBackedGitHubClient', async () => {
    const { githubClient, calls } = gitlabClient({
      // The head-commit probe: a concrete `gitRef` on the link means no default-branch lookup.
      [`GET /projects/${PROJECT}/repository/commits?per_page=1&path=foundational&ref_name=main`]: [
        { id: HEAD },
      ],
      // The scanned subtree: GitLab's `tree` type must be normalised to the port's `dir`.
      [`GET /projects/${PROJECT}/repository/tree?per_page=100&path=foundational&ref=${HEAD}`]: [
        { path: 'foundational/file-storage', name: 'file-storage', type: 'tree' },
        { path: 'foundational/README.md', name: 'README.md', type: 'blob' },
      ],
      [`GET /projects/${PROJECT}/repository/tree?per_page=100&path=foundational%2Ffile-storage&ref=${HEAD}`]:
        [
          { path: 'foundational/file-storage/service.md', name: 'service.md', type: 'blob' },
          { path: 'foundational/file-storage/openapi.yaml', name: 'openapi.yaml', type: 'blob' },
        ],
      // Both bodies arrive base64-encoded, as GitLab's files API returns them.
      [`GET /projects/${PROJECT}/repository/files/foundational%2Ffile-storage%2Fservice.md?ref=${HEAD}`]:
        { content: b64(MANIFEST), encoding: 'base64', blob_id: 'blob-manifest' },
      [`GET /projects/${PROJECT}/repository/files/foundational%2Ffile-storage%2Fopenapi.yaml?ref=${HEAD}`]:
        { content: b64(OPENAPI), encoding: 'base64', blob_id: 'blob-openapi' },
    })

    const source: FoundationalServiceSourceRecord = {
      id: 'fndsrc-1',
      ...OWNER,
      repoOwner: 'group',
      repoName: 'platform',
      gitRef: 'main',
      mode: 'directory',
      dirPath: 'foundational',
      recursive: false,
      filePaths: [],
      serviceId: null,
      serviceName: null,
      serviceSummary: null,
      lastSyncedCommit: null,
      lastSyncedAt: null,
      createdAt: 1,
      deletedAt: null,
    }
    const sources = sourceRepos(source)
    const store = inMemoryRepos()
    const service = new FoundationalServiceSourceService({
      foundationalServiceSourceRepository: sources.repository,
      foundationalServiceRepository: store.serviceRepository,
      apiContractRepository: store.contractRepository,
      githubClient,
      resolveInstallationId: async () => 42,
      idGenerator: { next: (prefix: string) => `${prefix}_1` },
      clock: { now: () => 5_000 },
    })

    const result = await service.sync('account', 'acct-1', 'fndsrc-1')

    expect(result).toMatchObject({ upserted: 1, tombstoned: 0, lastSyncedCommit: HEAD })
    const stored = [...store.services.values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      serviceId: 'file-storage',
      name: 'File Storage',
      summary: 'Stores and serves user uploads.',
      capabilities: ['file-storage', 'cdn'],
      sourceId: 'fndsrc-1',
      pinnedCommit: HEAD,
    })
    // The contract survived the base64 round trip, and its operations were indexed at write
    // time — which is the whole reason the catalog can be read without a document body.
    expect(store.contracts).toHaveLength(1)
    expect(store.contracts[0]).toMatchObject({
      contractId: 'openapi',
      format: 'openapi',
      body: OPENAPI,
      operations: ['GET /files', 'POST /files'],
    })
    // Nothing reached github.com: every read went to the GitLab API.
    expect(calls.every((c) => c.startsWith('GET /projects/'))).toBe(true)
    // The pin advanced, so the next pass costs exactly one commit read.
    expect(sources.read().lastSyncedCommit).toBe(HEAD)
  })

  it('answers the cheap "check for changes" probe without listing the tree', async () => {
    const { githubClient, calls } = gitlabClient({
      [`GET /projects/${PROJECT}/repository/commits?per_page=1&path=foundational&ref_name=main`]: [
        { id: 'newer-commit' },
      ],
    })
    const sources = sourceRepos({
      id: 'fndsrc-1',
      ...OWNER,
      repoOwner: 'group',
      repoName: 'platform',
      gitRef: 'main',
      mode: 'directory',
      dirPath: 'foundational',
      recursive: false,
      filePaths: [],
      serviceId: null,
      serviceName: null,
      serviceSummary: null,
      lastSyncedCommit: HEAD,
      lastSyncedAt: 1,
      createdAt: 1,
      deletedAt: null,
    })
    const store = inMemoryRepos()
    const service = new FoundationalServiceSourceService({
      foundationalServiceSourceRepository: sources.repository,
      foundationalServiceRepository: store.serviceRepository,
      apiContractRepository: store.contractRepository,
      githubClient,
      resolveInstallationId: async () => 42,
      idGenerator: { next: (prefix: string) => `${prefix}_1` },
      clock: { now: () => 5_000 },
    })

    expect(await service.status('account', 'acct-1', 'fndsrc-1')).toEqual({
      changed: true,
      lastSyncedCommit: HEAD,
      remoteCommit: 'newer-commit',
    })
    expect(calls).toHaveLength(1)
  })
})
