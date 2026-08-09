import { describe, expect, it } from 'vitest'
import {
  ASSET_STORAGE_CAPABILITY,
  BINARY_OUTPUT_DECLARATION_TAG,
  MAX_BINARY_OUTPUT_ENTRIES,
  binaryContextFileFor,
  binaryOutputConfigIssues,
  describeBinaryOutputConfigIssues,
  parseBinaryOutputDeclaration,
  renderBinaryOutputBrief,
} from './binary-outputs.js'
import type { FoundationalCatalogView } from './foundational-services.js'

function view(overrides: Partial<FoundationalCatalogView> = {}): FoundationalCatalogView {
  return {
    id: 'asset-store',
    name: 'Asset store',
    summary: 'Stores product media.',
    description: 'Org-wide binary asset storage.',
    capabilities: [ASSET_STORAGE_CAPABILITY],
    contracts: [
      {
        contractId: 'api',
        format: 'openapi',
        title: 'Asset API',
        size: 100,
        path: null,
        operations: ['POST /assets'],
        omittedOperations: 0,
      },
    ],
    ...overrides,
  }
}

function declaration(body: string): string {
  return `Work done.\n\n\`\`\`${BINARY_OUTPUT_DECLARATION_TAG}\n${body}\n\`\`\`\n`
}

describe('binaryOutputConfigIssues', () => {
  const catalog = [
    view(),
    view({ id: 'entity-inventory', capabilities: ['generation-context'] }),
    view({ id: 'audit-log', capabilities: ['audit'] }),
  ]

  it('accepts a storage-capable storage id plus known context ids', () => {
    expect(
      binaryOutputConfigIssues(
        { storageServiceId: 'asset-store', contextServiceIds: ['entity-inventory', 'audit-log'] },
        catalog,
      ),
    ).toEqual([])
  })

  it('reports an unknown storage id and a storage id without the capability, apart', () => {
    expect(binaryOutputConfigIssues({ storageServiceId: 'nope' }, catalog)).toEqual([
      { role: 'storage', serviceId: 'nope', problem: 'unknown_service' },
    ])
    expect(binaryOutputConfigIssues({ storageServiceId: 'audit-log' }, catalog)).toEqual([
      { role: 'storage', serviceId: 'audit-log', problem: 'not_storage_capable' },
    ])
  })

  it('reports every issue rather than the first, so a refusal can name the whole fix', () => {
    expect(
      binaryOutputConfigIssues(
        { storageServiceId: 'nope', contextServiceIds: ['also-nope', 'entity-inventory'] },
        catalog,
      ),
    ).toEqual([
      { role: 'storage', serviceId: 'nope', problem: 'unknown_service' },
      { role: 'context', serviceId: 'also-nope', problem: 'unknown_service' },
    ])
  })
})

describe('parseBinaryOutputDeclaration', () => {
  const known = { services: ['asset-store'], generators: ['retro-diffusion'] }

  it('reads a JSON array of entries, keeping optional fields and lowercasing the service id', () => {
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          {
            service: 'Asset-Store',
            location: 'assets/products/kettle.png',
            entity: 'product:kettle',
            contentType: 'image/png',
            description: 'Hero image',
          },
        ]),
      ),
      known,
    )
    expect(report).toEqual({
      stored: [
        {
          service: 'asset-store',
          location: 'assets/products/kettle.png',
          entity: 'product:kettle',
          contentType: 'image/png',
          description: 'Hero image',
          // Derived in code from the declared media type — the model reports, the platform
          // classifies.
          modality: 'image',
        },
      ],
      unknownServices: [],
      unknownGenerators: [],
      invalidEntries: 0,
      omitted: 0,
    })
  })

  it('withholds the generative verdict — and only that — when the set could not be read', () => {
    // The third state of one question. An empty `generators` set is a real answer ("this
    // deployment registers none"), so every claimed id is an invention; `generatorsUnverified`
    // is "nobody could look", where the same accusation would be fabricated. What must NOT be
    // withheld is everything else: the artifacts are recorded and the STORAGE verdict still
    // resolves against the workspace catalog, which this says nothing about.
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          { service: 'asset-store', location: 'a.png', generator: 'retro-diffusion' },
          { service: 'shadow-cdn', location: 'b.png', generator: 'ghost' },
        ]),
      ),
      { services: ['asset-store'], generatorsUnverified: true },
    )
    expect(report.stored).toHaveLength(2)
    expect(report.generatorsUnverified).toBe(true)
    expect(report.unknownGenerators).toEqual([])
    // Computed exactly as it would have been: the catalog half was never in doubt.
    expect(report.unknownServices).toEqual(['shadow-cdn'])
  })

  it('carries the unverified flag onto the EARLY returns too', () => {
    // `undeclared` and `parseFailed` return before any id is examined, but the fact is about the
    // deployment rather than about the reply. Letting it appear and disappear with the shape of
    // what the agent wrote would make two settlements incomparable.
    const known = { services: ['asset-store'], generatorsUnverified: true }
    expect(parseBinaryOutputDeclaration('all done', known).generatorsUnverified).toBe(true)
    expect(parseBinaryOutputDeclaration(declaration('none'), known).generatorsUnverified).toBe(true)
    expect(parseBinaryOutputDeclaration(declaration('not json'), known).generatorsUnverified).toBe(
      true,
    )
  })

  it('leaves the flag ABSENT when the set was read, so an unset field is a real verdict', () => {
    const report = parseBinaryOutputDeclaration(
      declaration(JSON.stringify([{ service: 'asset-store', location: 'a.png' }])),
      known,
    )
    expect(report.generatorsUnverified).toBeUndefined()
  })

  it('tolerates a single bare object, because models write one when they stored one', () => {
    const report = parseBinaryOutputDeclaration(
      declaration('{"service": "asset-store", "location": "a.png"}'),
      known,
    )
    expect(report.stored).toEqual([{ service: 'asset-store', location: 'a.png' }])
  })

  it('distinguishes no block (undeclared) from an explicit `none` (empty) from parse failure', () => {
    expect(parseBinaryOutputDeclaration('all done, nothing to add', known)).toEqual({
      stored: [],
      unknownServices: [],
      unknownGenerators: [],
      invalidEntries: 0,
      omitted: 0,
      undeclared: true,
    })
    expect(parseBinaryOutputDeclaration(declaration('none'), known)).toEqual({
      stored: [],
      unknownServices: [],
      unknownGenerators: [],
      invalidEntries: 0,
      omitted: 0,
    })
    expect(parseBinaryOutputDeclaration(declaration('not json at all'), known)).toEqual({
      stored: [],
      unknownServices: [],
      unknownGenerators: [],
      invalidEntries: 0,
      omitted: 0,
      parseFailed: true,
    })
  })

  it('keeps entries naming an unknown service AND names the id, so the claim is not hidden', () => {
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          { service: 'asset-store', location: 'a.png' },
          { service: 'shadow-cdn', location: 'b.png' },
          { service: 'shadow-cdn', location: 'c.png' },
        ]),
      ),
      known,
    )
    expect(report.stored).toHaveLength(3)
    expect(report.unknownServices).toEqual(['shadow-cdn'])
  })

  it('counts malformed entries instead of silently dropping them', () => {
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          { service: 'asset-store', location: 'a.png' },
          { service: 'asset-store' }, // no location
          { location: 'orphan.png' }, // no service
          'not an object',
          { service: 'asset-store', location: 'x'.repeat(600) }, // corrupt-if-truncated identity
        ]),
      ),
      known,
    )
    expect(report.stored).toHaveLength(1)
    expect(report.invalidEntries).toBe(4)
  })

  it('caps the retained entries and counts the excess as omitted', () => {
    const entries = Array.from({ length: MAX_BINARY_OUTPUT_ENTRIES + 5 }, (_, i) => ({
      service: 'asset-store',
      location: `assets/${i}.png`,
    }))
    const report = parseBinaryOutputDeclaration(declaration(JSON.stringify(entries)), known)
    expect(report.stored).toHaveLength(MAX_BINARY_OUTPUT_ENTRIES)
    expect(report.omitted).toBe(5)
  })

  it('elides an over-long description with a marker rather than keeping it unbounded', () => {
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          { service: 'asset-store', location: 'a.png', description: 'd'.repeat(600) },
        ]),
      ),
      known,
    )
    expect(report.stored[0]?.description).toHaveLength(501)
    expect(report.stored[0]?.description?.endsWith('…')).toBe(true)
  })

  it('records the generating integration, derives the content type, and names an unknown one', () => {
    // The `generator` claim resolves against the DEPLOYMENT registry, not the workspace catalog,
    // so an id nobody registers is reported apart from an unknown storage id — different
    // registries, different fixes. The entry is still kept: the platform records the claim.
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          {
            service: 'asset-store',
            location: 'a.png',
            generator: 'Retro-Diffusion',
            contentType: 'image/png',
          },
          { service: 'asset-store', location: 'b.mp3', generator: 'ghost-synth' },
        ]),
      ),
      known,
    )
    expect(report.stored[0]).toMatchObject({ generator: 'retro-diffusion', modality: 'image' })
    expect(report.stored[1]).toMatchObject({ generator: 'ghost-synth' })
    expect(report.unknownServices).toEqual([])
    expect(report.unknownGenerators).toEqual(['ghost-synth'])
  })

  it('leaves the modality ABSENT for a media type it cannot classify, rather than guessing', () => {
    // "We cannot tell what this is" must not read as "this is not an image": the classifier is
    // not a registry of every format, and a wrong modality would be a fact nobody stated.
    const report = parseBinaryOutputDeclaration(
      declaration(
        JSON.stringify([
          { service: 'asset-store', location: 'a.bin', contentType: 'application/octet-stream' },
          { service: 'asset-store', location: 'b.png' },
        ]),
      ),
      known,
    )
    expect(report.stored[0]?.modality).toBeUndefined()
    expect(report.stored[1]?.modality).toBeUndefined()
  })

  it('reads the LAST block, so an illustrated example does not beat the real declaration', () => {
    // Models routinely restate the contract before doing the work. Parsing the first block would
    // record "stored nothing" for a run that stored two artifacts — a confident wrong answer.
    const reply = [
      'I will end with a block shaped like:',
      '```binary-outputs',
      'none',
      '```',
      'Generating now.',
      '```binary-outputs',
      JSON.stringify([{ service: 'asset-store', location: 'real.png' }]),
      '```',
    ].join('\n')
    const report = parseBinaryOutputDeclaration(reply, known)
    expect(report.stored).toEqual([{ service: 'asset-store', location: 'real.png' }])
    expect(report.undeclared).toBeUndefined()
  })
})

describe('describeBinaryOutputConfigIssues', () => {
  it('names EVERY unresolved id, so one edit clears the refusal', () => {
    // The point of collecting issues: a step that lost three services must not cost three
    // refuse-fix-restart rounds.
    const message = describeBinaryOutputConfigIssues('image-generator', [
      { role: 'storage', serviceId: 'gone-store', problem: 'unknown_service' },
      { role: 'context', serviceId: 'gone-inventory', problem: 'unknown_service' },
      { role: 'context', serviceId: 'also-gone', problem: 'unknown_service' },
    ])
    expect(message).toContain('image-generator')
    expect(message).toContain('gone-store')
    expect(message).toContain('gone-inventory')
    expect(message).toContain('also-gone')
  })

  it('states the capability problem as a distinct cause from an unknown id', () => {
    // "registered but not storage-capable" and "not registered" need different fixes, so they
    // must not read the same.
    const capability = describeBinaryOutputConfigIssues('image-generator', [
      { role: 'storage', serviceId: 'audit-log', problem: 'not_storage_capable' },
    ])
    const unknown = describeBinaryOutputConfigIssues('image-generator', [
      { role: 'storage', serviceId: 'audit-log', problem: 'unknown_service' },
    ])
    expect(capability).toContain(ASSET_STORAGE_CAPABILITY)
    expect(capability).not.toContain("is not in the workspace's catalog")
    expect(unknown).toContain("is not in the workspace's catalog")
  })
})

describe('renderBinaryOutputBrief', () => {
  it('names the storage service and points at its injected contract', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'asset-store' },
      storage: view(),
      contextServices: [],
      unresolvedContextIds: [],
    })
    expect(brief).toContain('`asset-store`')
    expect(brief).toContain(`.cat-context/${binaryContextFileFor('asset-store')}`)
    expect(brief).toContain('No context service is selected')
    expect(brief).toContain(BINARY_OUTPUT_DECLARATION_TAG)
  })

  // A comparison step is TWO dispatches of one step, given opposite instructions. Getting the
  // phase wrong is silent in both directions: a first pass told to deliver makes the very choice
  // the comparison exists to take away, and a second pass told to generate candidates restarts
  // the comparison with the human's decision already recorded and about to be ignored.
  it('asks the FIRST pass of a comparison step for candidates, not deliverables', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'asset-store', comparison: { perGenerator: 2 } },
      storage: view(),
      contextServices: [],
      unresolvedContextIds: [],
    })
    expect(brief).toContain('## Candidates for review')
    expect(brief).toContain('```binary-candidates')
    expect(brief).not.toContain(
      `Declare what you stored in the fenced \`\`\`${BINARY_OUTPUT_DECLARATION_TAG}`,
    )
  })

  it('asks the SECOND pass to deliver exactly what was kept', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'asset-store', comparison: {} },
      storage: view(),
      contextServices: [],
      unresolvedContextIds: [],
      candidates: {
        status: 'chosen',
        candidates: [{ id: 'cand_1', service: 'asset-store', location: 'staging/a.png' }],
        invalidEntries: 0,
        omitted: 0,
        unusablePreviews: 0,
        choice: { kept: [{ candidateId: 'cand_1' }], discarded: [], at: 1 },
      },
    })
    expect(brief).toContain('## The candidate decision')
    expect(brief).toContain('KEEP the candidate staged at `staging/a.png`')
    expect(brief).toContain(BINARY_OUTPUT_DECLARATION_TAG)
    expect(brief).not.toContain('## Candidates for review')
  })

  // A comparison whose first pass produced nothing gets no second pass at all, so the only brief
  // that could read this is the first one. Treating it as a step with no comparison is the safe
  // reading: it delivers directly, which is what a comparison with nothing to compare owed.
  it('falls back to a plain delivering brief once a comparison settled with no choice', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'asset-store', comparison: {} },
      storage: view(),
      contextServices: [],
      unresolvedContextIds: [],
      candidates: {
        status: 'no_choice',
        noChoiceReason: 'undeclared',
        candidates: [],
        invalidEntries: 0,
        omitted: 0,
        unusablePreviews: 0,
      },
    })
    expect(brief).not.toContain('## Candidates for review')
    expect(brief).toContain(BINARY_OUTPUT_DECLARATION_TAG)
  })

  it('states an unresolved storage id as a hard stop rather than omitting it', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'gone' },
      storage: null,
      contextServices: [],
      unresolvedContextIds: [],
    })
    expect(brief).toContain('`gone`')
    expect(brief).toContain('does not contain it')
    expect(brief).toContain('Do NOT store')
  })

  it('states a missing selection as "generate nothing you cannot deliver"', () => {
    const brief = renderBinaryOutputBrief({
      config: undefined,
      storage: null,
      contextServices: [],
      unresolvedContextIds: [],
    })
    expect(brief).toContain('No storage service is selected')
  })

  it('lists context services with their contracts and names unresolved ids apart', () => {
    const brief = renderBinaryOutputBrief({
      config: {
        storageServiceId: 'asset-store',
        contextServiceIds: ['entity-inventory', 'gone'],
      },
      storage: view(),
      contextServices: [view({ id: 'entity-inventory', name: 'Entity inventory', contracts: [] })],
      unresolvedContextIds: ['gone'],
    })
    expect(brief).toContain('`entity-inventory`')
    expect(brief).toContain('No API contract is registered for `entity-inventory`')
    expect(brief).toContain('`gone`')
    expect(brief).toContain('which the catalog does not contain')
  })

  it('notes a storage service missing the binary-storage capability instead of hiding it', () => {
    const brief = renderBinaryOutputBrief({
      config: { storageServiceId: 'audit-log' },
      storage: view({ id: 'audit-log', capabilities: ['audit'] }),
      contextServices: [],
      unresolvedContextIds: [],
    })
    expect(brief).toContain(`does not advertise the \`${ASSET_STORAGE_CAPABILITY}\` capability`)
  })
})
