import { describe, expect, it } from 'vitest'
import {
  MAX_CATALOG_OPERATIONS,
  MAX_CONTRACT_BODY_CHARS,
  detectContractFormat,
  indexOpenApiOperations,
  indexToadContractOperations,
  isContractCandidatePath,
  parseFoundationalDeclaration,
  renderContractDocument,
  renderFoundationalCatalog,
  renderFoundationalIndex,
  summarizeContract,
  validateFoundationalDefinition,
} from './foundational-services.js'

const OPENAPI_YAML = [
  'openapi: 3.0.3',
  'info:',
  '  title: File storage',
  '  version: "1"',
  'paths:',
  '  /files:',
  '    post:',
  '      summary: upload',
  '    get:',
  '      summary: list',
  '  /files/{id}:',
  '    get:',
  '      summary: read',
].join('\n')

describe('detectContractFormat', () => {
  it('recognises an OpenAPI 3.x document in YAML and in JSON', () => {
    expect(detectContractFormat('api/openapi.yaml', OPENAPI_YAML)).toBe('openapi')
    expect(
      detectContractFormat('api/openapi.json', JSON.stringify({ openapi: '3.1.0', paths: {} })),
    ).toBe('openapi')
  })

  it('refuses a Swagger 2.0 document rather than indexing nothing from it', () => {
    expect(detectContractFormat('api/swagger.json', JSON.stringify({ swagger: '2.0' }))).toBeNull()
  })

  it('tells the two TypeScript contract libraries apart by the package they import', () => {
    expect(
      detectContractFormat(
        'contracts.ts',
        "import { defineApiContract } from '@toad-contracts/valibot'",
      ),
    ).toBe('toad-contract')
    expect(
      detectContractFormat(
        'contracts.ts',
        "import { buildGetRoute } from '@lokalise/api-contract'",
      ),
    ).toBe('lokalise-api-contract')
  })

  it('returns null for a TypeScript module that imports neither, so it is skipped not stored', () => {
    expect(detectContractFormat('helpers.ts', 'export const x = 1')).toBeNull()
  })

  it('returns null for an unparseable document instead of throwing', () => {
    expect(detectContractFormat('api.yaml', 'openapi: [unclosed')).toBeNull()
  })
})

describe('isContractCandidatePath', () => {
  it('accepts every extension detectContractFormat can recognise', () => {
    for (const path of ['a.json', 'a.yaml', 'a.yml', 'a.openapi', 'a.ts', 'a.mts', 'a.js']) {
      expect(isContractCandidatePath(path)).toBe(true)
    }
  })

  it('rejects a path no format could ever come from', () => {
    for (const path of ['README.md', 'logo.png', 'specs/notes.txt']) {
      expect(isContractCandidatePath(path)).toBe(false)
    }
  })

  // Without this the extension test is nearly useless at a repo root, where `.json` and `.yaml`
  // describe dependencies far more often than APIs — and a folder scan's file budget would go
  // to manifests before the walk ever reached the specs.
  it('rejects the package, lockfile and compiler manifests every repo root holds', () => {
    for (const path of [
      'package.json',
      'apps/web/package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'composer.json',
      'deno.json',
      'jsconfig.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'packages/kernel/tsconfig.test.json',
    ]) {
      expect(isContractCandidatePath(path)).toBe(false)
    }
  })

  it('keeps a spec whose name merely resembles one of them', () => {
    // The exclusion is by exact basename, not by substring: a folder is free to hold
    // `package-api.json` or `tsconfig-service.yaml` and mean an API contract by it.
    expect(isContractCandidatePath('specs/package-api.json')).toBe(true)
    expect(isContractCandidatePath('specs/tsconfig-service.yaml')).toBe(true)
    expect(isContractCandidatePath('specs/deno.yaml')).toBe(true)
  })
})

describe('indexOpenApiOperations', () => {
  it('lists METHOD + path for every declared operation, sorted', () => {
    expect(indexOpenApiOperations(OPENAPI_YAML).operations).toEqual([
      'GET /files',
      'GET /files/{id}',
      'POST /files',
    ])
  })

  it('caps the list and REPORTS what it dropped, so the list is never read as complete', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CATALOG_OPERATIONS + 5; i++) paths[`/p${i}`] = { get: {} }
    const doc = JSON.stringify({ openapi: '3.0.0', paths })
    const indexed = indexOpenApiOperations(doc)
    expect(indexed.operations).toHaveLength(MAX_CATALOG_OPERATIONS)
    expect(indexed.omitted).toBe(5)
  })

  it('indexes nothing for a non-OpenAPI document rather than guessing from source', () => {
    expect(indexOpenApiOperations("import '@toad-contracts/core'")).toEqual({
      operations: [],
      omitted: 0,
    })
  })
})

describe('summarizeContract', () => {
  it('carries the byte size and operation index but never the body', () => {
    const summary = summarizeContract({
      contractId: 'openapi',
      format: 'openapi',
      title: 'File storage API',
      path: 'services/file-storage/openapi.yaml',
      body: OPENAPI_YAML,
    })
    expect(summary.size).toBe(OPENAPI_YAML.length)
    expect(summary.operations).toContain('POST /files')
    expect(Object.keys(summary)).not.toContain('body')
  })
})

describe('parseFoundationalDeclaration', () => {
  const known = ['file-storage', 'notifications']

  it('reads the ids out of the fenced declaration block', () => {
    const output = [
      'The design stores uploads in the shared service.',
      '',
      '```foundational-services',
      '- file-storage',
      'notifications',
      '```',
    ].join('\n')
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage', 'notifications'],
      unknown: [],
    })
  })

  it('keeps an id the catalog does not know APART from the resolved ones', () => {
    const output = '```foundational-services\nfile-storage\nimaginary-bus\n```'
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage'],
      unknown: ['imaginary-bus'],
    })
  })

  it('treats the explicit `none` answer as a declaration of nothing, not an unknown service', () => {
    expect(parseFoundationalDeclaration('```foundational-services\nnone\n```', known)).toEqual({
      declared: [],
      unknown: [],
    })
  })

  it('ignores catalog ids that appear only in prose, so a rejected alternative is not adopted', () => {
    const output = 'We considered file-storage but rolled our own instead.'
    expect(parseFoundationalDeclaration(output, known)).toEqual({ declared: [], unknown: [] })
  })

  it('returns an empty selection for an absent output', () => {
    expect(parseFoundationalDeclaration(undefined, known)).toEqual({ declared: [], unknown: [] })
  })
})

describe('renderFoundationalCatalog', () => {
  it('states that none are registered rather than rendering an empty section', () => {
    expect(renderFoundationalCatalog([])).toContain('none are registered')
  })

  it('renders identity, capabilities and operation names but no document bodies', () => {
    const rendered = renderFoundationalCatalog([
      {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'Stores and serves user uploads.',
        description: 'Use for any binary blob. Not for structured records.',
        capabilities: ['file-storage'],
        contracts: [
          summarizeContract({
            contractId: 'openapi',
            format: 'openapi',
            title: 'HTTP API',
            path: null,
            body: OPENAPI_YAML,
          }),
        ],
      },
    ])
    expect(rendered).toContain('id: file-storage')
    expect(rendered).toContain('POST /files')
    expect(rendered).toContain('Not for structured records')
    expect(rendered).not.toContain('openapi: 3.0.3')
  })

  it('says how many operations it is holding back', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CATALOG_OPERATIONS + 3; i++) paths[`/p${i}`] = { get: {} }
    const rendered = renderFoundationalCatalog([
      {
        id: 's',
        name: 'S',
        summary: 'x',
        description: '',
        capabilities: [],
        contracts: [
          summarizeContract({
            contractId: 'c',
            format: 'openapi',
            title: 'T',
            path: null,
            body: JSON.stringify({ openapi: '3.0.0', paths }),
          }),
        ],
      },
    ])
    expect(rendered).toContain('+3 more operations not listed here')
  })
})

describe('renderContractDocument', () => {
  it('fences each document by format and states a truncation instead of cutting silently', () => {
    const long = `x`.repeat(MAX_CONTRACT_BODY_CHARS + 100)
    const rendered = renderContractDocument({
      id: 'file-storage',
      name: 'File Storage',
      summary: 's',
      description: 'd',
      contracts: [{ contractId: 'c', format: 'openapi', title: 'HTTP API', body: long }],
    })
    expect(rendered).toContain('```yaml')
    expect(rendered).toContain('100 characters of the original')
  })
})

describe('renderFoundationalIndex', () => {
  const bundle = {
    id: 'file-storage',
    name: 'File Storage',
    summary: 'Stores uploads.',
    description: '',
    contracts: [],
  }

  it('distinguishes "nothing was declared" from "nothing was checked"', () => {
    const declaredNone = renderFoundationalIndex({
      bundles: [],
      unknown: [],
      noDeclaration: false,
    })
    const neverRan = renderFoundationalIndex({ bundles: [], unknown: [], noDeclaration: true })
    expect(declaredNone).toContain('declared no foundational services')
    expect(neverRan).toContain('nothing was checked')
    expect(neverRan).not.toContain('declared no foundational services')
  })

  it('names an unresolvable id and tells the agent not to guess its API', () => {
    const rendered = renderFoundationalIndex({
      bundles: [bundle],
      unknown: ['imaginary-bus'],
      noDeclaration: false,
    })
    expect(rendered).toContain('foundational-services/file-storage.md')
    expect(rendered).toContain('imaginary-bus')
    expect(rendered).toContain('Do not guess')
  })
})

const TOAD_MODULE = [
  "import { defineApiContract } from '@toad-contracts/valibot'",
  "import { fileSchema } from './schemas.js'",
  '',
  'export const listFilesContract = defineApiContract({',
  "  method: 'get',",
  "  pathResolver: () => '/files',",
  '  responsesByStatusCode: { 200: fileSchema },',
  '})',
  '',
  'export const readFileContract = defineApiContract({',
  "  method: 'get',",
  '  requestPathParamsSchema: fileIdParams,',
  '  pathResolver: ({ fileId }) => `/files/${fileId}`,',
  '  responsesByStatusCode: { 200: fileSchema },',
  '})',
].join('\n')

describe('indexToadContractOperations', () => {
  it('reads a literal and an interpolated path off the source, without evaluating it', () => {
    expect(indexToadContractOperations(TOAD_MODULE)).toEqual({
      operations: ['GET /files', 'GET /files/{fileId}'],
      omitted: 0,
    })
  })

  it('COUNTS a declaration whose path it cannot read rather than dropping it silently', () => {
    // A computed path is exactly what a partial parser must not guess at: an invented operation
    // name is worse than a missing one, because a coder writes against it. The anchor count is
    // what keeps the omission visible.
    const computed = [
      'export const oddContract = defineApiContract({',
      "  method: 'post',",
      '  pathResolver: ({ id }) => `/files/${id ? id : "none"}`,',
      '})',
    ].join('\n')
    expect(indexToadContractOperations(computed)).toEqual({ operations: [], omitted: 1 })
  })

  it('indexes nothing at all from a module that declares no contracts', () => {
    expect(indexToadContractOperations('export const x = 1\n')).toEqual({
      operations: [],
      omitted: 0,
    })
  })
})

describe('renderFoundationalCatalog operation states', () => {
  const withContract = (
    format: 'openapi' | 'toad-contract' | 'lokalise-api-contract',
    body: string,
  ) =>
    renderFoundationalCatalog([
      {
        id: 's',
        name: 'S',
        summary: 'x',
        description: '',
        capabilities: [],
        contracts: [summarizeContract({ contractId: 'c', format, title: 'T', path: null, body })],
      },
    ])

  it('says a format is not indexed rather than letting the empty list read as "no endpoints"', () => {
    // The failure this prevents: an Architect told a fully-specified service offers nothing.
    expect(withContract('lokalise-api-contract', "import '@lokalise/api-contract'")).toContain(
      'not indexed for this format',
    )
  })

  it('keeps "declares no operations" distinct from that', () => {
    const rendered = withContract('openapi', 'openapi: 3.0.3\npaths: {}\n')
    expect(rendered).toContain('declares no operations')
    expect(rendered).not.toContain('not indexed')
  })

  it('states a contract MODULE whose declarations it could not read', () => {
    const unreadable = [
      "import { defineApiContract } from '@toad-contracts/valibot'",
      'export const c = defineApiContract({ ...shared })',
    ].join('\n')
    expect(withContract('toad-contract', unreadable)).toContain('could not read')
  })
})

describe('validateFoundationalDefinition', () => {
  it('accepts a contract SET whose anchor module is not the one importing valibot schemas', () => {
    // The real shape this exists for: a `defineApiContract` module plus the schema module it
    // imports. Validating per document refuses the half that is not the entry point, which
    // leaves a registrant concatenating source files to get past the boundary.
    expect(
      validateFoundationalDefinition({
        contracts: [
          { contractId: 'contract', format: 'toad-contract', title: 'C', body: TOAD_MODULE },
          {
            contractId: 'schemas',
            format: 'toad-contract',
            title: 'S',
            body: "import * as v from 'valibot'\nexport const fileSchema = v.object({})",
          },
        ],
      }),
    ).toEqual([])
  })

  it('still refuses a set where NO document references the declared library', () => {
    const problems = validateFoundationalDefinition({
      contracts: [
        { contractId: 'a', format: 'toad-contract', title: 'A', body: 'export const a = 1' },
        { contractId: 'b', format: 'toad-contract', title: 'B', body: 'export const b = 2' },
      ],
    })
    expect(problems).toEqual([
      {
        reason: 'contract_library_not_referenced',
        format: 'toad-contract',
        expected: '@toad-contracts/core',
        contractIds: ['a', 'b'],
      },
    ])
  })

  it('anchors PER FORMAT, so one library cannot vouch for another', () => {
    const problems = validateFoundationalDefinition({
      contracts: [
        { contractId: 'a', format: 'toad-contract', title: 'A', body: TOAD_MODULE },
        {
          contractId: 'b',
          format: 'lokalise-api-contract',
          title: 'B',
          body: 'export const b = 2',
        },
      ],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ format: 'lokalise-api-contract' })
  })

  it('refuses a capability tag that misses a reserved one by case or separators', () => {
    // `asset_storage` registers cleanly today and surfaces hours later as a refused run, because
    // run admission matches `asset-storage` exactly.
    expect(validateFoundationalDefinition({ capabilities: ['asset_storage'] })).toEqual([
      {
        reason: 'capability_tag_near_miss',
        capability: 'asset_storage',
        expected: 'asset-storage',
      },
    ])
    expect(validateFoundationalDefinition({ capabilities: ['asset-storage'] })).toEqual([])
    expect(validateFoundationalDefinition({ capabilities: ['object-storage'] })).toEqual([])
  })

  it('reports every problem, so a batch is fixed in one round', () => {
    const problems = validateFoundationalDefinition({
      capabilities: ['Asset-Storage'],
      contracts: [
        { contractId: 'a', format: 'openapi', title: 'A', body: 'not: openapi' },
        { contractId: 'a', format: 'openapi', title: 'A', body: 'openapi: 3.0.3\npaths: {}' },
      ],
    })
    expect(problems.map((p) => p.reason)).toEqual([
      'capability_tag_near_miss',
      'invalid_openapi_document',
      'duplicate_contract_id',
    ])
  })
})
