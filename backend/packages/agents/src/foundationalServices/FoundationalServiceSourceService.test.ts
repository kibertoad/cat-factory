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
import { MAX_FOLDER_CONTRACT_FILES, MAX_FOLDER_SCAN_DIRECTORIES } from './folder-scan.js'

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
      // None of these is a contract document, and they are dropped at three different points:
      // the README by extension, `tsconfig.json` by basename (both before any read), and
      // `settings.json` only once its body turns out to be nothing we can serve.
      'specs/README.md': { sha: 'c', content: '# Billing' },
      'specs/tsconfig.json': { sha: 'd', content: '{"compilerOptions":{}}' },
      'specs/settings.json': { sha: 'e', content: '{"retries":3}' },
    })
    const { service, services, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.upserted).toBe(1)
    // Only `settings.json` is counted: it LOOKED like a contract and was not one. The other two
    // are never read, so neither is a cost nor a reported loss — counting them would restate the
    // folder's contents instead of explaining a thin catalog entry.
    expect(result.skippedFiles).toBe(1)
    expect(result.folderScan).toBe('complete')
    expect(github.reads).not.toContain('specs/README.md')
    expect(github.reads).not.toContain('specs/tsconfig.json')

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
    expect(result.skippedFiles).toBe(1)
    // A candidate that failed to READ is not a folder that holds nothing: the service survives
    // where an emptied folder's would be retired, which is the distinction the "nothing to take"
    // cases below turn on.
    expect(result.tombstoned).toBe(0)
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
    expect(result).toMatchObject({ upserted: 0, unchanged: 1, skippedFiles: 0, folderScan: null })
  })
})

// A folder holding no contracts is a STABLE state, not a failed read, and the difference is the
// whole reason `folder` mode cannot simply inherit `files` mode's zero-contract disposition: a
// `files` link is validated to carry at least one path, so zero contracts there really does mean
// something failed, while a spec folder is routinely empty before anyone fills it in.
describe('FoundationalServiceSourceService — folder mode, nothing to take', () => {
  it('pins an empty folder instead of re-walking it forever', async () => {
    // Prose beside no specs: nothing here even LOOKS like a contract.
    const github = fakeGitHub({ 'specs/README.md': { sha: 'a', content: '# specs' } })
    const { service, sources } = makeService(github)
    const source = await service.link('account', 'acct1', { ...link, recursive: true })

    const first = await service.sync('account', 'acct1', source.id)

    // The pass is complete, so the commit is pinned and the source stops claiming to be behind.
    expect(first.lastSyncedCommit).not.toBeNull()
    expect(sources.rows.get(source.id)?.lastSyncedCommit).toBe(first.lastSyncedCommit)
    expect((await service.status('account', 'acct1', source.id)).changed).toBe(false)

    // ...and the next sweep costs one commit read rather than another walk of the whole subtree.
    github.listings.length = 0
    await service.sync('account', 'acct1', source.id)
    expect(github.listings).toEqual([])
  })

  it('retires the service when the folder is emptied upstream', async () => {
    const github = fakeGitHub({
      'specs/openapi.yaml': { sha: 'a', content: OPENAPI('Billing', '/invoices') },
    })
    const { service, services, contracts, sources } = makeService(github)
    const source = await service.link('account', 'acct1', link)
    await service.sync('account', 'acct1', source.id)
    expect(services.rows.get('account|acct1|billing')?.deletedAt).toBeNull()

    // The specs are deleted upstream; only prose is left behind.
    delete github.files['specs/openapi.yaml']
    github.files['specs/README.md'] = { sha: 'b', content: '# moved elsewhere' }
    const result = await service.sync('account', 'acct1', source.id)

    // A folder that no longer holds contracts retires its service, exactly as `directory` mode
    // retires a directory that lost its `service.md` — and the pin advances, so it stays retired.
    expect(result.tombstoned).toBe(1)
    expect(services.rows.get('account|acct1|billing')?.deletedAt).not.toBeNull()
    expect(contracts.rows).toEqual([])
    expect(sources.rows.get(source.id)?.lastSyncedCommit).toBe(result.lastSyncedCommit)
    expect(result.lastSyncedCommit).not.toBeNull()
  })

  // The transient counterpart — candidates found, none of them usable — is pinned by "keeps a
  // prior service alive when the whole folder reads back unusable" above, which asserts the
  // opposite disposition on the same two observables (no tombstone, pin left behind).
})

describe('FoundationalServiceSourceService — folder mode, truncation', () => {
  it('reports a capped walk on the result and still pins the commit', async () => {
    // More contract files than one scan may take, all in the folder root.
    const files: Record<string, FileEntry> = {}
    for (let i = 0; i < MAX_FOLDER_CONTRACT_FILES + 5; i++) {
      files[`specs/s${String(i).padStart(3, '0')}.yaml`] = {
        sha: `sha${i}`,
        content: OPENAPI(`Spec ${i}`, `/r${i}`),
      }
    }
    const github = fakeGitHub(files)
    const { service, contracts, sources } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.folderScan).toBe('truncated')
    expect(contracts.rows).toHaveLength(MAX_FOLDER_CONTRACT_FILES)
    // Truncation is a STABLE outcome, so the pin advances: a re-read would truncate identically
    // and the source would otherwise look permanently behind while serving what it already serves.
    expect(sources.rows.get(source.id)?.lastSyncedCommit).toBe(result.lastSyncedCommit)
    expect(result.lastSyncedCommit).not.toBeNull()
  })

  it('keeps the service when a cap stops the walk BEFORE it reaches any candidate', async () => {
    // The folder starts with one spec, so the service exists and the commit is pinned.
    const github = fakeGitHub({ 'specs/openapi.yaml': { sha: 'a', content: OPENAPI('B', '/i') } })
    const { service, services, sources } = makeService(github)
    const source = await service.link('account', 'acct1', { ...link, recursive: true })
    await service.sync('account', 'acct1', source.id)
    const pinned = sources.rows.get(source.id)?.lastSyncedCommit

    // The specs move under a wide tree: more first-level directories than the walk may list,
    // and every contract sits one level BELOW them. The walk therefore spends its whole
    // directory budget without reaching a single candidate — "found nothing" is a statement
    // about the walk here, not about the folder.
    delete github.files['specs/openapi.yaml']
    for (let i = 0; i < MAX_FOLDER_SCAN_DIRECTORIES + 10; i++) {
      github.files[`specs/d${String(i).padStart(3, '0')}/deep/openapi.yaml`] = {
        sha: `sha${i}`,
        content: OPENAPI(`Spec ${i}`, `/r${i}`),
      }
    }
    const result = await service.sync('account', 'acct1', source.id)

    expect(result.folderScan).toBe('truncated')
    // The absence of evidence is not evidence: retiring the service here would strip a
    // capability from every later design on the strength of directories we declined to list...
    expect(result.tombstoned).toBe(0)
    expect(services.rows.get('account|acct1|billing')?.deletedAt).toBeNull()
    // ...and pinning would make it STAY retired, since the next probe would see no change.
    expect(sources.rows.get(source.id)?.lastSyncedCommit).toBe(pinned)
  })
})

// "The folder holds no contracts" and "the folder is not there" both arrive as zero contracts
// and need opposite reactions from a human, so they are reported apart. Git cannot store an
// empty directory, which is what makes the difference observable at all.
describe('FoundationalServiceSourceService — folder mode, a folder that is not there', () => {
  it('reports a folder that vanished upstream as missing', async () => {
    const github = fakeGitHub({ 'specs/openapi.yaml': { sha: 'a', content: OPENAPI('B', '/i') } })
    const { service, services } = makeService(github)
    const source = await service.link('account', 'acct1', link)
    await service.sync('account', 'acct1', source.id)

    // The whole folder is renamed away — nothing under `specs/` remains.
    delete github.files['specs/openapi.yaml']
    github.files['specifications/openapi.yaml'] = { sha: 'a', content: OPENAPI('B', '/i') }
    const result = await service.sync('account', 'acct1', source.id)

    // The service still retires (the folder it described is gone), but the result NAMES the
    // cause, so the toast and the log can tell a moved folder from an emptied one.
    expect(result.folderScan).toBe('missing')
    expect(result.tombstoned).toBe(1)
    expect(services.rows.get('account|acct1|billing')?.deletedAt).not.toBeNull()
  })

  it('reports a link whose folder never existed, rather than a clean no-op', async () => {
    // A mistyped path on a fresh link: the head probe finds no commit, so the walk never runs
    // and the pass short-circuits. Without a report this syncs "successfully" forever.
    const github = fakeGitHub({ 'specs/openapi.yaml': { sha: 'a', content: OPENAPI('B', '/i') } })
    const { service } = makeService(github)
    const source = await service.link('account', 'acct1', { ...link, dirPath: 'sepcs' })

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.folderScan).toBe('missing')
    expect(result).toMatchObject({ upserted: 0, tombstoned: 0 })
  })

  it('leaves the non-folder modes reporting no scan at all', async () => {
    const github = fakeGitHub({ 'specs/openapi.yaml': { sha: 'a', content: OPENAPI('B', '/i') } })
    const { service } = makeService(github)
    const source = await service.link('account', 'acct1', {
      repoOwner: 'acme',
      repoName: 'platform',
      mode: 'files',
      filePaths: ['specs/openapi.yaml'],
      serviceId: 'billing',
      serviceName: 'Billing',
    })

    const result = await service.sync('account', 'acct1', source.id)

    // Null is not "complete": a `files` source did not scan a folder completely, it never
    // scanned one, and a UI that renders the two the same would invent a walk that never ran.
    expect(result.folderScan).toBeNull()
    expect(result.upserted).toBe(1)
  })
})

describe('FoundationalServiceSourceService — files mode, a contract MODULE graph', () => {
  const linkFiles = (paths: string[]) => ({
    repoOwner: 'acme',
    repoName: 'platform',
    mode: 'files' as const,
    filePaths: paths,
    serviceId: 'billing',
    serviceName: 'Billing',
  })

  it('keeps a linked module the contract imports, instead of dropping it as unrecognised', async () => {
    // A `@toad-contracts/core` contract is a module GRAPH and only its entry point names the
    // library. Dropping the schema half leaves a coder holding imports that point at nothing.
    const github = fakeGitHub({
      'src/contracts.ts': {
        sha: 'a',
        content: "import { defineApiContract } from '@toad-contracts/core'\nexport const c = 1\n",
      },
      'src/schemas.ts': { sha: 'b', content: "import * as v from 'valibot'\nexport const s = 1\n" },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link(
      'account',
      'acct1',
      linkFiles(['src/contracts.ts', 'src/schemas.ts']),
    )

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.skippedFiles).toBe(0)
    expect(contracts.rows.map((c) => c.contractId).sort()).toEqual(['contracts', 'schemas'])
    expect(contracts.rows.every((c) => c.format === 'toad-contract')).toBe(true)
  })

  it('admits a supporting module linked BEFORE the contract that vouches for it', async () => {
    // The set's format is decided over every readable file, not left to right: a link that
    // happens to list the schemas first must not lose them.
    const github = fakeGitHub({
      'src/a-schemas.ts': { sha: 'a', content: "import * as v from 'valibot'\n" },
      'src/b-contracts.ts': {
        sha: 'b',
        content: "import { defineApiContract } from '@toad-contracts/core'\n",
      },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link(
      'account',
      'acct1',
      linkFiles(['src/a-schemas.ts', 'src/b-contracts.ts']),
    )

    await service.sync('account', 'acct1', source.id)

    expect(contracts.rows).toHaveLength(2)
  })

  it('refuses to guess when the linked set mixes two contract libraries', async () => {
    // With both libraries present there is no telling which one an unrecognised module supports,
    // and attaching it to the wrong contract is worse than reporting it skipped.
    const github = fakeGitHub({
      'src/toad.ts': { sha: 'a', content: "import '@toad-contracts/core'\n" },
      'src/lokalise.ts': { sha: 'b', content: "import '@lokalise/api-contract'\n" },
      'src/schemas.ts': { sha: 'c', content: "import * as v from 'valibot'\n" },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link(
      'account',
      'acct1',
      linkFiles(['src/toad.ts', 'src/lokalise.ts', 'src/schemas.ts']),
    )

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.skippedFiles).toBe(1)
    expect(contracts.rows.map((c) => c.contractId).sort()).toEqual(['lokalise', 'toad'])
  })

  it('does NOT admit supporting modules in a folder scan, which walks paths nobody named', async () => {
    // One recursive link would otherwise sweep a repo's TypeScript into an agent's context as
    // "contracts". The explicit file list is what makes the relaxation safe, and only there.
    const github = fakeGitHub({
      'specs/contracts.ts': { sha: 'a', content: "import '@toad-contracts/core'\n" },
      'specs/helper.ts': { sha: 'b', content: 'export const helper = 1\n' },
    })
    const { service, contracts } = makeService(github)
    const source = await service.link('account', 'acct1', link)

    const result = await service.sync('account', 'acct1', source.id)

    expect(result.skippedFiles).toBe(1)
    expect(contracts.rows.map((c) => c.contractId)).toEqual(['contracts'])
  })
})
