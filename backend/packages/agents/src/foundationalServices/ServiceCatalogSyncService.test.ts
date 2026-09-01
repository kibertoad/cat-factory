import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  ServiceCatalogClient,
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
  ServiceCatalogEntry,
  ServiceCatalogFetch,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SERVICE_CATALOG_SOURCE_ID,
  ServiceCatalogSyncService,
  describeImport,
} from './ServiceCatalogSyncService.js'

const WORKSPACE = 'ws-1'

function connectionRepo(seed?: Partial<ServiceCatalogConnectionRecord>): {
  repo: ServiceCatalogConnectionRepository
  row: () => ServiceCatalogConnectionRecord | null
} {
  let row: ServiceCatalogConnectionRecord | null =
    seed === undefined
      ? null
      : {
          workspaceId: WORKSPACE,
          provider: 'backstage',
          baseUrl: 'https://backstage.example.com',
          authMode: 'static-token',
          credentialsCipher: 'v1.sealed',
          entityFilter: ['kind=component'],
          includeApis: true,
          maxServices: 200,
          lastSyncedAt: null,
          lastSyncStatus: null,
          lastSyncMessage: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          ...seed,
        }
  return {
    row: () => row,
    repo: {
      get: async () => row,
      upsert: async (record) => {
        row = record
      },
      updateSyncState: async (_workspaceId, state) => {
        if (row) row = { ...row, ...state }
      },
      softDelete: async (_workspaceId, at) => {
        if (row) row = { ...row, deletedAt: at }
      },
      listStale: async () => (row && row.deletedAt === null ? [row] : []),
    },
  }
}

function serviceRepo(seed: FoundationalServiceRecord[] = []): {
  repo: FoundationalServiceRepository
  rows: () => FoundationalServiceRecord[]
} {
  let rows = [...seed]
  return {
    rows: () => rows,
    repo: {
      listByOwner: async (ownerKind, ownerId, includeDeleted) =>
        rows.filter(
          (r) =>
            r.ownerKind === ownerKind &&
            r.ownerId === ownerId &&
            (includeDeleted || r.deletedAt === null),
        ),
      get: async (ownerKind, ownerId, serviceId) =>
        rows.find(
          (r) => r.ownerKind === ownerKind && r.ownerId === ownerId && r.serviceId === serviceId,
        ) ?? null,
      upsert: async (record) => {
        rows = [...rows.filter((r) => r.serviceId !== record.serviceId), record]
      },
      upsertMany: async (records) => {
        const written = new Set(records.map((r) => r.serviceId))
        rows = [...rows.filter((r) => !written.has(r.serviceId)), ...records]
      },
      softDelete: async (_ownerKind, _ownerId, serviceId, at) => {
        rows = rows.map((r) => (r.serviceId === serviceId ? { ...r, deletedAt: at } : r))
      },
      softDeleteByIds: async (_ownerKind, _ownerId, serviceIds, at) => {
        rows = rows.map((r) => (serviceIds.includes(r.serviceId) ? { ...r, deletedAt: at } : r))
      },
      hardDelete: async (_ownerKind, _ownerId, serviceId) => {
        rows = rows.filter((r) => r.serviceId !== serviceId)
      },
      listBySource: async (sourceId) => rows.filter((r) => r.sourceId === sourceId),
      softDeleteBySource: async (sourceId, at) => {
        rows = rows.map((r) => (r.sourceId === sourceId ? { ...r, deletedAt: at } : r))
      },
    },
  }
}

function contractRepo(seed: ApiContractRecord[] = []): {
  repo: ApiContractRepository
  rows: () => ApiContractRecord[]
} {
  let rows = [...seed]
  return {
    rows: () => rows,
    repo: {
      listManifestByOwner: async (ownerKind, ownerId) =>
        rows
          .filter((r) => r.ownerKind === ownerKind && r.ownerId === ownerId)
          .map((r): ApiContractManifestEntry => ({
            serviceId: r.serviceId,
            contractId: r.contractId,
            format: r.format,
            title: r.title,
            size: r.body.length,
            operations: r.operations,
            omittedOperations: r.omittedOperations,
            sourcePath: r.sourcePath,
            sourceSha: r.sourceSha,
          })),
      listByServiceIds: async (_ownerKind, _ownerId, serviceIds) =>
        rows.filter((r) => serviceIds.includes(r.serviceId)),
      replaceForService: async (_ownerKind, _ownerId, serviceId, contracts) => {
        rows = [...rows.filter((r) => r.serviceId !== serviceId), ...contracts]
      },
      replaceForServices: async (_ownerKind, _ownerId, sets) => {
        const replaced = new Set(sets.map((set) => set.serviceId))
        rows = [
          ...rows.filter((r) => !replaced.has(r.serviceId)),
          ...sets.flatMap((set) => set.contracts),
        ]
      },
      deleteForService: async (_ownerKind, _ownerId, serviceId) => {
        rows = rows.filter((r) => r.serviceId !== serviceId)
      },
      deleteForServices: async (_ownerKind, _ownerId, serviceIds) => {
        rows = rows.filter((r) => !serviceIds.includes(r.serviceId))
      },
    },
  }
}

const entry = (overrides: Partial<ServiceCatalogEntry> = {}): ServiceCatalogEntry => ({
  id: 'orders',
  name: 'Orders',
  summary: 'Places and tracks orders.',
  description: 'Owner: payments (group:default/payments)',
  capabilities: ['service'],
  ref: 'component:default/orders',
  apis: [],
  ...overrides,
})

function client(fetched: Partial<ServiceCatalogFetch> = {}): ServiceCatalogClient {
  return {
    provider: 'backstage',
    fetchCatalog: async () => ({
      entries: [],
      coverage: 'complete',
      skippedEntries: 0,
      skippedApis: 0,
      ...fetched,
    }),
    probe: async () => ({ ok: true }),
  }
}

function failingClient(error: Error): ServiceCatalogClient {
  return {
    provider: 'backstage',
    fetchCatalog: async () => {
      throw error
    },
    probe: async () => ({ ok: false }),
  }
}

describe('ServiceCatalogSyncService.sync', () => {
  let now = 5_000
  beforeEach(() => {
    now = 5_000
  })

  const build = (parts: {
    connection: ReturnType<typeof connectionRepo>
    services?: ReturnType<typeof serviceRepo>
    contracts?: ReturnType<typeof contractRepo>
    catalogClient?: ServiceCatalogClient
    invalidated?: string[]
  }) => {
    const services = parts.services ?? serviceRepo()
    const contracts = parts.contracts ?? contractRepo()
    const service = new ServiceCatalogSyncService({
      serviceCatalogConnectionRepository: parts.connection.repo,
      resolveServiceCatalogClient: async () => parts.catalogClient ?? client(),
      foundationalServiceRepository: services.repo,
      apiContractRepository: contracts.repo,
      clock: { now: () => now },
      ...(parts.invalidated
        ? {
            invalidateCatalog: async (_ownerKind, ownerId) => {
              parts.invalidated?.push(ownerId)
            },
          }
        : {}),
    })
    return { service, services, contracts }
  }

  it('refuses when the workspace has no connection', async () => {
    const { service } = build({ connection: connectionRepo() })
    // An empty result here would report a successful import of nothing from a portal that is not
    // configured at all.
    await expect(service.sync(WORKSPACE)).rejects.toThrow(/not found/i)
  })

  it('writes an imported service under the catalog source id', async () => {
    const invalidated: string[] = []
    const { service, services, contracts } = build({
      connection: connectionRepo({}),
      catalogClient: client({
        entries: [
          entry({
            apis: [
              {
                id: 'orders-api',
                title: 'Orders API',
                format: 'openapi',
                definition: 'openapi: 3.0.3\npaths:\n  /orders:\n    get: {}\n',
                ref: 'api:default/orders-api',
                revision: 'etag-1',
              },
            ],
          }),
        ],
      }),
      invalidated,
    })

    const result = await service.sync(WORKSPACE)

    expect(result).toMatchObject({ upserted: 1, unchanged: 0, tombstoned: 0, contracts: 1 })
    expect(result.status).toBe('ok')
    const [row] = services.rows()
    expect(row).toMatchObject({
      serviceId: 'orders',
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      sourceId: SERVICE_CATALOG_SOURCE_ID,
      sourcePath: 'component:default/orders',
      // An imported service is not repo-sourced, so it pins no commit.
      pinnedCommit: null,
    })
    // The operation index is computed at WRITE time, so the catalog can show an agent the
    // interface without loading a document.
    expect(contracts.rows()[0]).toMatchObject({
      contractId: 'orders-api',
      format: 'openapi',
      operations: ['GET /orders'],
      sourcePath: 'api:default/orders-api',
      sourceSha: 'etag-1',
    })
    expect(invalidated).toEqual([WORKSPACE])
  })

  it('reports an unchanged service without rewriting it', async () => {
    const connection = connectionRepo({})
    const first = build({ connection, catalogClient: client({ entries: [entry()] }) })
    await first.service.sync(WORKSPACE)
    const createdAt = first.services.rows()[0]?.createdAt

    now = 9_000
    const second = build({
      connection,
      services: first.services,
      contracts: first.contracts,
      catalogClient: client({ entries: [entry()] }),
    })
    const result = await second.service.sync(WORKSPACE)

    expect(result).toMatchObject({ upserted: 0, unchanged: 1 })
    expect(second.services.rows()[0]?.createdAt).toBe(createdAt)
    expect(second.services.rows()[0]?.updatedAt).toBe(createdAt)
  })

  it('rewrites a service whose interface DEFINITION changed, with the title unchanged', async () => {
    const api = (definition: string) => ({
      id: 'orders-api',
      title: 'Orders API',
      format: 'openapi' as const,
      definition,
      ref: 'api:default/orders-api',
      // No revision: this is the portal that exposes no change token, where the content digest is
      // the only thing that can tell an edit from a no-op.
      revision: null,
    })
    const connection = connectionRepo({})
    const first = build({
      connection,
      catalogClient: client({ entries: [entry({ apis: [api('openapi: 3.0.3\npaths: {}\n')] })] }),
    })
    await first.service.sync(WORKSPACE)

    const second = build({
      connection,
      services: first.services,
      contracts: first.contracts,
      catalogClient: client({
        entries: [entry({ apis: [api('openapi: 3.0.3\npaths:\n  /orders:\n    get: {}\n')] })],
      }),
    })
    const result = await second.service.sync(WORKSPACE)

    // Everything ABOUT the service is identical; only the document moved. Comparing anything
    // cheaper (the id set, the title, the byte length) would have reported this as unchanged and
    // served the old document indefinitely.
    expect(result).toMatchObject({ upserted: 1, unchanged: 0 })
    expect(second.contracts.rows()[0]?.operations).toEqual(['GET /orders'])
  })

  it('tombstones a service the portal no longer offers, and its contracts', async () => {
    const connection = connectionRepo({})
    const first = build({
      connection,
      catalogClient: client({
        entries: [
          entry(),
          entry({ id: 'billing', name: 'Billing', ref: 'component:default/billing' }),
        ],
      }),
    })
    await first.service.sync(WORKSPACE)

    const second = build({
      connection,
      services: first.services,
      contracts: first.contracts,
      catalogClient: client({ entries: [entry()] }),
    })
    const result = await second.service.sync(WORKSPACE)

    expect(result.tombstoned).toBe(1)
    expect(second.services.rows().find((r) => r.serviceId === 'billing')?.deletedAt).toBe(now)
    expect(second.contracts.rows().some((r) => r.serviceId === 'billing')).toBe(false)
  })

  it('never touches a service this connection did not produce', async () => {
    const uploaded: FoundationalServiceRecord = {
      serviceId: 'file-storage',
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      name: 'File Storage',
      summary: 'Uploaded by hand.',
      description: '',
      capabilities: [],
      sourceId: null,
      sourcePath: null,
      pinnedCommit: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    }
    const { service, services } = build({
      connection: connectionRepo({}),
      services: serviceRepo([uploaded]),
      catalogClient: client({ entries: [entry()] }),
    })

    const result = await service.sync(WORKSPACE)

    // The reconcile diffs against `sourceId === 'service-catalog'` only; a hand-registered or
    // repo-sourced service in the same tier is not "removed upstream".
    expect(result.tombstoned).toBe(0)
    expect(services.rows().find((r) => r.serviceId === 'file-storage')?.deletedAt).toBeNull()
  })

  it('records a TRUNCATED import as partial and says what to do about it', async () => {
    const connection = connectionRepo({})
    const { service } = build({
      connection,
      catalogClient: client({ entries: [entry()], coverage: 'truncated' }),
    })

    const result = await service.sync(WORKSPACE)

    expect(result.status).toBe('partial')
    expect(connection.row()?.lastSyncStatus).toBe('partial')
    expect(connection.row()?.lastSyncMessage).toMatch(/PREFIX of the portal's estate/)
  })

  it('records an EMPTY filter match as partial rather than a healthy import of nothing', async () => {
    const connection = connectionRepo({})
    const { service } = build({ connection, catalogClient: client({ coverage: 'empty' }) })

    const result = await service.sync(WORKSPACE)

    expect(result.status).toBe('partial')
    expect(connection.row()?.lastSyncMessage).toMatch(/filter matched nothing/)
  })

  it('leaves a clean pass with NO message, so the pass that needs reading stands out', async () => {
    const connection = connectionRepo({})
    const { service } = build({ connection, catalogClient: client({ entries: [entry()] }) })

    await service.sync(WORKSPACE)

    expect(connection.row()?.lastSyncStatus).toBe('ok')
    expect(connection.row()?.lastSyncMessage).toBeNull()
  })

  it('records a failed import on the connection and re-throws', async () => {
    const connection = connectionRepo({})
    const { service, services } = build({
      connection,
      catalogClient: failingClient(new Error('portal unreachable')),
    })

    await expect(service.sync(WORKSPACE)).rejects.toThrow('portal unreachable')

    // Stamped BEFORE it propagates: stamping only on success would leave a workspace whose portal
    // has been unreachable for a week showing the last pass that worked.
    expect(connection.row()?.lastSyncStatus).toBe('failed')
    expect(connection.row()?.lastSyncMessage).toMatch(/portal unreachable/)
    // …and nothing is tombstoned on a transport failure: an unreachable portal is not an empty one.
    expect(services.rows()).toEqual([])
  })

  it('records a failure raised BEFORE the portal is contacted, so the sweep cannot starve', async () => {
    const connection = connectionRepo({})
    const services = serviceRepo()
    const service = new ServiceCatalogSyncService({
      serviceCatalogConnectionRepository: connection.repo,
      // An unopenable credential bag: the failure lands in `resolveClient`, which used to sit
      // outside the stamping try. `lastSyncedAt` then stayed null, and `listStale` sorts nulls
      // first, so this workspace held a slot in every bounded batch forever.
      resolveServiceCatalogClient: async () => {
        throw new Error('connection credentials could not be read')
      },
      foundationalServiceRepository: services.repo,
      apiContractRepository: contractRepo().repo,
      clock: { now: () => now },
    })

    await expect(service.sync(WORKSPACE)).rejects.toThrow(/credentials could not be read/)

    expect(connection.row()?.lastSyncStatus).toBe('failed')
    expect(connection.row()?.lastSyncedAt).toBe(now)
  })

  it('yields to a service the workspace registered by another route, and COUNTS the refusal', async () => {
    const uploaded: FoundationalServiceRecord = {
      serviceId: 'orders',
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      name: 'Orders (hand-authored)',
      summary: 'Uploaded by hand.',
      description: '',
      capabilities: ['asset-storage'],
      sourceId: null,
      sourcePath: null,
      pinnedCommit: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    }
    const uploadedContract: ApiContractRecord = {
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      serviceId: 'orders',
      contractId: 'hand-written',
      format: 'openapi',
      title: 'Hand-written API',
      body: 'openapi: 3.0.3',
      operations: [],
      omittedOperations: 0,
      sourcePath: null,
      sourceSha: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const connection = connectionRepo({})
    const { service, services, contracts } = build({
      connection,
      services: serviceRepo([uploaded]),
      contracts: contractRepo([uploadedContract]),
      catalogClient: client({ entries: [entry()] }),
    })

    const result = await service.sync(WORKSPACE)

    // The hand-authored row survives INTACT, capability tag and uploaded contract included.
    expect(services.rows().find((r) => r.serviceId === 'orders')).toEqual(uploaded)
    expect(contracts.rows()).toEqual([uploadedContract])
    expect(result.upserted).toBe(0)
    expect(result.skippedConflicts).toBe(1)
    expect(result.status).toBe('partial')
    expect(connection.row()?.lastSyncMessage).toMatch(
      /already registers a service under the same id/,
    )
  })

  it('re-imports a service the portal dropped and later offers again', async () => {
    const tombstoned: FoundationalServiceRecord = {
      serviceId: 'orders',
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      name: 'Orders',
      summary: 'Places and tracks orders.',
      description: 'Owner: payments (group:default/payments)',
      capabilities: ['service'],
      sourceId: SERVICE_CATALOG_SOURCE_ID,
      sourcePath: 'component:default/orders',
      pinnedCommit: null,
      createdAt: 1,
      updatedAt: 2,
      deletedAt: 2,
    }
    const { service, services } = build({
      connection: connectionRepo({}),
      services: serviceRepo([tombstoned]),
      catalogClient: client({ entries: [entry()] }),
    })

    // Every field matches the stored row, so only the tombstone makes this a change. Reading it as
    // `unchanged` would leave the service suppressed while the portal offers it.
    const result = await service.sync(WORKSPACE)

    expect(result.unchanged).toBe(0)
    expect(result.upserted).toBe(1)
    expect(services.rows().find((r) => r.serviceId === 'orders')?.deletedAt).toBeNull()
  })

  it('counts an interface dropped for a COLLIDING id rather than storing one and staying `ok`', async () => {
    const api = (id: string, definition: string) => ({
      id,
      title: id,
      format: 'openapi' as const,
      definition,
      ref: `api:default/${id}`,
      revision: null,
    })
    const connection = connectionRepo({})
    const { service, contracts } = build({
      connection,
      catalogClient: client({
        entries: [
          entry({ apis: [api('orders', 'openapi: 3.0.0'), api('orders', 'openapi: 3.1.0')] }),
        ],
      }),
    })

    const result = await service.sync(WORKSPACE)

    // One row stored, and the loss STATED: a service publishing one interface where the portal
    // says two, with `skippedApis: 0`, reads to an agent as the whole surface.
    expect(contracts.rows()).toHaveLength(1)
    expect(result.contracts).toBe(1)
    expect(result.skippedApis).toBe(1)
    expect(result.status).toBe('partial')
    expect(connection.row()?.lastSyncMessage).toMatch(/1 declared interfaces were not stored/)
  })
})

describe('ServiceCatalogSyncService.retireImported', () => {
  it('tombstones everything the connection produced and leaves the rest alone', async () => {
    const imported: FoundationalServiceRecord = {
      serviceId: 'orders',
      ownerKind: 'workspace',
      ownerId: WORKSPACE,
      name: 'Orders',
      summary: 'Imported.',
      description: '',
      capabilities: [],
      sourceId: SERVICE_CATALOG_SOURCE_ID,
      sourcePath: 'component:default/orders',
      pinnedCommit: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    }
    const uploaded = { ...imported, serviceId: 'file-storage', sourceId: null }
    const services = serviceRepo([imported, uploaded])
    const contracts = contractRepo()
    const service = new ServiceCatalogSyncService({
      serviceCatalogConnectionRepository: connectionRepo({}).repo,
      resolveServiceCatalogClient: async () => client(),
      foundationalServiceRepository: services.repo,
      apiContractRepository: contracts.repo,
      clock: { now: () => 8_000 },
    })

    expect(await service.retireImported(WORKSPACE)).toBe(1)
    expect(services.rows().find((r) => r.serviceId === 'orders')?.deletedAt).toBe(8_000)
    expect(services.rows().find((r) => r.serviceId === 'file-storage')?.deletedAt).toBeNull()
  })
})

describe('describeImport', () => {
  const base = {
    upserted: 3,
    tombstoned: 0,
    unchanged: 0,
    contracts: 3,
    coverage: 'complete' as const,
    skippedServices: 0,
    skippedConflicts: 0,
    skippedApis: 0,
    status: 'ok' as const,
  }

  it('is null for a pass with nothing to report', () => {
    expect(describeImport(base)).toBeNull()
  })

  it('names skipped interfaces and the formats that are served', () => {
    const message = describeImport({ ...base, skippedApis: 2, status: 'partial' })
    expect(message).toMatch(/2 declared interfaces were not stored/)
    expect(message).toMatch(/OpenAPI, AsyncAPI, GraphQL and gRPC/)
  })

  it('names skipped entities separately from skipped interfaces', () => {
    const message = describeImport({ ...base, skippedServices: 1, status: 'partial' })
    expect(message).toMatch(/1 matching entities could not be imported/)
    expect(message).not.toMatch(/interfaces/)
  })
})
