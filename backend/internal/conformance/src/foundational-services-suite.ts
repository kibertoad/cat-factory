import type {
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the foundational-services catalog (docs/initiatives/
// foundational-services.md; D1 migration 0073 ⇄ the Drizzle mirror). Each facade persists it in
// its own store, and this suite drives the SAME assertions through whichever real repositories a
// runtime hands it — so a differently-mapped column (the capabilities JSON, the stored operation
// index, the tombstone) fails a test instead of shipping.
//
// The two assertions worth naming, because they are the feature's load-bearing properties rather
// than plain round-trips:
//
//  - the MANIFEST read must never transfer a body, and must report a size that matches the body
//    the lazy read returns. A store whose `length()` counted BYTES where the other counted
//    CHARACTERS would pass a naive round-trip and then disagree about every non-ASCII document;
//  - `replaceForService` must REPLACE, so a contract removed upstream disappears rather than
//    lingering beside its successor.

export interface FoundationalServiceRepos {
  services: FoundationalServiceRepository
  contracts: ApiContractRepository
  sources: FoundationalServiceSourceRepository
  /**
   * The workspace's developer-portal connection, whose import produces `workspace`-tier rows in
   * the catalog above. Part of THIS suite rather than one of its own because it is the third
   * supply route into the same tables, and its own store has a cross-runtime trap of exactly the
   * kind this suite exists for (see the `listStale` assertion).
   */
  serviceCatalog: ServiceCatalogConnectionRepository
}

/** Assert a runtime's foundational-services repositories behave identically to the others. */
export function defineFoundationalServicesSuite(
  name: string,
  makeRepos: () => FoundationalServiceRepos,
): void {
  // Hoisted out of the `describe` so BOTH halves draw from one generator: the two register against
  // the same store, and a per-half sequence would mint colliding owner ids.
  let seq = 0
  const scope = () => {
    seq += 1
    return `${name}-owner-${seq}-${Math.floor(Math.random() * 1e9)}`
  }

  describe(`[${name}] foundational-services repository parity`, () => {
    const service = (
      ownerId: string,
      serviceId: string,
      overrides: Partial<FoundationalServiceRecord> = {},
    ): FoundationalServiceRecord => ({
      serviceId,
      ownerKind: 'account',
      ownerId,
      name: 'File Storage',
      summary: 'Stores and serves user uploads.',
      description: 'Use for any binary blob.',
      capabilities: ['file-storage', 'cdn'],
      sourceId: null,
      sourcePath: null,
      pinnedCommit: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      deletedAt: null,
      ...overrides,
    })

    const contract = (
      ownerId: string,
      serviceId: string,
      contractId: string,
      overrides: Partial<ApiContractRecord> = {},
    ): ApiContractRecord => ({
      ownerKind: 'account',
      ownerId,
      serviceId,
      contractId,
      format: 'openapi',
      title: 'HTTP API',
      body: 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n',
      operations: ['GET /files'],
      omittedOperations: 0,
      sourcePath: 'services/file-storage/openapi.yaml',
      sourceSha: 'sha-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      ...overrides,
    })

    it('round-trips a service, lists by owner, and tombstones it', async () => {
      const { services } = makeRepos()
      const ownerId = scope()
      const record = service(ownerId, 'file-storage')
      await services.upsert(record)

      expect(await services.get('account', ownerId, 'file-storage')).toEqual(record)
      expect(await services.listByOwner('account', ownerId)).toEqual([record])
      // Another owner's services are invisible.
      expect(await services.listByOwner('account', scope())).toEqual([])
      // So is the same id at the OTHER tier — the (ownerKind, ownerId) pair is the whole key.
      expect(await services.listByOwner('workspace', ownerId)).toEqual([])

      await services.softDelete('account', ownerId, 'file-storage', 5_000)
      expect(await services.listByOwner('account', ownerId)).toEqual([])
      // The tier merge reads BOTH stored tiers WITH tombstones — that is what suppresses an
      // inherited service, an account opting out of a deployment `builtin` included.
      const withDeleted = await services.listByOwner('account', ownerId, true)
      expect(withDeleted).toHaveLength(1)
      expect(withDeleted[0]?.deletedAt).toBe(5_000)
    })

    it('hard-deletes a suppression row outright, where a tombstone would linger', async () => {
      const { services } = makeRepos()
      const ownerId = scope()
      // The shape `FoundationalServiceCatalogService.suppress` writes at either tier: a tombstone
      // with no content, whose only job is to lose the tier merge. Lifting the suppression must
      // leave the tier saying NOTHING about the id — clearing `deletedAt` instead would revive
      // this as an empty winning override.
      await services.upsert(
        service(ownerId, 'file-storage', {
          ownerKind: 'workspace',
          name: '',
          summary: '',
          description: '',
          capabilities: [],
          deletedAt: 2_000,
        }),
      )
      expect(await services.listByOwner('workspace', ownerId, true)).toHaveLength(1)

      await services.hardDelete('workspace', ownerId, 'file-storage')
      expect(await services.listByOwner('workspace', ownerId, true)).toEqual([])
      expect(await services.get('workspace', ownerId, 'file-storage')).toBeNull()
    })

    it('tombstones every service a source produced, in one write', async () => {
      const { services } = makeRepos()
      const ownerId = scope()
      const sourceId = `${ownerId}-src`
      await services.upsert(service(ownerId, 'file-storage', { sourceId, sourcePath: 'a' }))
      await services.upsert(service(ownerId, 'notifications', { sourceId, sourcePath: 'b' }))
      // A hand-registered service must NOT be swept by the source's retirement.
      await services.upsert(service(ownerId, 'audit'))

      expect(await services.listBySource(sourceId)).toHaveLength(2)
      await services.softDeleteBySource(sourceId, 9_000)
      expect(await services.listBySource(sourceId)).toEqual([])
      expect((await services.listByOwner('account', ownerId)).map((s) => s.serviceId)).toEqual([
        'audit',
      ])
    })

    it('serves the contract MANIFEST without bodies, with a size matching the lazy read', async () => {
      const { contracts } = makeRepos()
      const ownerId = scope()
      // A multi-byte body: a store measuring BYTES rather than characters disagrees here.
      const body = 'openapi: 3.0.3\n# ünïcødé — description\npaths: {}\n'
      await contracts.replaceForService('account', ownerId, 'file-storage', [
        contract(ownerId, 'file-storage', 'openapi', {
          body,
          operations: [],
          omittedOperations: 3,
        }),
      ])

      const manifest = await contracts.listManifestByOwner('account', ownerId)
      expect(manifest).toHaveLength(1)
      expect(manifest[0]?.size).toBe(body.length)
      expect(manifest[0]?.omittedOperations).toBe(3)
      expect(manifest[0]?.sourcePath).toBe('services/file-storage/openapi.yaml')
      // The manifest carries no body at all — the property the whole two-table split exists for.
      expect(manifest[0]).not.toHaveProperty('body')

      const [document] = await contracts.listByServiceIds('account', ownerId, ['file-storage'])
      expect(document?.body).toBe(body)
      expect(document?.body.length).toBe(manifest[0]?.size)
    })

    it('reads documents for a SET of services and ignores ids outside the tier', async () => {
      const { contracts } = makeRepos()
      const ownerId = scope()
      await contracts.replaceForService('account', ownerId, 'file-storage', [
        contract(ownerId, 'file-storage', 'openapi'),
      ])
      await contracts.replaceForService('account', ownerId, 'notifications', [
        contract(ownerId, 'notifications', 'openapi', { title: 'Notify API' }),
      ])
      // Same service id under a DIFFERENT owner must not leak into the read.
      const otherOwner = scope()
      await contracts.replaceForService('account', otherOwner, 'file-storage', [
        contract(otherOwner, 'file-storage', 'openapi', { title: 'Someone else' }),
      ])

      const found = await contracts.listByServiceIds('account', ownerId, [
        'file-storage',
        'notifications',
        'never-registered',
      ])
      expect(found.map((c) => c.serviceId).sort()).toEqual(['file-storage', 'notifications'])
      expect(found.every((c) => c.ownerId === ownerId)).toBe(true)

      // An EMPTY id list must read nothing rather than degenerating into a full-tier read.
      expect(await contracts.listByServiceIds('account', ownerId, [])).toEqual([])
    })

    it('REPLACES a service contract set, dropping what is no longer supplied', async () => {
      const { contracts } = makeRepos()
      const ownerId = scope()
      await contracts.replaceForService('account', ownerId, 'file-storage', [
        contract(ownerId, 'file-storage', 'openapi'),
        contract(ownerId, 'file-storage', 'legacy', { title: 'Legacy API' }),
      ])
      expect(await contracts.listByServiceIds('account', ownerId, ['file-storage'])).toHaveLength(2)

      await contracts.replaceForService('account', ownerId, 'file-storage', [
        contract(ownerId, 'file-storage', 'openapi', { title: 'HTTP API v2' }),
      ])
      const after = await contracts.listByServiceIds('account', ownerId, ['file-storage'])
      expect(after.map((c) => c.contractId)).toEqual(['openapi'])
      expect(after[0]?.title).toBe('HTTP API v2')

      await contracts.deleteForService('account', ownerId, 'file-storage')
      expect(await contracts.listByServiceIds('account', ownerId, ['file-storage'])).toEqual([])
    })

    it('round-trips a repo source and drains the stalest first', async () => {
      const { sources } = makeRepos()
      const ownerId = scope()
      const base: Omit<FoundationalServiceSourceRecord, 'id' | 'dirPath'> = {
        ownerKind: 'account',
        ownerId,
        repoOwner: 'acme',
        repoName: 'platform',
        gitRef: 'HEAD',
        mode: 'directory',
        recursive: false,
        filePaths: [],
        serviceId: null,
        serviceName: null,
        serviceSummary: null,
        lastSyncedCommit: null,
        lastSyncedAt: null,
        createdAt: 1_000,
        deletedAt: null,
      }
      const never: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-never`,
        dirPath: 'foundational',
      }
      const old: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-old`,
        dirPath: 'other',
        lastSyncedCommit: 'c1',
        lastSyncedAt: 10,
      }
      const fresh: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-fresh`,
        dirPath: 'fresh',
        // A `files` source: the fields that only it carries must survive the round trip.
        mode: 'files',
        filePaths: ['api/openapi.yaml', 'api/contracts.ts'],
        serviceId: 'audit',
        serviceName: 'Audit',
        serviceSummary: 'Append-only audit trail.',
        lastSyncedCommit: 'c2',
        lastSyncedAt: 10_000,
      }
      const folder: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-folder`,
        dirPath: 'specs/billing',
        // A recursive `folder` source: `recursive` is the one field the mode adds, and it is a
        // boolean on Postgres against an INTEGER on D1 — so a round trip is what pins the two
        // stores to the same value rather than to `1` on one and `true` on the other.
        mode: 'folder',
        recursive: true,
        serviceId: 'billing',
        serviceName: 'Billing',
        serviceSummary: 'Invoices and subscriptions.',
        lastSyncedCommit: 'c4',
        lastSyncedAt: 20_000,
      }
      await sources.upsert(never)
      await sources.upsert(old)
      await sources.upsert(fresh)
      await sources.upsert(folder)

      expect(await sources.get(fresh.id)).toEqual(fresh)
      expect(await sources.get(folder.id)).toEqual(folder)
      expect((await sources.listByOwner('account', ownerId)).map((s) => s.id).sort()).toEqual(
        [never.id, old.id, fresh.id, folder.id].sort(),
      )

      // The sweep's query: never-synced first, then oldest-synced. The freshly-synced one is
      // outside the window entirely.
      const stale = await sources.listStale(1_000, 10)
      const ids = stale.filter((s) => s.ownerId === ownerId).map((s) => s.id)
      expect(ids).toEqual([never.id, old.id])

      await sources.updateSyncState(never.id, 'c3', 50_000)
      const synced = await sources.get(never.id)
      expect(synced?.lastSyncedCommit).toBe('c3')
      expect(synced?.lastSyncedAt).toBe(50_000)

      await sources.softDelete(old.id, 60_000)
      expect((await sources.listByOwner('account', ownerId)).map((s) => s.id).sort()).toEqual(
        [never.id, fresh.id, folder.id].sort(),
      )
      // A tombstoned source is never handed to the sweep, however stale it looks.
      expect((await sources.listStale(70_000, 10)).map((s) => s.id)).not.toContain(old.id)
    })

    it('finds every tier that linked a repo, skipping tombstones (the push fan-out)', async () => {
      const { sources } = makeRepos()
      const ownerId = scope()
      // A repo name unique to this run: `listByRepo` is deliberately global across tiers, so a
      // shared name would let a sibling test's rows leak into the assertion.
      const repoName = `contracts-${ownerId}`
      const base: Omit<FoundationalServiceSourceRecord, 'id' | 'ownerKind' | 'dirPath'> = {
        ownerId,
        repoOwner: 'acme',
        repoName,
        gitRef: 'main',
        mode: 'directory',
        recursive: false,
        filePaths: [],
        serviceId: null,
        serviceName: null,
        serviceSummary: null,
        lastSyncedCommit: null,
        lastSyncedAt: null,
        createdAt: 1_000,
        deletedAt: null,
      }
      const accountSource: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-acct`,
        ownerKind: 'account',
        dirPath: 'foundational',
      }
      // A DIFFERENT tier linking the same repo: a push delivery names only `owner/name`, so both
      // must come back from the one lookup or the fan-out silently skips a board.
      const workspaceSource: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-ws`,
        ownerKind: 'workspace',
        dirPath: 'boards',
      }
      const unlinked: FoundationalServiceSourceRecord = {
        ...base,
        id: `${ownerId}-gone`,
        ownerKind: 'account',
        dirPath: 'retired',
        deletedAt: 3_000,
      }
      await sources.upsert(accountSource)
      await sources.upsert(workspaceSource)
      await sources.upsert(unlinked)

      const found = await sources.listByRepo('acme', repoName)
      expect(found.map((s) => s.id).sort()).toEqual([accountSource.id, workspaceSource.id].sort())
      // Another repo in the same owner namespace shares nothing.
      expect(await sources.listByRepo('acme', `${repoName}-other`)).toEqual([])
    })

    // The service-catalog CONNECTION's parity lives in its own `describe`, registered by the same
    // entry point below: it is the third supply route into these very tables, so a facade must run
    // it or not run this suite at all, and a separate export would be one more registration to
    // forget (the lesson `check-conformance-group-parity.mjs` exists for).
  })

  defineServiceCatalogConnectionParity(name, makeRepos, scope)
}

/**
 * Cross-runtime parity for the SERVICE CATALOG connection: the developer portal whose services the
 * importer turns into `workspace`-tier catalog rows (backend/docs/service-catalog-import.md).
 *
 * Its own function because the suite above hit its per-function line budget, and this is the
 * cohesive half: one store, read by one importer and one sweep. It takes the caller's `scope`
 * generator rather than minting its own, so both halves stay isolated from each other's rows in
 * the shared store either facade hands them.
 */
function defineServiceCatalogConnectionParity(
  name: string,
  makeRepos: () => FoundationalServiceRepos,
  scope: () => string,
): void {
  describe(`[${name}] service-catalog connection parity`, () => {
    // --- the SERVICE CATALOG connection (the third supply route) --------------------------

    const connection = (
      workspaceId: string,
      overrides: Partial<ServiceCatalogConnectionRecord> = {},
    ): ServiceCatalogConnectionRecord => ({
      workspaceId,
      provider: 'backstage',
      baseUrl: 'https://backstage.example.com',
      authMode: 'static-token',
      credentialsCipher: 'v1.sealed-envelope',
      entityFilter: ['kind=component', 'spec.type=service'],
      includeApis: true,
      maxServices: 200,
      lastSyncedAt: null,
      lastSyncStatus: null,
      lastSyncMessage: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      deletedAt: null,
      ...overrides,
    })

    it('round-trips a service-catalog connection, filter list and flags included', async () => {
      const { serviceCatalog } = makeRepos()
      const workspaceId = scope()
      const record = connection(workspaceId)
      await serviceCatalog.upsert(record)

      // The filter is a JSON array in both stores and the two flags are an INTEGER on one store
      // and a boolean on the other, which is exactly where a mapping drifts unnoticed.
      expect(await serviceCatalog.get(workspaceId)).toEqual(record)
      expect(await serviceCatalog.get(scope())).toBeNull()
    })

    it('stamps a sync verdict without touching the credential envelope', async () => {
      const { serviceCatalog } = makeRepos()
      const workspaceId = scope()
      await serviceCatalog.upsert(connection(workspaceId))

      await serviceCatalog.updateSyncState(workspaceId, {
        lastSyncedAt: 9_000,
        lastSyncStatus: 'partial',
        lastSyncMessage: 'The import stopped at the configured service cap.',
      })

      const stamped = await serviceCatalog.get(workspaceId)
      expect(stamped?.lastSyncStatus).toBe('partial')
      expect(stamped?.lastSyncMessage).toBe('The import stopped at the configured service cap.')
      // The load-bearing half: an import runs where the request landed, which in mothership mode
      // is a node holding no key to RE-seal with. A stamp that rewrote this would replace a
      // readable envelope with an unreadable one.
      expect(stamped?.credentialsCipher).toBe('v1.sealed-envelope')
    })

    it('tombstones a disconnected connection and forgets its credential', async () => {
      const { serviceCatalog } = makeRepos()
      const workspaceId = scope()
      await serviceCatalog.upsert(connection(workspaceId))

      await serviceCatalog.softDelete(workspaceId, 7_000)

      const gone = await serviceCatalog.get(workspaceId)
      expect(gone?.deletedAt).toBe(7_000)
      expect(gone?.credentialsCipher).toBe('')
    })

    // `listStale` is UNSCOPED across workspaces by construction (it is a sweep query), so these
    // two assert only over the rows they created: the returned order is read back through a
    // filter, which preserves relative order while making the assertions independent of whatever
    // other connections this shared store holds.
    it('lists a NEVER-imported connection ahead of an already-imported one', async () => {
      const { serviceCatalog } = makeRepos()
      const fresh = scope()
      const imported = scope()
      const tombstoned = scope()
      const mine = new Set([fresh, imported, tombstoned])
      await serviceCatalog.upsert(connection(fresh))
      await serviceCatalog.upsert(connection(imported, { lastSyncedAt: 500 }))
      await serviceCatalog.upsert(connection(tombstoned, { deletedAt: 100 }))

      // A limit far above the number of rows any one of these tests creates, so the window this
      // reads is not the thing under test; the ORDER within it is.
      const stale = await serviceCatalog.listStale(1_000, 500)
      const ids = stale.map((row) => row.workspaceId).filter((id) => mine.has(id))

      // The trap this assertion exists for: SQLite orders NULLs LOW on an ascending sort and
      // Postgres orders them HIGH, so a `last_synced_at ASC` with no explicit NULLS clause puts a
      // never-imported connection first on one facade and last on the other. On the second, a
      // freshly connected portal would wait out a staleness window it has never been inside
      // whenever the batch is full, a drift nothing else fails on.
      expect(ids).toEqual([fresh, imported])
      // A disconnected connection is not refreshed at all.
      expect(ids).not.toContain(tombstoned)
    })

    it('bounds the stale batch and skips a connection imported inside the window', async () => {
      const { serviceCatalog } = makeRepos()
      const recent = scope()
      const stale = scope()
      await serviceCatalog.upsert(connection(recent, { lastSyncedAt: 5_000 }))
      await serviceCatalog.upsert(connection(stale, { lastSyncedAt: 10 }))

      const found = await serviceCatalog.listStale(1_000, 500)
      const ids = found.map((row) => row.workspaceId)
      expect(ids).toContain(stale)
      // Imported more recently than the window: the sweep must not re-import it.
      expect(ids).not.toContain(recent)
      // Bounded, so a deployment with hundreds of connections spreads the work across ticks
      // instead of paging every portal in one pass.
      expect(await serviceCatalog.listStale(1_000, 1)).toHaveLength(1)
    })
  })
}
