import { describe, expect, it } from 'vitest'
import {
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_OPERATIONS,
  MAX_CATALOG_RENDER_CHARS,
  MAX_CONTRACT_BODY_CHARS,
  describeFoundationalProblem,
  detectContractFormat,
  indexAsyncApiOperations,
  indexContractOperations,
  indexOpenApiOperations,
  indexToadContractOperations,
  isAsyncApiDocument,
  isOpenApiDocument,
  isContractCandidatePath,
  isContractModulePath,
  parseFoundationalDeclaration,
  renderContractDocument,
  renderFoundationalCatalog,
  renderFoundationalIndex,
  renderServiceEstate,
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

describe('isContractModulePath', () => {
  // The repo source admits a linked module the SET's format vouches for, and it asks this rather
  // than carrying its own extension list — a second list drifts, and the drift reads as a linked
  // schema module skipped as `unrecognised` for an extension the detector beside it recognises.
  it('accepts exactly the extensions a contract MODULE can be detected from', () => {
    for (const path of ['contracts/api.ts', 'contracts/api.mts', 'dist/api.js']) {
      expect(isContractModulePath(path)).toBe(true)
    }
  })

  it('rejects an OpenAPI document, which is a contract but never a module', () => {
    for (const path of ['spec.json', 'spec.yaml', 'spec.yml', 'spec.openapi', 'README.md']) {
      expect(isContractModulePath(path)).toBe(false)
    }
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
    expect(renderFoundationalCatalog({ status: 'resolved', services: [] })).toContain(
      'none are registered',
    )
  })

  it('states an UNREADABLE catalog as its own third outcome, never as an empty one', () => {
    // "None are registered" licenses an Architect to design the capability itself. An outage
    // does not, and the two must not read alike — this is the substitution ADR 0031's mothership
    // section exists to make impossible.
    const rendered = renderFoundationalCatalog({ status: 'unavailable' })
    expect(rendered).toContain('COULD NOT BE READ')
    expect(rendered).not.toContain('none are registered')
    // …and it says what to DO about it, or a model reads an unexplained warning as noise.
    expect(rendered).toContain('report')
  })

  it('renders identity, capabilities and operation names but no document bodies', () => {
    const rendered = renderFoundationalCatalog({
      status: 'resolved',
      services: [
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
      ],
    })
    expect(rendered).toContain('id: file-storage')
    expect(rendered).toContain('POST /files')
    expect(rendered).toContain('Not for structured records')
    expect(rendered).not.toContain('openapi: 3.0.3')
  })

  it('says how many operations it is holding back', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CATALOG_OPERATIONS + 3; i++) paths[`/p${i}`] = { get: {} }
    const rendered = renderFoundationalCatalog({
      status: 'resolved',
      services: [
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
      ],
    })
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

  it('distinguishes an UNREADABLE catalog from a design that declared nothing', () => {
    // The third state: the read itself failed, so what the design chose is unknown rather than
    // empty. An implementer may act on "the design declared none" — it may not act the same way
    // on an outage, which is why these must not render alike.
    const unavailable = renderFoundationalIndex({ status: 'unavailable' })
    expect(unavailable).toContain('could not be read')
    expect(unavailable).toContain('Do not guess')
    expect(unavailable).not.toContain('declared no foundational services')
    expect(unavailable).not.toContain('nothing was checked')
  })

  it('distinguishes "nothing was declared" from "nothing was checked"', () => {
    const declaredNone = renderFoundationalIndex({
      status: 'resolved',
      bundles: [],
      unknown: [],
      noDeclaration: false,
    })
    const neverRan = renderFoundationalIndex({
      status: 'resolved',
      bundles: [],
      unknown: [],
      noDeclaration: true,
    })
    expect(declaredNone).toContain('declared no foundational services')
    expect(neverRan).toContain('nothing was checked')
    expect(neverRan).not.toContain('declared no foundational services')
  })

  it('names an unresolvable id and tells the agent not to guess its API', () => {
    const rendered = renderFoundationalIndex({
      status: 'resolved',
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

  it('COUNTS a resolver whose PARAMETER list it cannot read, rather than skipping the anchor', () => {
    // The parameter matcher stops at the first `)`, so a destructured param carrying a call in a
    // default defeats it. That must land as a counted omission like any other unread shape — the
    // bound the extractor rests on is "nothing uncertain is emitted AND the shortfall is
    // reported", and a declaration silently missing from both halves would break the second.
    const awkward = [
      'export const oddContract = defineApiContract({',
      "  method: 'get',",
      '  pathResolver: ({ id = fallbackId() }) => `/files/${id}`,',
      '})',
    ].join('\n')
    expect(indexToadContractOperations(awkward)).toEqual({ operations: [], omitted: 1 })
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
    renderFoundationalCatalog({
      status: 'resolved',
      services: [
        {
          id: 's',
          name: 'S',
          summary: 'x',
          description: '',
          capabilities: [],
          contracts: [summarizeContract({ contractId: 'c', format, title: 'T', path: null, body })],
        },
      ],
    })

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

describe('isOpenApiDocument', () => {
  it('accepts a 3.x document written as JSON and as YAML', () => {
    expect(isOpenApiDocument(OPENAPI_YAML)).toBe(true)
    expect(isOpenApiDocument(JSON.stringify({ openapi: '3.1.0', paths: {} }))).toBe(true)
  })

  it('refuses a version that is not 3.x, which is a DIFFERENT shape, not a dialect', () => {
    // A Swagger 2.0 document would index to zero operations while looking registered.
    expect(isOpenApiDocument(JSON.stringify({ swagger: '2.0', paths: {} }))).toBe(false)
    expect(isOpenApiDocument(JSON.stringify({ openapi: '2.0', paths: {} }))).toBe(false)
    expect(isOpenApiDocument(JSON.stringify({ openapi: '4.0.0', paths: {} }))).toBe(false)
    expect(isOpenApiDocument(JSON.stringify({ openapi: 3, paths: {} }))).toBe(false)
    expect(isOpenApiDocument(JSON.stringify({ paths: {} }))).toBe(false)
  })

  it('refuses a document that parses to something other than an object', () => {
    expect(isOpenApiDocument('[1, 2, 3]')).toBe(false)
    expect(isOpenApiDocument('just a string')).toBe(false)
    expect(isOpenApiDocument('')).toBe(false)
    expect(isOpenApiDocument('null')).toBe(false)
  })

  it('is a recognition MISS rather than an error on unparseable text', () => {
    expect(isOpenApiDocument('openapi: 3.0.0\n  bad: [indent\n')).toBe(false)
  })
})

describe('indexOpenApiOperations: the remaining shapes', () => {
  const index = (doc: unknown) => indexOpenApiOperations(JSON.stringify(doc))

  it('indexes nothing when the document declares no paths, or a paths key that is not a map', () => {
    expect(index({ openapi: '3.0.0' })).toEqual({ operations: [], omitted: 0 })
    expect(index({ openapi: '3.0.0', paths: 'nope' })).toEqual({ operations: [], omitted: 0 })
    expect(index({ openapi: '3.0.0', paths: {} })).toEqual({ operations: [], omitted: 0 })
  })

  it('skips a path item that is not an object rather than failing the whole index', () => {
    expect(index({ openapi: '3.0.0', paths: { '/a': null, '/b': { get: {} } } })).toEqual({
      operations: ['GET /b'],
      omitted: 0,
    })
  })

  it('reads every HTTP method the spec defines, and nothing that is not one', () => {
    const item = {
      get: {},
      put: {},
      post: {},
      delete: {},
      patch: {},
      head: {},
      options: {},
      trace: {},
      // Not operations: shared metadata on the path item.
      parameters: [],
      summary: 'x',
    }
    expect(index({ openapi: '3.0.0', paths: { '/a': item } }).operations).toEqual([
      'DELETE /a',
      'GET /a',
      'HEAD /a',
      'OPTIONS /a',
      'PATCH /a',
      'POST /a',
      'PUT /a',
      'TRACE /a',
    ])
  })

  it('reports zero omitted for a list that fits exactly at the cap', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < MAX_CATALOG_OPERATIONS; i++)
      paths[`/p${String(i).padStart(3, '0')}`] = { get: {} }
    const indexed = indexOpenApiOperations(JSON.stringify({ openapi: '3.0.0', paths }))
    expect(indexed.operations).toHaveLength(MAX_CATALOG_OPERATIONS)
    expect(indexed.omitted).toBe(0)
  })
})

describe('indexContractOperations', () => {
  it('dispatches on the FORMAT, so every write site indexes a document the same way', () => {
    expect(indexContractOperations('openapi', OPENAPI_YAML)).toEqual(
      indexOpenApiOperations(OPENAPI_YAML),
    )
    expect(indexContractOperations('toad-contract', TOAD_MODULE)).toEqual(
      indexToadContractOperations(TOAD_MODULE),
    )
  })

  it('indexes nothing for a format it cannot read, which is not "declares nothing"', () => {
    // `lokalise-api-contract` is a TypeScript format with no static reader; an empty index here
    // is the platform saying it could not look, and the catalog renders that as its own state.
    expect(indexContractOperations('lokalise-api-contract', TOAD_MODULE)).toEqual({
      operations: [],
      omitted: 0,
    })
  })
})

describe('indexToadContractOperations: the path forms it can and cannot read', () => {
  const contract = (method: string, resolver: string) =>
    [
      'export const c = defineApiContract({',
      `  method: '${method}',`,
      `  pathResolver: ${resolver},`,
      '})',
    ].join('\n')

  it('reads a plain string resolver in either quote style', () => {
    expect(indexToadContractOperations(contract('get', "() => '/files'")).operations).toEqual([
      'GET /files',
    ])
    expect(indexToadContractOperations(contract('post', '() => "/files"')).operations).toEqual([
      'POST /files',
    ])
  })

  it('renders a `${param}` hole as the `{param}` template OpenAPI uses', () => {
    expect(
      indexToadContractOperations(contract('get', '({ id }) => `/files/${id}`')).operations,
    ).toEqual(['GET /files/{id}'])
    expect(
      indexToadContractOperations(contract('get', '(p) => `/files/${p.fileId}/meta`')).operations,
    ).toEqual(['GET /files/{p.fileId}/meta'])
  })

  it('refuses a path that is not rooted, rather than emitting a relative one', () => {
    expect(indexToadContractOperations(contract('get', "() => 'files'"))).toEqual({
      operations: [],
      omitted: 1,
    })
    expect(indexToadContractOperations(contract('get', '() => `files/${id}`'))).toEqual({
      operations: [],
      omitted: 1,
    })
  })

  it('counts a declaration whose METHOD it cannot read', () => {
    const dynamic = [
      'export const c = defineApiContract({',
      '  method: verb,',
      "  pathResolver: () => '/files',",
      '})',
    ].join('\n')
    expect(indexToadContractOperations(dynamic)).toEqual({ operations: [], omitted: 1 })
  })

  it('upper-cases the method however the source spelled it', () => {
    expect(indexToadContractOperations(contract('DeLeTe', "() => '/files'")).operations).toEqual([
      'DELETE /files',
    ])
  })

  it('reports the shortfall across MANY declarations, not just the last', () => {
    const source = [
      contract('get', "() => '/a'"),
      contract('post', '() => `/b/${x ? 1 : 2}`'),
      contract('put', "() => '/c'"),
    ].join('\n\n')
    expect(indexToadContractOperations(source)).toEqual({
      operations: ['GET /a', 'PUT /c'],
      omitted: 1,
    })
  })

  it('stops one declaration’s scan at the NEXT anchor, so fields cannot leak across', () => {
    // The first contract names no path; the second's must not be borrowed for it.
    const source = [
      'export const a = defineApiContract({',
      "  method: 'get',",
      '})',
      'export const b = defineApiContract({',
      "  method: 'post',",
      "  pathResolver: () => '/b',",
      '})',
    ].join('\n')
    expect(indexToadContractOperations(source)).toEqual({ operations: ['POST /b'], omitted: 1 })
  })
})

describe('parseFoundationalDeclaration: the remaining line shapes', () => {
  const known = ['file-storage', 'notifications']

  it('strips list markers and backticks, and folds case', () => {
    const output = [
      '```foundational-services',
      '* `File-Storage`',
      '-   NOTIFICATIONS',
      '```',
    ].join('\n')
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage', 'notifications'],
      unknown: [],
    })
  })

  it('reports a repeated id ONCE, whichever side it lands on', () => {
    const output = '```foundational-services\nfile-storage\n- file-storage\nbus\n`bus`\n```'
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage'],
      unknown: ['bus'],
    })
  })

  it('ignores blank lines inside the block', () => {
    const output = '```foundational-services\n\nfile-storage\n   \n```'
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage'],
      unknown: [],
    })
  })

  it('distinguishes an EMPTY block from an absent one only by what it declares', () => {
    // Both answer "nothing", which is the point: `none` and an empty block are the agent
    // having answered, and neither may be recorded as an unknown service.
    expect(parseFoundationalDeclaration('```foundational-services\n```', known)).toEqual({
      declared: [],
      unknown: [],
    })
    expect(parseFoundationalDeclaration('```foundational-services\nNone\n```', known)).toEqual({
      declared: [],
      unknown: [],
    })
  })

  it('resolves against the ids it was GIVEN, not against a fixed list', () => {
    expect(parseFoundationalDeclaration('```foundational-services\nbus\n```', ['bus'])).toEqual({
      declared: ['bus'],
      unknown: [],
    })
    expect(parseFoundationalDeclaration('```foundational-services\nbus\n```', [])).toEqual({
      declared: [],
      unknown: ['bus'],
    })
  })
})

describe('describeFoundationalProblem', () => {
  it('names the offending id in every problem it can, so a registrant knows what to fix', () => {
    expect(
      describeFoundationalProblem({ reason: 'duplicate_contract_id', contractId: 'api' }),
    ).toContain("'api'")
    const invalid = describeFoundationalProblem({
      reason: 'invalid_openapi_document',
      contractId: 'api',
    })
    expect(invalid).toContain("'api'")
    expect(invalid).toContain('OpenAPI 3.x')

    const unreferenced = describeFoundationalProblem({
      reason: 'contract_library_not_referenced',
      format: 'toad-contract',
      expected: '@toad-contracts/core',
      contractIds: ['a', 'b'],
    })
    expect(unreferenced).toContain('toad-contract')
    expect(unreferenced).toContain('@toad-contracts/core')
    expect(unreferenced).toContain('a, b')

    const nearMiss = describeFoundationalProblem({
      reason: 'capability_tag_near_miss',
      capability: 'File_Storage',
      expected: 'file-storage',
    })
    expect(nearMiss).toContain('File_Storage')
    expect(nearMiss).toContain('file-storage')
  })

  it('describes every problem the validator can raise, distinctly', () => {
    const problems: Parameters<typeof describeFoundationalProblem>[0][] = [
      { reason: 'duplicate_contract_id', contractId: 'api' },
      { reason: 'invalid_openapi_document', contractId: 'api' },
      {
        reason: 'contract_library_not_referenced',
        format: 'toad-contract',
        expected: '@toad-contracts/core',
        contractIds: ['api'],
      },
      { reason: 'capability_tag_near_miss', capability: 'x', expected: 'y' },
    ]
    const described = problems.map(describeFoundationalProblem)
    expect(new Set(described).size).toBe(described.length)
    for (const text of described) {
      expect(text).not.toContain('undefined')
      expect(text.trim()).not.toBe('')
    }
  })
})

const ASYNCAPI_2_YAML = [
  'asyncapi: 2.6.0',
  'info:',
  '  title: Orders events',
  '  version: "1"',
  'channels:',
  '  orders/created:',
  '    subscribe:',
  '      summary: an order was placed',
  '  orders/cancelled:',
  '    publish:',
  '      summary: cancel an order',
].join('\n')

const ASYNCAPI_3_YAML = [
  'asyncapi: 3.0.0',
  'info:',
  '  title: Orders events',
  '  version: "1"',
  'channels:',
  '  ordersCreated:',
  '    address: orders/created',
  'operations:',
  '  receiveOrderCreated:',
  '    action: receive',
  '    channel:',
  "      $ref: '#/channels/ordersCreated'",
].join('\n')

describe('isAsyncApiDocument', () => {
  it('recognises 2.x and 3.x', () => {
    expect(isAsyncApiDocument(ASYNCAPI_2_YAML)).toBe(true)
    expect(isAsyncApiDocument(ASYNCAPI_3_YAML)).toBe(true)
  })

  it('refuses a channels-bearing document that is not AsyncAPI', () => {
    // The version key is what separates an event interface from the other `channels`-bearing YAML
    // a repo holds (a broker config, a Kafka Connect descriptor).
    expect(isAsyncApiDocument('channels:\n  orders/created:\n    subscribe: {}\n')).toBe(false)
    expect(isAsyncApiDocument(OPENAPI_YAML)).toBe(false)
    expect(isAsyncApiDocument('not: [yaml')).toBe(false)
  })
})

describe('indexAsyncApiOperations', () => {
  it('reads a 2.x document channel by channel', () => {
    expect(indexAsyncApiOperations(ASYNCAPI_2_YAML)).toEqual({
      operations: ['PUBLISH orders/cancelled', 'SUBSCRIBE orders/created'],
      omitted: 0,
    })
  })

  it('reads a 3.x document through its operations map, naming the channel the ref points at', () => {
    expect(indexAsyncApiOperations(ASYNCAPI_3_YAML)).toEqual({
      operations: ['RECEIVE ordersCreated'],
      omitted: 0,
    })
  })

  it('decodes a JSON-Pointer-escaped channel name rather than naming one that does not exist', () => {
    const document = [
      'asyncapi: 3.0.0',
      'channels:',
      '  orders/created: {}',
      'operations:',
      '  send:',
      '    action: send',
      '    channel:',
      "      $ref: '#/channels/orders~1created'",
    ].join('\n')
    expect(indexAsyncApiOperations(document).operations).toEqual(['SEND orders/created'])
  })

  it('falls back to the operation key when the ref is not a local channel pointer', () => {
    const document = [
      'asyncapi: 3.0.0',
      'operations:',
      '  receiveOrderCreated:',
      '    action: receive',
      '    channel:',
      "      $ref: 'https://elsewhere.example/asyncapi.yaml#/channels/x'",
    ].join('\n')
    // Following an external ref would need a fetch this parser will not make, and the key is the
    // document's own name for the operation rather than an invented one.
    expect(indexAsyncApiOperations(document).operations).toEqual(['RECEIVE receiveOrderCreated'])
  })

  it('indexes nothing for a document that is not AsyncAPI', () => {
    expect(indexAsyncApiOperations(OPENAPI_YAML)).toEqual({ operations: [], omitted: 0 })
  })

  it('states how many operations the cap dropped', () => {
    const channels = Array.from(
      { length: MAX_CATALOG_OPERATIONS + 3 },
      (_, i) => `  topic-${i}:\n    publish: {}`,
    ).join('\n')
    const indexed = indexAsyncApiOperations(`asyncapi: 2.6.0\nchannels:\n${channels}\n`)
    expect(indexed.operations).toHaveLength(MAX_CATALOG_OPERATIONS)
    expect(indexed.omitted).toBe(3)
  })
})

describe('detectContractFormat: the formats the service-catalog import adds', () => {
  it('tells AsyncAPI from OpenAPI on content, both sharing the extension', () => {
    expect(detectContractFormat('events.yaml', ASYNCAPI_2_YAML)).toBe('asyncapi')
    expect(detectContractFormat('api.yaml', OPENAPI_YAML)).toBe('openapi')
  })

  it('recognises GraphQL SDL and protobuf by extension AND content', () => {
    expect(detectContractFormat('schema.graphql', 'type Query { a: String }')).toBe('graphql')
    expect(detectContractFormat('schema.gql', 'type Query { a: String }')).toBe('graphql')
    expect(detectContractFormat('orders.proto', 'service Orders {}')).toBe('grpc')
  })

  it('refuses a GraphQL OPERATION document, which is a call site and not an interface', () => {
    // The common `.gql` file in a repository. Registering one would tell an Architect the service
    // publishes a surface it does not.
    const query = 'query GetOrder($id: ID!) {\n  order(id: $id) { id }\n}'
    expect(detectContractFormat('getOrder.gql', query)).toBeNull()
    const fragment = 'fragment OrderFields on Order {\n  id\n}'
    expect(detectContractFormat('fragment.graphql', fragment)).toBeNull()
  })

  it('refuses a protobuf file that declares only MESSAGES, with no service to publish', () => {
    const messagesOnly =
      'syntax = "proto3";\npackage orders;\n\nmessage Order {\n  string id = 1;\n}\n'
    expect(detectContractFormat('orders.proto', messagesOnly)).toBeNull()
    // A commented-out service is not one either: a keyword in prose must not read as a declaration.
    const commented = '// service Orders {}\nmessage Order {}'
    expect(detectContractFormat('orders.proto', commented)).toBeNull()
  })

  it('treats every one of them as a candidate worth reading', () => {
    // The candidate test stays by EXTENSION: a file has to be read before its content can refuse
    // it, so narrowing this rule would skip the very read that decides.
    for (const path of ['events.asyncapi', 'schema.graphql', 'orders.proto']) {
      expect(isContractCandidatePath(path)).toBe(true)
    }
  })
})

describe('indexContractOperations: dispatch by format', () => {
  it('routes AsyncAPI to its own indexer and leaves the unread formats empty', () => {
    expect(indexContractOperations('asyncapi', ASYNCAPI_2_YAML).operations).toHaveLength(2)
    expect(indexContractOperations('graphql', 'type Query { a: String }')).toEqual({
      operations: [],
      omitted: 0,
    })
    expect(indexContractOperations('grpc', 'service Orders {}')).toEqual({
      operations: [],
      omitted: 0,
    })
  })
})

describe('renderContractDocument: the fence each new format gets', () => {
  const render = (format: 'asyncapi' | 'graphql' | 'grpc', body: string) =>
    renderContractDocument({
      id: 'orders',
      name: 'Orders',
      summary: 's',
      description: 'd',
      contracts: [{ contractId: 'c', format, title: 'Interface', body }],
    })

  it('fences a document as the artifact it is', () => {
    // Not cosmetic: the fence is what tells the agent which artifact it is reading, and a
    // `.proto` fenced as TypeScript is one a model will try to fix rather than call.
    expect(render('asyncapi', ASYNCAPI_2_YAML)).toContain('```yaml')
    expect(render('graphql', 'type Query { a: String }')).toContain('```graphql')
    expect(render('grpc', 'service Orders {}')).toContain('```proto')
  })
})

describe('validateFoundationalDefinition: the AsyncAPI document check', () => {
  it('refuses a document declared as AsyncAPI that is not one', () => {
    const problems = validateFoundationalDefinition({
      contracts: [
        { contractId: 'events', format: 'asyncapi', title: 'Events', body: 'channels: {}' },
      ],
    })
    expect(problems).toEqual([{ reason: 'invalid_asyncapi_document', contractId: 'events' }])
    expect(describeFoundationalProblem(problems[0]!)).toMatch(/AsyncAPI 2.x\/3.x/)
  })

  it('accepts a real one, and says nothing about the formats it does not parse', () => {
    expect(
      validateFoundationalDefinition({
        contracts: [
          { contractId: 'events', format: 'asyncapi', title: 'Events', body: ASYNCAPI_2_YAML },
          { contractId: 'gql', format: 'graphql', title: 'Graph', body: 'nonsense' },
          { contractId: 'rpc', format: 'grpc', title: 'RPC', body: 'nonsense' },
        ],
      }),
    ).toEqual([])
  })
})

describe('renderServiceEstate', () => {
  const service = {
    id: 'orders',
    name: 'Orders',
    summary: 'Places and tracks orders.',
    description: 'Owner: payments (group:default/payments)\nSystem: checkout',
    capabilities: ['service'],
    contracts: [
      {
        contractId: 'orders-api',
        format: 'openapi' as const,
        title: 'Orders API',
        size: 42,
        path: 'api:default/orders-api',
        operations: ['GET /orders'],
        omittedOperations: 0,
      },
    ],
  }

  it('states ownership and the interface surface, and asks for no declaration', () => {
    const rendered = renderServiceEstate({ status: 'resolved', services: [service] })
    expect(rendered).toContain('SERVICE ESTATE')
    expect(rendered).toContain('Owner: payments (group:default/payments)')
    expect(rendered).toContain('interface (openapi): Orders API')
    expect(rendered).toContain('GET /orders')
    // The design framing would push a triage agent towards recommending an adoption instead of
    // naming a fault, and its declaration block would collide with a structured-output contract.
    expect(rendered).not.toContain('prefer consuming')
    expect(rendered).not.toContain('foundational-services')
  })

  it('says nothing is registered rather than rendering an empty section', () => {
    const rendered = renderServiceEstate({ status: 'resolved', services: [] })
    expect(rendered).toContain('no service catalog is registered')
    expect(rendered).toContain('Do not infer ownership')
  })

  it('renders an UNREADABLE estate as a platform failure, not as an empty organisation', () => {
    const rendered = renderServiceEstate({ status: 'unavailable' })
    expect(rendered).toContain('COULD NOT BE READ')
    expect(rendered).toContain('platform failure')
    // The one substitution this whole three-state shape exists to prevent.
    expect(rendered).not.toContain('no service catalog is registered')
  })
})

describe('the rendered catalog is bounded, and says so when it is a prefix', () => {
  const bulky = (id: string, description: string) => ({
    id,
    name: id,
    summary: 'x',
    description,
    capabilities: [],
    contracts: [],
  })

  it('caps one service DESCRIPTION and states how much it withheld', () => {
    const description = 'd'.repeat(MAX_CATALOG_DESCRIPTION_CHARS + 250)
    const rendered = renderFoundationalCatalog({
      status: 'resolved',
      services: [bulky('one', description)],
    })
    expect(rendered).toContain('[description truncated here: 250 further characters')
    expect(rendered.length).toBeLessThan(description.length)
  })

  it('stops at the render budget and names the services it left out', () => {
    // Enough to exceed the budget several times over, so the cut is the budget's and not the
    // fixture's; the count asserted is derived from what the render actually kept.
    const filler = 'd'.repeat(MAX_CATALOG_DESCRIPTION_CHARS)
    const services = Array.from({ length: 60 }, (_, i) => bulky(`svc-${i}`, filler))
    const rendered = renderServiceEstate({ status: 'resolved', services })

    const listed = services.filter((service) => rendered.includes(`id: ${service.id} `)).length
    expect(listed).toBeGreaterThan(0)
    expect(listed).toBeLessThan(services.length)
    expect(rendered).toContain(`and ${services.length - listed} further registered services`)
    expect(rendered).toContain('is a PREFIX of the catalog')
    expect(rendered.length).toBeLessThan(MAX_CATALOG_RENDER_CHARS * 2)
  })

  it('renders a single over-budget service rather than an empty catalog', () => {
    // An outage renders as "COULD NOT BE READ" and an empty tier as "none are registered"; a
    // catalog emptied by its own cap would read as the second and be neither.
    const rendered = renderFoundationalCatalog({
      status: 'resolved',
      services: [bulky('huge', 'd'.repeat(MAX_CATALOG_RENDER_CHARS * 2))],
    })
    expect(rendered).toContain('id: huge')
    expect(rendered).not.toContain('none are registered')
  })
})
