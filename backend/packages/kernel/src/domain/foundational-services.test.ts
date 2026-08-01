import { describe, expect, it } from 'vitest'
import {
  MAX_CATALOG_OPERATIONS,
  MAX_CONTRACT_BODY_CHARS,
  detectContractFormat,
  indexOpenApiOperations,
  parseFoundationalDeclaration,
  renderContractDocument,
  renderFoundationalCatalog,
  renderFoundationalIndex,
  summarizeContract,
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
