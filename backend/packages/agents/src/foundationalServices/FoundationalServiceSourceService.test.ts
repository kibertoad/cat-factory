import type {
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
  GitHubClient,
  RepoContentEntry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FoundationalServiceSourceService } from './FoundationalServiceSourceService.js'

// Coverage for the `folder` source mode (backend/docs/adr/0031-foundational-services.md): the
// whole of one folder — optionally its subfolders — is ONE service's contract set, rediscovered
// on every sync rather than pinned at link time.

const OPENAPI = (title: string, path: string) =>
  `openapi: 3.0.3\ninfo:\n  title: ${title}\npaths:\n  ${path}:\n    get: {}\n`

interface FileEntry {
  sha: string
  content: string
}

class FakeServiceRepo implements FoundationalServiceRepository {
  readonly rows = new Map<string, FoundationalServiceRecord>()
  private key(k: string, o: string, s: string) {
    return `${k}|${o}|${s}`
  }
  async listByOwner(ownerKind: string, ownerId: string, includeDeleted = false) {
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === ownerKind && r.ownerId === ownerId && (includeDeleted || !r.deletedAt),
    )
  }
  async get(ownerKind: string, ownerId: string, serviceId: string) {
    return this.rows.get(this.key(ownerKind, ownerId, serviceId)) ?? null
  }
  async upsert(record: FoundationalServiceRecord) {
    this.rows.set(this.key(record.ownerKind, record.ownerId, record.serviceId), { ...record })
  }
  async softDelete(ownerKind: string, ownerId: string, serviceId: string, at: number) {
    const r = this.rows.get(this.key(ownerKind, ownerId, serviceId))
    if (r) r.deletedAt = at
  }
  async hardDelete(ownerKind: string, ownerId: string, serviceId: string) {
    this.rows.delete(this.key(ownerKind, ownerId, serviceId))
  }
  async listBySource(sourceId: string) {
    return [...this.rows.values()].filter((r) => r.sourceId === sourceId && !r.deletedAt)
  }
  async softDeleteBySource(sourceId: string, at: number) {
    for (const r of this.rows.values())
      if (r.sourceId === sourceId && !r.deletedAt) r.deletedAt = at
  }
}

class FakeContractRepo implements ApiContractRepository {
  rows: ApiContractRecord[] = []
  async listManifestByOwner() {
    return []
  }
  async listByServiceIds(ownerKind: string, ownerId: string, serviceIds: string[]) {
    return this.rows.filter(
      (r) => r.ownerKind === ownerKind && r.ownerId === ownerId && serviceIds.includes(r.serviceId),
    )
  }
  async replaceForService(
    ownerKind: string,
    ownerId: string,
    serviceId: string,
    contracts: ApiContractRecord[],
  ) {
    await this.deleteForService(ownerKind, ownerId, serviceId)
    this.rows.push(...contracts.map((c) => ({ ...c })))
  }
  async deleteForService(ownerKind: string, ownerId: string, serviceId: string) {
    this.rows = this.rows.filter(
      (r) => !(r.ownerKind === ownerKind && r.ownerId === ownerId && r.serviceId === serviceId),
    )
  }
}

class FakeSourceRepo implements FoundationalServiceSourceRepository {
  readonly rows = new Map<string, FoundationalServiceSourceRecord>()
  async listByOwner(ownerKind: string, ownerId: string) {
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === ownerKind && r.ownerId === ownerId && !r.deletedAt,
    )
  }
  async listByRepo(repoOwner: string, repoName: string) {
    return [...this.rows.values()].filter(
      (r) => r.repoOwner === repoOwner && r.repoName === repoName && !r.deletedAt,
    )
  }
  async get(id: string) {
    return this.rows.get(id) ?? null
  }
  async upsert(record: FoundationalServiceSourceRecord) {
    this.rows.set(record.id, { ...record })
  }
  async updateSyncState(id: string, lastSyncedCommit: string | null, lastSyncedAt: number) {
    const r = this.rows.get(id)
    if (r) Object.assign(r, { lastSyncedCommit, lastSyncedAt })
  }
  async softDelete(id: string, at: number) {
    const r = this.rows.get(id)
    if (r) r.deletedAt = at
  }
  async listStale() {
    return []
  }
}

/** A GitHub fake over a flat `path -> file` map; listings are derived from the path structure. */
function fakeGitHub(files: Record<string, FileEntry>) {
  const reads: string[] = []
  const listings: string[] = []
  const listDirectory = async (
    _i: number,
    _r: unknown,
    path: string,
  ): Promise<RepoContentEntry[]> => {
    listings.push(path)
    const prefix = path ? `${path}/` : ''
    const dirs = new Set<string>()
    const out: RepoContentEntry[] = []
    for (const [full, f] of Object.entries(files)) {
      if (!full.startsWith(prefix)) continue
      const rest = full.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) out.push({ path: full, name: rest, type: 'file', sha: f.sha })
      else dirs.add(rest.slice(0, slash))
    }
    return [
      ...[...dirs].map((d) => ({
        path: `${prefix}${d}`,
        name: d,
        type: 'dir' as const,
        sha: `tree-${d}`,
      })),
      ...out,
    ]
  }
  return {
    files,
    reads,
    listings,
    listDirectory,
    getFileContent: async (_i: number, _r: unknown, path: string) => {
      reads.push(path)
      const f = files[path]
      return f ? { content: f.content, sha: f.sha } : null
    },
    latestCommitSha: async (_i: number, _r: unknown, dir: string) => {
      const prefix = dir ? `${dir}/` : ''
      const parts = Object.entries(files)
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, f]) => `${p}:${f.sha}`)
        .sort()
      return parts.length ? `commit:${parts.join('|')}` : null
    },
  }
}

function makeService(github: ReturnType<typeof fakeGitHub>) {
  const services = new FakeServiceRepo()
  const contracts = new FakeContractRepo()
  const sources = new FakeSourceRepo()
  let seq = 0
  const service = new FoundationalServiceSourceService({
    foundationalServiceSourceRepository: sources,
    foundationalServiceRepository: services,
    apiContractRepository: contracts,
    githubClient: github as unknown as GitHubClient,
    resolveInstallationId: async () => 42,
    idGenerator: { next: (p?: string) => `${p ?? 'id'}_${++seq}` },
    clock: { now: () => 1_000_000 + seq++ },
  })
  return { service, services, contracts, sources }
}

const link = {
  repoOwner: 'acme',
  repoName: 'platform',
  mode: 'folder' as const,
  dirPath: 'specs',
  serviceId: 'billing',
  serviceName: 'Billing',
}

describe('FoundationalServiceSourceService — folder mode', () => {
  it('attaches every contract under the folder to the one named service', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
      'specs/events.ts': { sha: 'b', content: "import { x } from '@toad-contracts/core'" },
      // Neither is a contract document: one has no contract extension (never read at all), the
      // other has one but does not parse as anything we can serve.
      'specs/README.md': { sha: 'c', content: '# Billing' },
      'specs/tsconfig.json': { sha: 'd', content: '{"compilerOptions":{}}' },
    })
    const { service, services, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.upserted).toBe(1)
    // Only `tsconfig.json` is counted: it LOOKED like a contract and was not one. The README is
    // never read, so it is neither a cost nor a reported loss.
    expect(result.skippedFiles).toBe(1)
    expect(result.truncated).toBe(false)
    expect(github.reads).not.toContain('specs/README.md')

    expect(services.rows.get('account|acct1|billing')?.name).toBe('Billing')
    expect(contracts.rows.map((c) => c.contractId).sort()).toEqual(['events', 'openapi'])
    expect(contracts.rows.every((c) => c.serviceId === 'billing')).toBe(true)
  })

  it('stays in the folder unless the link asked for subfolders', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
      'specs/v2/openapi.yaml': { sha: 'b', content: OPENAPI('Billing v2', '/v2/invoices') },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    await service.sync('account', 'acct1', source.id)

    expect(contracts.rows.map((c) => c.sourcePath)).toEqual(['specs/openapi.yaml'])
  })

  it('keeps same-named files in different subfolders apart when recursing', async () => {
    const github = fakeGitHub({
      'specs/v1/users.yaml': { sha: 'a', content: OPENAPI('Users v1', '/v1/users') },
      'specs/v2/users.yaml': { sha: 'b', content: OPENAPI('Users v2', '/v2/users') },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', { ...link, recursive: true })

    const result = await service.sync('account', 'acct1', source.id)

    // The basename rule would collapse both to `users` and silently drop one, handing a coder
    // v1's endpoints as though they were the whole interface.
    expect(contracts.rows.map((c) => c.contractId).sort()).toEqual(['v1-users', 'v2-users'])
    expect(result.skippedFiles).toBe(0)
  })

  it('picks up a contract added upstream without the link being edited', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)
    await service.sync('account', 'acct1', source.id)
    expect(contracts.rows).toHaveLength(1)

    // The whole reason `folder` exists beside `files`: the set is rediscovered, not pinned.
    github.files['specs/refunds.yaml'] = { sha: 'z', content: OPENAPI('Refunds', '/refunds') }
    await service.sync('account', 'acct1', source.id)

    expect(contracts.rows.map((c) => c.contractId).sort()).toEqual(['openapi', 'refunds'])
  })

  it('reads an optional root service.md for description and tags, never for identity', async () => {
    const github = fakeGitHub({
      'specs/service.md': {
        sha: 'm',
        content: '---\nname: Ignored\ncapabilities: [billing, invoicing]\n---\nWhat it covers.',
      },
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service, services } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    await service.sync('account', 'acct1', source.id)

    const row = services.rows.get('account|acct1|billing')
    expect(row?.description).toBe('What it covers.')
    expect(row?.capabilities).toEqual(['billing', 'invoicing'])
    // The LINK named the service; a manifest in the folder can only ever enrich it.
    expect(row?.name).toBe('Billing')
  })

  it('keeps a prior service alive when the whole folder reads back unusable', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service, services, sources } = makeService(github)
    const source = await service.link('account', 'acct1', link)
    await service.sync('account', 'acct1', source.id)
    const pinned = sources.rows.get(source.id)?.lastSyncedCommit

    // The document is still there but no longer parses — a transient mid-edit state.
    github.files['specs/openapi.yaml'] = { sha: 'broken', content: 'openapi: <<<' }
    const result = await service.sync('account', 'acct1', source.id)

    expect(result.upserted).toBe(0)
    expect(services.rows.get('account|acct1|billing')?.deletedAt).toBeNull()
    // The pin is left behind so the next pass re-reads rather than serving stale content forever.
    expect(sources.rows.get(source.id)?.lastSyncedCommit).toBe(pinned)
  })

  it('tombstones the service when the folder is unlinked', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service, services, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)
    await service.sync('account', 'acct1', source.id)

    await service.unlink('account', 'acct1', source.id)

    expect(services.rows.get('account|acct1|billing')?.deletedAt).not.toBeNull()
    expect(contracts.rows).toEqual([])
  })

  it('costs one commit read and no listing when nothing upstream moved', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service } = makeService(github)
    const source = await service.link('account', 'acct1', { ...link, recursive: true })
    await service.sync('account', 'acct1', source.id)
    github.listings.length = 0
    github.reads.length = 0

    const result = await service.sync('account', 'acct1', source.id)

    expect(github.listings).toEqual([])
    expect(github.reads).toEqual([])
    expect(result).toMatchObject({ upserted: 0, unchanged: 1, skippedFiles: 0, truncated: false })
  })
})
