import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
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
