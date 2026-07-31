import type {
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
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
}

/** Assert a runtime's foundational-services repositories behave identically to the others. */
export function defineFoundationalServicesSuite(
  name: string,
  makeRepos: () => FoundationalServiceRepos,
): void {
  describe(`[${name}] foundational-services repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      return `${name}-owner-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

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
      // The tier merge reads WITH tombstones — that is what suppresses an inherited service.
      const withDeleted = await services.listByOwner('account', ownerId, true)
      expect(withDeleted).toHaveLength(1)
      expect(withDeleted[0]?.deletedAt).toBe(5_000)
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
      await sources.upsert(never)
      await sources.upsert(old)
      await sources.upsert(fresh)

      expect(await sources.get(fresh.id)).toEqual(fresh)
      expect((await sources.listByOwner('account', ownerId)).map((s) => s.id).sort()).toEqual(
        [never.id, old.id, fresh.id].sort(),
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
        [never.id, fresh.id].sort(),
      )
      // A tombstoned source is never handed to the sweep, however stale it looks.
      expect((await sources.listStale(70_000, 10)).map((s) => s.id)).not.toContain(old.id)
    })
  })
}
