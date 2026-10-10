import type { ApiContractDocument, ResolvedFoundationalService } from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_BRIEF_FILE,
  ASSET_STORAGE_CAPABILITY,
  FOUNDATIONAL_INDEX_FILE,
  binaryContextFileFor,
  binaryGeneratorContextFileFor,
  contextFileFor,
  defaultBinaryGeneratorRegistry,
  registryBinaryGeneratorSource,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { FoundationalServiceCatalogService } from './FoundationalServiceCatalogService.js'
import { FoundationalServiceRunResolver } from './FoundationalServiceRunResolver.js'

// The resolver's whole job downstream is DEGRADING LOUDLY: a consumer handed no foundational
// context must be able to tell "the design decided none apply" from "no design step ran" from
// "the design named a service this deployment does not have". These assert exactly that.

const entry = (id: string): ResolvedFoundationalService => ({
  id,
  name: 'File Storage',
  summary: 'Stores uploads.',
  description: '',
  capabilities: [],
  contracts: [],
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

  it('injects the generative integrations’ contracts and briefs their content types', async () => {
    const generators = defaultBinaryGeneratorRegistry()
    generators.register({
      id: 'retro-diffusion',
      name: 'Retro Diffusion',
      summary: 'Pixel-art image generation.',
      description: '',
      modalities: ['image'],
      credentials: [{ key: 'RD_TOKEN' }],
      contracts: [
        { contractId: 'api', format: 'openapi', title: 'Inference API', body: document.body },
      ],
    })
    const resolver = new FoundationalServiceRunResolver(
      catalog([storageEntry], new Map([['asset-store', [document]]])),
    )
    const files = await resolver.binaryOutputContextFilesFor(
      'ws',
      {
        storageServiceId: 'asset-store',
        generatorIds: ['retro-diffusion', 'ghost-synth'],
        modalities: ['image'],
      },
      registryBinaryGeneratorSource(generators),
    )
    expect(files.map((f) => f.path)).toEqual([
      BINARY_OUTPUT_BRIEF_FILE,
      binaryGeneratorContextFileFor('retro-diffusion'),
      binaryContextFileFor('asset-store'),
    ])
    const brief = files[0]?.content ?? ''
    expect(brief).toContain('`retro-diffusion`')
    expect(brief).toContain('`RD_TOKEN`')
    // An id the deployment no longer registers is STATED, not dropped — a selection that silently
    // shrinks reads like a step nobody configured.
    expect(brief).toContain('`ghost-synth`')
  })

  it('states that no integration is configured when the deployment registers none', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([storageEntry]))
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'asset-store',
      generatorIds: ['retro-diffusion'],
    })
    expect(files[0]?.content).toContain('`retro-diffusion`')
    expect(files[0]?.content).toContain('does not register')
  })

  it('injects a brief stating a missing selection rather than nothing at all', async () => {
    const resolver = new FoundationalServiceRunResolver(catalog([storageEntry]))
    const files = await resolver.binaryOutputContextFilesFor('ws', undefined)
    expect(files.map((f) => f.path)).toEqual([BINARY_OUTPUT_BRIEF_FILE])
    expect(files[0]?.content).toContain('No storage service is selected')
  })
})

// ---------------------------------------------------------------------------
// The CREDENTIAL half: what a step authenticates to a catalog service WITH. Two surfaces read
// one declaration and must never name different variables — the brief the agent reads, and the
// dispatch projection that puts a value in it.
// ---------------------------------------------------------------------------
describe('FoundationalServiceRunResolver credentials', () => {
  const authenticated: ResolvedFoundationalService = {
    ...entry('file-storage'),
    tier: 'builtin',
    capabilities: [ASSET_STORAGE_CAPABILITY],
    credentials: [
      { key: 'FILE_STORAGE_TOKEN', usage: 'Authorization: Bearer <value>' },
      { key: 'FILE_STORAGE_TENANT', envName: 'STORAGE_TENANT', required: false },
    ],
  }

  it('projects the two NAMES per credential and never the prose', async () => {
    // The dispatch projection is what the container executor rebuilds a job from, with neither
    // the catalog nor the step in hand. `usage` is the brief's business; a copy of it here would
    // be text nothing reads and a future reader could believe was authoritative.
    const resolver = new FoundationalServiceRunResolver(catalog([authenticated]))
    expect(await resolver.credentialsFor('ws', ['file-storage'])).toEqual([
      {
        id: 'file-storage',
        name: 'File Storage',
        credentials: [
          { key: 'FILE_STORAGE_TOKEN' },
          { key: 'FILE_STORAGE_TENANT', envName: 'STORAGE_TENANT', required: false },
        ],
      },
    ])
  })

  it('omits a service that declares none, and an id the catalog does not resolve', async () => {
    // Two different absences with one right answer: there is nothing to authenticate to. An
    // unresolved id is already stated to the agent by the brief that could not describe it.
    const resolver = new FoundationalServiceRunResolver(catalog([entry('plain-service')]))
    expect(await resolver.credentialsFor('ws', ['plain-service', 'imaginary-bus'])).toEqual([])
  })

  it('names the SAME variable in the brief as in the projection', async () => {
    // The one invariant worth pinning across the two reads: `envName` wins in both, or the brief
    // tells the agent to read a variable nothing sets.
    const resolver = new FoundationalServiceRunResolver(catalog([authenticated]))
    const [brief] = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'file-storage',
    })
    expect(brief?.content).toContain('$FILE_STORAGE_TOKEN')
    expect(brief?.content).toContain('$STORAGE_TENANT')
    expect(brief?.content).toContain('Authorization: Bearer <value>')
    // And the disposition the brief owes the agent when a variable is not set, which is the only
    // thing standing between an unresolved credential and an invented token.
    expect(brief?.content).toContain('UNSET')
  })

  it('states the credential in the CONSUMER contract file too, not only the storage brief', async () => {
    // A `foundational-contracts` kind reads the service's API as a document; a bearer-authenticated
    // contract with nothing naming the variable is an API it cannot call.
    const resolver = new FoundationalServiceRunResolver(
      catalog([authenticated], new Map([['file-storage', [document]]])),
    )
    const files = await resolver.contextFilesFor('ws', { declared: ['file-storage'], unknown: [] })
    expect(files[1]?.content).toContain('$FILE_STORAGE_TOKEN')
  })

  // The selection resolves credentials for BOTH its id sets (`briefedServiceIds` unions the storage
  // id with the context ids), so a context service's value is in the job env exactly as storage's
  // is. Storage was named in two places and a context service in neither: the brief's scope section
  // rendered no credentials and its contract file was built without them, which is a live secret in
  // an agent's process with no layer naming the variable that holds it.
  const catalogued: ResolvedFoundationalService = {
    ...entry('asset-index'),
    name: 'Asset Index',
    tier: 'builtin',
    credentials: [
      { key: 'ASSET_INDEX_TOKEN', envName: 'INDEX_TOKEN', usage: 'the X-Index header' },
    ],
  }

  it('names a CONTEXT service’s credential in its contract file', async () => {
    const resolver = new FoundationalServiceRunResolver(
      catalog(
        [authenticated, catalogued],
        new Map([
          ['file-storage', [document]],
          ['asset-index', [document]],
        ]),
      ),
    )
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'file-storage',
      contextServiceIds: ['asset-index'],
    })
    const contract = files.find((file) => file.path === binaryContextFileFor('asset-index'))
    expect(contract?.content).toContain('$INDEX_TOKEN')
    expect(contract?.content).toContain('the X-Index header')
  })

  it('names it in the BRIEF as well, so a service with no contract still names its variable', async () => {
    // The half a contract file cannot cover: a service with no registered contract gets no file at
    // all, so the brief is the only surface left. Storage has always been briefed this way; this is
    // the same statement for the scope half.
    const resolver = new FoundationalServiceRunResolver(
      catalog([authenticated, catalogued], new Map([['file-storage', [document]]])),
    )
    const files = await resolver.binaryOutputContextFilesFor('ws', {
      storageServiceId: 'file-storage',
      contextServiceIds: ['asset-index'],
    })
    expect(files.map((file) => file.path)).not.toContain(binaryContextFileFor('asset-index'))
    const brief = files.find((file) => file.path === BINARY_OUTPUT_BRIEF_FILE)
    expect(brief?.content).toContain('$INDEX_TOKEN')
  })
})
