import { describe, expect, it } from 'vitest'
import {
  MAX_CATALOG_CHARS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_OPERATIONS,
  MAX_CONTRACT_BODY_CHARS,
  detectContractFormat,
  documentSize,
  indexOpenApiOperations,
  openApiTitle,
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

describe('documentSize', () => {
  it('counts CODE POINTS, so the JS write path agrees with the SQL listing path', () => {
    // SQL `length()` counts code points on both SQLite and Postgres; JS `.length` counts UTF-16
    // code units. An astral character is where they part, and where the same unchanged row would
    // otherwise report one size when written and another when listed.
    expect(documentSize('abc')).toBe(3)
    expect(documentSize('ünïcødé')).toBe('ünïcødé'.length)
    expect(documentSize('a🐱b')).toBe(3)
    expect('a🐱b'.length).toBe(4)
  })
})

describe('openApiTitle', () => {
  it("prefers the document's own title, since every service's file is called openapi.yaml", () => {
    expect(openApiTitle(OPENAPI_YAML)).toBe('File storage')
  })

  it('returns null when the document is not OpenAPI or declares no title', () => {
    expect(openApiTitle("import '@toad-contracts/core'")).toBeNull()
    expect(openApiTitle(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }))).toBeNull()
    expect(openApiTitle(JSON.stringify({ openapi: '3.0.0', info: { title: '  ' } }))).toBeNull()
  })
})

describe('summarizeContract', () => {
  it('carries the document size and operation index but never the body', () => {
    const summary = summarizeContract({
      contractId: 'openapi',
      format: 'openapi',
      title: 'File storage API',
      path: 'services/file-storage/openapi.yaml',
      body: OPENAPI_YAML,
    })
    expect(summary.size).toBe(documentSize(OPENAPI_YAML))
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

  it('takes the LAST block, so an echoed example or a revised draft cannot win', () => {
    // The guidance asks the agent to END its reply with the declaration. A model that first
    // restates the instruction it was given, or that reconsiders and writes a corrected block,
    // leaves an earlier block that is an example or a superseded draft — reading it would hand
    // the coder the contracts for a design that was revised away.
    const output = [
      'The format I was asked for looks like this:',
      '',
      '```foundational-services',
      'notifications',
      '```',
      '',
      'On reflection this design consumes only:',
      '',
      '```foundational-services',
      'file-storage',
      '```',
    ].join('\n')
    expect(parseFoundationalDeclaration(output, known)).toEqual({
      declared: ['file-storage'],
      unknown: [],
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

  it('budgets the WHOLE catalog and still names what it could not detail', () => {
    // Without a total budget the catalog grows without limit in the number of services — the
    // very axis this feature exists to let an org grow along.
    const services = Array.from({ length: 60 }, (_, i) => ({
      id: `svc-${String(i).padStart(2, '0')}`,
      name: `Service ${i}`,
      summary: 'A shared capability.',
      description: 'd'.repeat(MAX_CATALOG_DESCRIPTION_CHARS),
      capabilities: ['x'],
      contracts: [],
    }))
    const rendered = renderFoundationalCatalog(services)
    expect(rendered.length).toBeLessThan(MAX_CATALOG_CHARS * 1.2)
    // Overflow is NAMED, never dropped: an id is all a design needs to declare a service.
    expect(rendered).toContain('further registered services are not detailed above')
    expect(rendered).toContain('svc-59')
    // …and the detailed set is a PREFIX of the id-sorted catalog, so a re-dispatch of the same
    // design sees the same thing rather than a different arbitrary subset.
    expect(rendered.indexOf('svc-00')).toBeLessThan(rendered.indexOf('svc-59'))
  })

  it('truncates a long DESCRIPTION with a stated note rather than crowding out other services', () => {
    const rendered = renderFoundationalCatalog([
      {
        id: 'file-storage',
        name: 'File Storage',
        summary: 'Stores uploads.',
        description: 'd'.repeat(MAX_CATALOG_DESCRIPTION_CHARS + 500),
        capabilities: [],
        contracts: [],
      },
    ])
    expect(rendered).toContain('description truncated: 500 further characters')
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

  it('sizes the fence past any run the DOCUMENT contains, so it cannot break out', () => {
    // The realistic shape: an OpenAPI `description:` carrying a fenced request sample. A fixed
    // three-tick fence closes on that sample, and everything after it — the rest of the spec and
    // the instructions that follow the block — reads to the agent as prose.
    const body = [
      'openapi: 3.0.3',
      'info:',
      '  title: Files',
      '  description: |',
      '    Upload a file:',
      '    ```bash',
      '    curl -F file=@x /files',
      '    ```',
      'paths: {}',
    ].join('\n')
    const rendered = renderContractDocument({
      id: 'file-storage',
      name: 'File Storage',
      summary: 's',
      description: 'd',
      contracts: [
        { contractId: 'c', format: 'openapi', title: 'HTTP API', body },
        { contractId: 'd', format: 'toad-contract', title: 'Typed', body: 'const a = 1' },
      ],
    })
    expect(rendered).toContain('````yaml')
    // The whole document is inside the block: the last line of the spec still precedes the
    // SECOND document's heading, which a broken-out fence would have swallowed into the first.
    expect(rendered).toContain('paths: {}\n````')
    expect(rendered).toContain('## Typed (toad-contract)')
    // A body with no backticks still gets the ordinary three.
    expect(rendered).toContain('```ts\nconst a = 1\n```')
  })

  it('sizes the fence from the TRUNCATED text, so a cut mid-run cannot leave it open', () => {
    // The cut lands inside a long backtick run: the fence must clear what SURVIVES, not what
    // the original body happened to contain.
    const body = `${'x'.repeat(MAX_CONTRACT_BODY_CHARS - 2)}\`\`\`\`\`\`\`\`\`\``
    const rendered = renderContractDocument({
      id: 'file-storage',
      name: 'File Storage',
      summary: 's',
      description: 'd',
      contracts: [{ contractId: 'c', format: 'openapi', title: 'HTTP API', body }],
    })
    const fence = rendered.match(/^(`{3,})yaml$/m)?.[1] ?? ''
    expect(fence.length).toBe(3) // only two ticks survived the cut
    expect(rendered).toContain(`\n${fence}\n`)
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
    // Contract files live one level below the fixed files, so no service id can collide with
    // `index.md` or `catalog.md` (both are legal slugs).
    expect(rendered).toContain('foundational-services/contracts/file-storage.md')
    expect(rendered).toContain('imaginary-bus')
    expect(rendered).toContain('Do not guess')
  })
})
