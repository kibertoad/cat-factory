import type { ApiContractDocument, ResolvedFoundationalService } from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_BRIEF_FILE,
  ASSET_STORAGE_CAPABILITY,
  FOUNDATIONAL_INDEX_FILE,
  binaryContextFileFor,
  contextFileFor,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { FoundationalServiceCatalogService } from './FoundationalServiceCatalogService.js'
import { FoundationalServiceRunResolver } from './FoundationalServiceRunResolver.js'

// The resolver's whole job downstream is DEGRADING LOUDLY: a consumer handed no foundational
// context must be able to tell "the design decided none apply" from "no design step ran" from
// "the design named a service this deployment does not have". These assert exactly that.

const entry = (id: string): ResolvedFoundationalService => ({
  id,
  ownerKind: 'account',
  name: 'File Storage',
  summary: 'Stores uploads.',
  description: '',
  capabilities: [],
  contracts: [],
  sourceId: null,
  sourcePath: null,
  pinnedCommit: null,
  createdAt: 1,
  updatedAt: 1,
  tier: 'account',
})

const document: ApiContractDocument = {
  contractId: 'openapi',
  format: 'openapi',
  title: 'HTTP API',
  size: 10,
  path: null,
  operations: ['GET /files'],
  omittedOperations: 0,
  body: 'openapi: 3.0.3\npaths: {}\n',
}

function catalog(
  services: ResolvedFoundationalService[],
  docs: Map<string, ApiContractDocument[]> = new Map(),
): FoundationalServiceCatalogService {
  return {
    resolve: async () => services,
    contractsFor: async () => docs,
  } as unknown as FoundationalServiceCatalogService
}

describe('FoundationalServiceRunResolver.contextFilesFor', () => {
  it('injects one file per declared service plus an index', async () => {
    const resolver = new FoundationalServiceRunResolver(
      catalog([entry('file-storage')], new Map([['file-storage', [document]]])),
    )
    const files = await resolver.contextFilesFor('ws', { declared: ['file-storage'], unknown: [] })
    expect(files.map((f) => f.path)).toEqual([
      FOUNDATIONAL_INDEX_FILE,
      contextFileFor('file-storage'),
    ])
    expect(files[1]?.content).toContain('openapi: 3.0.3')
  })

  it('states an id the catalog does not know, and tells the agent not to guess its API', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([entry('file-storage')]))
    const [index] = await resolver.contextFilesFor('ws', {
      declared: ['file-storage'],
      unknown: ['imaginary-bus'],
    })
    expect(index?.content).toContain('imaginary-bus')
    expect(index?.content).toContain('Do not guess')
  })

  it('says "nothing was checked" when no design step declared anything', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([entry('file-storage')]))
    const [index] = await resolver.contextFilesFor('ws', undefined)
    expect(index?.content).toContain('nothing was checked')
  })

  it('says "declared none" when a design ran and concluded no shared service applies', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([entry('file-storage')]))
    const [index] = await resolver.contextFilesFor('ws', { declared: [], unknown: [] })
    expect(index?.content).toContain('declared no foundational services')
    expect(index?.content).not.toContain('nothing was checked')
  })

  it('injects nothing at all on a deployment with an EMPTY catalog and no declaration', async () => {
    // Otherwise every dispatch in a deployment that registers no foundational services would pay
    // for an index file saying so.
    const resolver = new FoundationalServiceRunResolver(catalog([]))
    expect(await resolver.contextFilesFor('ws', undefined)).toEqual([])
  })
})

describe('FoundationalServiceRunResolver.binaryOutputContextFilesFor', () => {
  const storageEntry = {
    ...entry('asset-store'),
    capabilities: [ASSET_STORAGE_CAPABILITY],
  }

  it('injects the brief plus one contract file per resolved service, storage first', async () => {
    const resolver = new FoundationalServiceRunResolver(
      catalog(
        [storageEntry, entry('entity-inventory')],
        new Map([
          ['asset-store', [document]],
          ['entity-inventory', [document]],
        ]),
      ),
    )
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'asset-store',
      contextServiceIds: ['entity-inventory'],
    })
    expect(files.map((f) => f.path)).toEqual([
      BINARY_OUTPUT_BRIEF_FILE,
      binaryContextFileFor('asset-store'),
      binaryContextFileFor('entity-inventory'),
    ])
    expect(files[0]?.content).toContain('`asset-store`')
    expect(files[0]?.content).toContain('`entity-inventory`')
    expect(files[1]?.content).toContain('openapi: 3.0.3')
  })

  it('still injects the brief when the storage id no longer resolves, stating the gap', async () => {
    // Admission validated the selection at start, but a run can outlive a catalog edit — the
    // brief must then re-state the gap rather than let the agent guess at a storage endpoint.
    const resolver = new FoundationalServiceRunResolver(catalog([entry('entity-inventory')]))
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'asset-store',
    })
    expect(files.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    expect(files[0]?.content).toContain('does not contain it')
  })

  it('omits the contract file for a service with no registered contract; the brief says so', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([storageEntry]))
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'asset-store',
    })
    expect(files.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    expect(files[0]?.content).toContain('No API contract is registered for `asset-store`')
  })

  it('injects a brief stating a missing selection rather than nothing at all', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([storageEntry]))
    const files = await resolver.binaryOutputContextFilesFor('ws', undefined)
    expect(files.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    expect(files[0]?.content).toContain('No storage service is selected')
  })
})
