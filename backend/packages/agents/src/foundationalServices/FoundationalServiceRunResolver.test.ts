import type { ApiContractDocument, ResolvedFoundationalService } from '@cat-factory/contracts'
import { FOUNDATIONAL_INDEX_FILE, contextFileFor } from '@cat-factory/kernel'
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
