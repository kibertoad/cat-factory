import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  GroupCacheHandle,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { ResolvedFoundationalService } from '@cat-factory/contracts'
import {
  ConflictError,
  ValidationError,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FoundationalServiceCatalogService } from './FoundationalServiceCatalogService.js'

// In-memory doubles for the two repositories. They implement only what the service calls, and
// they are deliberately dumb — the cross-runtime behaviour of the real stores is pinned by the
// conformance suite, so what these tests are for is the SERVICE's rules: the tier merge, the
// manifest/document split, and the write-boundary refusals.

const OPENAPI = 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n    post: {}\n'

function serviceRepo(seed: FoundationalServiceRecord[] = []): FoundationalServiceRepository {
  const rows = new Map(seed.map((r) => [`${r.ownerKind}:${r.ownerId}:${r.serviceId}`, r]))
  return {
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
    hardDelete: async (ownerKind, ownerId, serviceId) => {
      rows.delete(`${ownerKind}:${ownerId}:${serviceId}`)
    },
    listBySource: async (sourceId) => [...rows.values()].filter((r) => r.sourceId === sourceId),
    softDeleteBySource: async (sourceId, at) => {
      for (const [key, row] of rows) {
        if (row.sourceId === sourceId) rows.set(key, { ...row, deletedAt: at })
      }
    },
  }
}

function contractRepo(seed: ApiContractRecord[] = []): ApiContractRepository {
  let rows = [...seed]
  return {
    listManifestByOwner: async (ownerKind, ownerId) =>
      rows
        .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
        .map(
          (r): ApiContractManifestEntry => ({
            serviceId: r.serviceId,
            contractId: r.contractId,
            format: r.format,
            title: r.title,
            size: r.body.length,
            operations: r.operations,
            omittedOperations: r.omittedOperations,
            sourcePath: r.sourcePath,
          }),
        ),
    listByServiceIds: async (ownerKind, ownerId, serviceIds) =>
      serviceIds.length === 0
        ? []
        : rows.filter(
            (r) =>
              r.ownerKind === ownerKind &&
              r.ownerId === ownerId &&
              serviceIds.includes(r.serviceId),
          ),
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
}

const workspaces = (accountId: string | null): WorkspaceRepository =>
  ({ accountOf: async () => accountId }) as unknown as WorkspaceRepository

function record(
  ownerKind: 'account' | 'workspace',
  ownerId: string,
  serviceId: string,
  overrides: Partial<FoundationalServiceRecord> = {},
): FoundationalServiceRecord {
  return {
    serviceId,
    ownerKind,
    ownerId,
    name: serviceId,
    summary: `${serviceId} summary`,
    description: '',
    capabilities: [],
    sourceId: null,
    sourcePath: null,
    pinnedCommit: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

function contract(
  ownerKind: 'account' | 'workspace',
  ownerId: string,
  serviceId: string,
  overrides: Partial<ApiContractRecord> = {},
): ApiContractRecord {
  return {
    ownerKind,
    ownerId,
    serviceId,
    contractId: 'openapi',
    format: 'openapi',
    title: `${ownerKind} contract`,
    body: OPENAPI,
    operations: ['GET /files', 'POST /files'],
    omittedOperations: 0,
    sourcePath: null,
    sourceSha: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const clock = { now: () => 42 }

describe('FoundationalServiceCatalogService.resolve', () => {
  it('merges the tiers with the workspace winning by id', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([
        record('account', 'acct', 'file-storage', { name: 'Org storage' }),
        record('account', 'acct', 'notifications'),
        record('workspace', 'ws', 'file-storage', { name: 'Board storage' }),
      ]),
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    const resolved = await service.resolve('ws')
    expect(resolved.map((s) => [s.id, s.name, s.tier])).toEqual([
      ['file-storage', 'Board storage', 'workspace'],
      ['notifications', 'notifications', 'account'],
    ])
  })

  it('lets a workspace TOMBSTONE suppress an inherited account service', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([
        record('account', 'acct', 'file-storage'),
        record('workspace', 'ws', 'file-storage', { deletedAt: 9 }),
      ]),
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    expect(await service.resolve('ws')).toEqual([])
  })

  it('joins the contract MANIFEST without loading a body', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([record('account', 'acct', 'file-storage')]),
      apiContractRepository: contractRepo([contract('account', 'acct', 'file-storage')]),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    const [entry] = await service.resolve('ws')
    expect(entry?.contracts[0]?.operations).toEqual(['GET /files', 'POST /files'])
    expect(entry?.contracts[0]?.size).toBe(OPENAPI.length)
    expect(JSON.stringify(entry)).not.toContain('openapi: 3.0.3')
  })

  it('resolves an accountless workspace against its own tier alone', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([record('workspace', 'ws', 'audit')]),
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces(null),
      clock,
    })
    expect((await service.resolve('ws')).map((s) => s.id)).toEqual(['audit'])
  })
})

describe('FoundationalServiceCatalogService.contractsFor', () => {
  it('serves the WINNING tier’s documents, never the shadowed tier’s', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([
        record('account', 'acct', 'file-storage'),
        record('workspace', 'ws', 'file-storage'),
      ]),
      apiContractRepository: contractRepo([
        contract('account', 'acct', 'file-storage'),
        contract('workspace', 'ws', 'file-storage'),
      ]),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    const docs = await service.contractsFor('ws', ['file-storage'])
    expect(docs.get('file-storage')?.map((d) => d.title)).toEqual(['workspace contract'])
  })

  it('returns an EMPTY set for a workspace override that ships no contract of its own', async () => {
    // The override must not silently inherit the account's documents — that would read as a
    // partially-applied override rather than as a service whose interface nobody supplied.
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([
        record('account', 'acct', 'file-storage'),
        record('workspace', 'ws', 'file-storage'),
      ]),
      apiContractRepository: contractRepo([contract('account', 'acct', 'file-storage')]),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    expect((await service.contractsFor('ws', ['file-storage'])).get('file-storage')).toEqual([])
  })

  it('omits an id the catalog does not contain, and reads nothing for an empty ask', async () => {
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo([record('account', 'acct', 'file-storage')]),
      apiContractRepository: contractRepo([contract('account', 'acct', 'file-storage')]),
      workspaceRepository: workspaces('acct'),
      clock,
    })
    const docs = await service.contractsFor('ws', ['file-storage', 'imaginary-bus'])
    expect([...docs.keys()]).toEqual(['file-storage'])
    expect((await service.contractsFor('ws', [])).size).toBe(0)
  })
})

describe('FoundationalServiceCatalogService writes', () => {
  const build = (seed: FoundationalServiceRecord[] = []) =>
    new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo(seed),
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces('acct'),
      clock,
    })

  it('indexes an uploaded OpenAPI document’s operations at write time', async () => {
    const created = await build().create('account', 'acct', {
      id: 'file-storage',
      name: 'File Storage',
      summary: 'Stores uploads.',
      description: '',
      contracts: [{ contractId: 'openapi', format: 'openapi', title: 'HTTP API', body: OPENAPI }],
    })
    expect(created.contracts[0]?.operations).toEqual(['GET /files', 'POST /files'])
  })

  it('refuses an upload whose body does not match its declared format', async () => {
    await expect(
      build().create('account', 'acct', {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'Stores uploads.',
        description: '',
        contracts: [
          { contractId: 'openapi', format: 'openapi', title: 'HTTP API', body: 'swagger: "2.0"' },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses a duplicate contract id rather than silently keeping one', async () => {
    const upload = { format: 'openapi' as const, title: 'HTTP API', body: OPENAPI }
    await expect(
      build().create('account', 'acct', {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'Stores uploads.',
        description: '',
        contracts: [
          { contractId: 'openapi', ...upload },
          { contractId: 'openapi', ...upload },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('conflicts on a LIVE id but revives a tombstoned one', async () => {
    const input = {
      id: 'file-storage',
      name: 'File Storage',
      summary: 'Stores uploads.',
      description: '',
    }
    await expect(
      build([record('account', 'acct', 'file-storage')]).create('account', 'acct', input),
    ).rejects.toBeInstanceOf(ConflictError)

    const revived = await build([
      record('account', 'acct', 'file-storage', { deletedAt: 5 }),
    ]).create('account', 'acct', input)
    expect(revived.id).toBe('file-storage')
  })
})

describe('FoundationalServiceCatalogService suppression', () => {
  const build = (seed: FoundationalServiceRecord[]) =>
    new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo(seed),
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces('acct'),
      clock,
    })

  it('drops an inherited account service out of the board’s catalog', async () => {
    const service = build([
      record('account', 'acct', 'file-storage'),
      record('account', 'acct', 'notifications'),
    ])
    await service.suppress('workspace', 'ws', 'file-storage')
    expect((await service.resolve('ws')).map((s) => s.id)).toEqual(['notifications'])
  })

  it('is idempotent, so a retried suppression is not a 404', async () => {
    const service = build([record('account', 'acct', 'file-storage')])
    await service.suppress('workspace', 'ws', 'file-storage')
    // The id is no longer in the merged catalog, so the "is it inherited?" check cannot answer
    // this case — the already-suppressed short-circuit is what keeps the endpoint retry-safe.
    await expect(service.suppress('workspace', 'ws', 'file-storage')).resolves.toBeUndefined()
  })

  it('refuses an id nothing in the catalog carries', async () => {
    // A tombstone here would suppress whatever the account registers under the id LATER, with
    // nothing on either tier explaining why the service never appeared.
    await expect(build([]).suppress('workspace', 'ws', 'file-storage')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('refuses to suppress the board’s OWN registration, steering to delete instead', async () => {
    const service = build([
      record('account', 'acct', 'file-storage'),
      record('workspace', 'ws', 'file-storage', { name: 'Board storage' }),
    ])
    await expect(service.suppress('workspace', 'ws', 'file-storage')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('restores inheritance by DROPPING the tombstone, not by reviving it', async () => {
    const service = build([record('account', 'acct', 'file-storage', { name: 'Org storage' })])
    await service.suppress('workspace', 'ws', 'file-storage')
    await service.restoreInherited('workspace', 'ws', 'file-storage')

    // Reviving the tombstone instead would leave an empty workspace row WINNING the merge; the
    // account entry, name and all, is what must come back.
    const restored = await service.resolve('ws')
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: 'file-storage', name: 'Org storage', tier: 'account' })
  })

  it('decides both refusals against a FRESH merge, never the cached one agents read', async () => {
    // A cache pinned to an EMPTY catalog, standing in for a TTL'd entry that has not yet caught
    // up with the account registering the service. Deciding off it would 404 a legitimate opt-out
    // — and in the mirror case, write a tombstone against an id the account has since withdrawn,
    // which is the shadows-nothing row the 404 exists to prevent.
    let cacheReads = 0
    const stale: GroupCacheHandle<ResolvedFoundationalService[]> = {
      get: async () => {
        cacheReads++
        return []
      },
      invalidate: async () => undefined,
      invalidateGroup: async () => undefined,
      invalidateAll: async () => undefined,
    }
    const repository = serviceRepo([record('account', 'acct', 'file-storage')])
    const service = new FoundationalServiceCatalogService({
      foundationalServiceRepository: repository,
      apiContractRepository: contractRepo(),
      workspaceRepository: workspaces('acct'),
      clock,
      catalogCache: stale,
    })

    await expect(service.suppress('workspace', 'ws', 'file-storage')).resolves.toBeUndefined()
    expect(await repository.get('workspace', 'ws', 'file-storage')).toMatchObject({
      deletedAt: clock.now(),
    })
    // The cache was never consulted for the decision; `resolve` remains free to use it.
    expect(cacheReads).toBe(0)
  })

  it('refuses to restore where the tier is not suppressing anything', async () => {
    // A LIVE workspace row is an override, not a suppression — hard-deleting it here would
    // silently destroy the board's authored description and contracts.
    const service = build([
      record('account', 'acct', 'file-storage'),
      record('workspace', 'ws', 'file-storage'),
    ])
    await expect(service.restoreInherited('workspace', 'ws', 'file-storage')).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    )
    await expect(service.restoreInherited('workspace', 'ws', 'audit')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('FoundationalServiceCatalogService builtin tier', () => {
  const definition = {
    id: 'file-storage',
    name: 'File Storage',
    summary: 'The org file storage.',
    description: 'Use for any binary blob.',
    capabilities: ['asset-storage'],
    contracts: [
      { contractId: 'http', format: 'openapi' as const, title: 'HTTP API', body: OPENAPI },
    ],
  }

  const build = (seed: FoundationalServiceRecord[] = [], contracts: ApiContractRecord[] = []) => {
    const registry = defaultFoundationalServiceRegistry()
    registry.register(definition)
    return new FoundationalServiceCatalogService({
      foundationalServiceRepository: serviceRepo(seed),
      apiContractRepository: contractRepo(contracts),
      workspaceRepository: workspaces('acct'),
      clock,
      registry,
    })
  }

  it('resolves a deployment-registered service with no rows anywhere', () => {
    // The whole point of the tier: a fresh workspace designs against the org estate on its first
    // request, with nothing seeded and nothing to drift from the definitions.
    return build()
      .resolve('ws')
      .then((catalog) => {
        expect(catalog).toHaveLength(1)
        expect(catalog[0]).toMatchObject({ id: 'file-storage', tier: 'builtin' })
        expect(catalog[0]?.contracts[0]?.operations).toEqual(['GET /files', 'POST /files'])
      })
  })

  it('serves a builtin winner’s documents from the registry, not the store', async () => {
    const documents = await build().contractsFor('ws', ['file-storage'])
    expect(documents.get('file-storage')?.[0]?.body).toBe(OPENAPI)
  })

  it('lets an account row override a builtin by id, documents included', async () => {
    const service = build(
      [record('account', 'acct', 'file-storage', { name: 'Org storage' })],
      [contract('account', 'acct', 'file-storage', { body: 'openapi: 3.0.3\npaths: {}\n' })],
    )
    const [entry] = await service.resolve('ws')
    expect(entry).toMatchObject({ id: 'file-storage', name: 'Org storage', tier: 'account' })
    const documents = await service.contractsFor('ws', ['file-storage'])
    expect(documents.get('file-storage')?.[0]?.body).toBe('openapi: 3.0.3\npaths: {}\n')
  })

  it('lets an ACCOUNT opt out of a builtin, for every board under it', async () => {
    // Without this an account has no way to decline a service the deployment registered, and the
    // only remedy is suppressing it board by board, forever, including on boards created later.
    const service = build()
    await service.suppress('account', 'acct', 'file-storage')
    expect(await service.resolve('ws')).toEqual([])
    expect(await service.listSuppressions('account', 'acct')).toEqual([
      {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'The org file storage.',
        inherited: true,
      },
    ])
  })

  it('lets a BOARD opt out of a builtin without touching the account', async () => {
    const service = build()
    await service.suppress('workspace', 'ws', 'file-storage')
    expect(await service.resolve('ws')).toEqual([])
    const suppressions = await service.listSuppressions('workspace', 'ws')
    expect(suppressions[0]).toMatchObject({ id: 'file-storage', inherited: true })
  })

  it('refuses to suppress a builtin at a tier that has overridden it', async () => {
    // That is a delete of the tier's own row wearing a suppression's clothes, and it would
    // destroy the authored description and contracts the tier registered.
    const service = build([record('account', 'acct', 'file-storage')])
    await expect(service.suppress('account', 'acct', 'file-storage')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('restores a suppressed builtin by dropping the tombstone', async () => {
    const service = build()
    await service.suppress('workspace', 'ws', 'file-storage')
    await service.restoreInherited('workspace', 'ws', 'file-storage')
    expect((await service.resolve('ws')).map((s) => s.tier)).toEqual(['builtin'])
  })

  it("says a board's opt-out shadows NOTHING once the account has opted out too", async () => {
    // The board suppresses first (it can — the builtin is in its catalog), then the account
    // suppresses the same id for everyone. The board's tombstone now hides a service no board
    // could see, so `inherited` must say so: reading the account's LIVE rows beside the registry
    // reports `true` here, which tells an operator a capability is being withheld when there is
    // none to withhold — the exact distinction this field exists to carry.
    const service = build()
    await service.suppress('workspace', 'ws', 'file-storage')
    await service.suppress('account', 'acct', 'file-storage')

    expect(await service.listSuppressions('workspace', 'ws')).toEqual([
      { id: 'file-storage', name: '', summary: '', inherited: false },
    ])
    // The account's own tombstone still shadows the deployment tier, which is real.
    expect(await service.listSuppressions('account', 'acct')).toEqual([
      {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'The org file storage.',
        inherited: true,
      },
    ])
  })

  it("names a board's suppression from the ACCOUNT's override, not the builtin it replaced", async () => {
    // One precedence, not two: the suppression list must name what the board actually inherits,
    // and an account row of the same id wins over the registry entry there exactly as it does in
    // the merge.
    const service = build([record('account', 'acct', 'file-storage', { name: 'Org storage' })])
    await service.suppress('workspace', 'ws', 'file-storage')
    expect(await service.listSuppressions('workspace', 'ws')).toEqual([
      {
        id: 'file-storage',
        name: 'Org storage',
        summary: 'file-storage summary',
        inherited: true,
      },
    ])
  })
})
