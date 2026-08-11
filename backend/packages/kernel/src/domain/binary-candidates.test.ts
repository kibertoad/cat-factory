import { describe, expect, it } from 'vitest'
import type { BinaryCandidateStepState } from '@cat-factory/contracts'
import { generator } from './binary-generators.fixtures.js'
import {
  MAX_BINARY_CANDIDATES,
  MAX_DISPLAY_CHARS,
  MAX_IDENTITY_CHARS,
  isRenderablePreviewUrl,
  parseBinaryCandidateDeclaration,
  renderBinaryCandidateChoiceSection,
  renderBinaryCandidateSection,
} from './binary-candidates.js'

function block(body: string): string {
  return ['Here you go.', '', '```binary-candidates', body, '```'].join('\n')
}

describe('parseBinaryCandidateDeclaration', () => {
  it('reads the declared candidates, lowercasing the registry ids', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([
          {
            generator: 'Retro-Diffusion',
            service: 'Asset-Store',
            location: 'staging/anvil-a.png',
            subject: 'sprite:anvil',
            contentType: 'image/png',
            previewUrl: 'https://cdn.example/a.png',
            note: 'chunkier outline',
          },
        ]),
      ),
    )
    expect(parsed.candidates).toEqual([
      {
        generator: 'retro-diffusion',
        service: 'asset-store',
        location: 'staging/anvil-a.png',
        subject: 'sprite:anvil',
        contentType: 'image/png',
        previewUrl: 'https://cdn.example/a.png',
        note: 'chunkier outline',
      },
    ])
    expect(parsed.undeclared).toBe(false)
    expect(parsed.parseFailed).toBe(false)
  })

  // The three empty states are three different faults with three different fixes, and the engine
  // maps each to its own `no_choice` reason. Collapsing them would leave a step that quietly
  // delivered nothing with nothing to explain it.
  it('keeps a missing block, an unreadable one and an explicit none apart', () => {
    expect(parseBinaryCandidateDeclaration('no block here').undeclared).toBe(true)
    expect(parseBinaryCandidateDeclaration(block('{oops')).parseFailed).toBe(true)
    const none = parseBinaryCandidateDeclaration(block('none'))
    expect(none).toMatchObject({ candidates: [], undeclared: false, parseFailed: false })
  })

  it('counts malformed entries rather than shortening the list silently', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([{ service: 'asset-store' }, { location: 'x.png' }, 'nope'])),
    )
    expect(parsed.candidates).toEqual([])
    expect(parsed.invalidEntries).toBe(3)
  })

  it('counts what it dropped past the cap, so the list reads as a prefix', () => {
    const many = Array.from({ length: MAX_BINARY_CANDIDATES + 3 }, (_, i) => ({
      service: 'asset-store',
      location: `staging/${i}.png`,
    }))
    const parsed = parseBinaryCandidateDeclaration(block(JSON.stringify(many)))
    expect(parsed.candidates).toHaveLength(MAX_BINARY_CANDIDATES)
    expect(parsed.omitted).toBe(3)
  })

  // A refused preview costs the candidate its picture, never its row: the location and the
  // generator are what the comparison is anchored on.
  it('keeps a candidate whose preview link is refused, and counts the refusal', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([
          { service: 'a', location: 'x.png', previewUrl: 'javascript:alert(1)' },
          { service: 'a', location: 'y.png', previewUrl: 'http://cdn.example/y.png' },
        ]),
      ),
    )
    expect(parsed.candidates).toHaveLength(2)
    expect(parsed.candidates.every((c) => c.previewUrl === undefined)).toBe(true)
    expect(parsed.unusablePreviews).toBe(2)
  })

  // The LAST block wins, because the guidance asks the agent to END its reply with it and models
  // routinely illustrate the shape first.
  it('takes the last block when a reply illustrates the shape first', () => {
    const output = [
      block(JSON.stringify([{ service: 'example', location: 'ignore-me.png' }])),
      block(JSON.stringify([{ service: 'asset-store', location: 'real.png' }])),
    ].join('\n\n')
    expect(parseBinaryCandidateDeclaration(output).candidates[0]?.location).toBe('real.png')
  })
})

describe('isRenderablePreviewUrl', () => {
  it('admits https and refuses everything else, loopback and cleartext included', () => {
    expect(isRenderablePreviewUrl('https://cdn.example/a.png')).toBe(true)
    expect(isRenderablePreviewUrl('http://cdn.example/a.png')).toBe(false)
    expect(isRenderablePreviewUrl('http://127.0.0.1:9000/a.png')).toBe(false)
    expect(isRenderablePreviewUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isRenderablePreviewUrl('not a url')).toBe(false)
  })
})

describe('renderBinaryCandidateSection', () => {
  it('tells the agent to generate from EVERY integration and to store nothing as final', () => {
    const lines = renderBinaryCandidateSection({
      comparison: {},
      selected: [generator(), generator({ id: 'flux', name: 'Flux' })],
    }).join('\n')
    expect(lines).toContain('EVERY integration')
    expect(lines).toContain('Do NOT store anything at its final location')
    expect(lines).toContain('```binary-candidates')
    // The delivering declaration is deliberately NOT asked for in this pass.
    expect(lines).toContain('Do not declare `binary-outputs` in this pass')
  })

  // `candidate-batch` changes the INSTRUCTION rather than a control: asking a one-per-call API
  // for four in one request sends a parameter it rejects, and repeating a batched call multiplies
  // the bill. No description could have said which.
  it('asks for a batch only from integrations that declare they can return one', () => {
    const batched = renderBinaryCandidateSection({
      comparison: { perGenerator: 3 },
      selected: [generator({ capabilities: ['candidate-batch'] })],
    }).join('\n')
    expect(batched).toContain('can return several candidates from ONE call')

    const unbatched = renderBinaryCandidateSection({
      comparison: { perGenerator: 3 },
      selected: [generator()],
    }).join('\n')
    expect(unbatched).toContain('repeat the request with a different seed')
  })

  it('reconciles a fixed seed with the ask for several candidates', () => {
    const lines = renderBinaryCandidateSection({
      comparison: { perGenerator: 2 },
      selected: [generator()],
      fixedSeed: 7,
    }).join('\n')
    expect(lines).toContain('fixes a seed (7)')
  })
})

describe('renderBinaryCandidateChoiceSection', () => {
  const state = (): BinaryCandidateStepState => ({
    status: 'chosen',
    multiSelect: true,
    invalidEntries: 0,
    omitted: 0,
    unusablePreviews: 0,
    candidates: [
      { id: 'cand_1', service: 'asset-store', location: 'staging/a.png', generator: 'flux' },
      { id: 'cand_2', service: 'asset-store', location: 'staging/b.png', generator: 'retro' },
      { id: 'cand_3', service: 'asset-store', location: 'staging/c.png' },
    ],
    choice: {
      kept: [
        { candidateId: 'cand_1', storeAs: 'anvil-photo' },
        { candidateId: 'cand_2', storeAs: 'anvil-pixel' },
      ],
      discarded: ['cand_3'],
      note: 'lighten the pixel one',
      at: 1,
    },
  })

  it('names each kept candidate with the id it must be stored under', () => {
    const lines = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(lines).toContain('Store it as `anvil-photo`')
    expect(lines).toContain('Store it as `anvil-pixel`')
  })

  // The staged files exist. A pass that promotes one and forgets the rest leaves an asset store
  // with four sprites in it, of which one is the sprite.
  it('names the discarded candidates and asks for them to be cleared up', () => {
    const lines = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(lines).toContain('DISCARD')
    expect(lines).toContain('`staging/c.png`')
  })

  it('folds the human note in and refuses a second comparison round', () => {
    const lines = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(lines).toContain('lighten the pixel one')
    expect(lines).toContain('do NOT declare `binary-candidates` again')
  })

  it('renders nothing before a choice exists', () => {
    expect(
      renderBinaryCandidateChoiceSection({ ...state(), status: 'awaiting_choice', choice: null }),
    ).toEqual([])
  })
})

describe('parseBinaryCandidateDeclaration: entries that are not candidates at all', () => {
  // `JSON.parse` yields whatever the model wrote, and the object guard is what stands between that
  // and a property read. `null` is the member of that set with teeth: `typeof null === 'object'`,
  // so the guard's FIRST clause is the only thing stopping `record.service` throwing out of a parse
  // whose whole contract is to COUNT what it could not read.
  it('counts a null entry as invalid rather than throwing out of the parse', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([null, { service: 'asset-store', location: 'real.png' }])),
    )
    expect(parsed.invalidEntries).toBe(1)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.parseFailed).toBe(false)
  })

  it('counts a nested array and a bare number as invalid', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([[{ service: 'a', location: 'b.png' }], 7])),
    )
    expect(parsed.candidates).toEqual([])
    expect(parsed.invalidEntries).toBe(2)
  })

  // A single object rather than an array is the shape a model reaches for when it has one
  // candidate, and reading it is worth more than refusing it: the alternative is a `parseFailed`
  // over a declaration whose content was fine.
  it('accepts a lone object where the contract asks for an array', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify({ service: 'asset-store', location: 'only.png' })),
    )
    expect(parsed.candidates).toEqual([{ service: 'asset-store', location: 'only.png' }])
  })
})

describe('parseBinaryCandidateDeclaration: the field caps', () => {
  it('trims the identity fields, so a padded location addresses the same file', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([
          { service: '  Asset-Store\n', location: '  staging/a.png  ', generator: ' Flux ' },
        ]),
      ),
    )
    expect(parsed.candidates[0]).toEqual({
      service: 'asset-store',
      location: 'staging/a.png',
      generator: 'flux',
    })
  })

  it('refuses an identity field past its cap, because a truncated address is a wrong one', () => {
    // An elided location is not a shorter location: it names a file that does not exist, and the
    // promotion pass would fail on it. The entry is counted instead.
    //
    // Probed AT the cap and one past it, which is the only pair that pins the comparison itself:
    // a location of exactly `MAX_IDENTITY_CHARS` is addressable and must be kept, and reading the
    // bound as `>=` would refuse it while every test on a round 600 stayed green.
    const location = (length: number) => 'x'.repeat(length)
    const atCap = parseBinaryCandidateDeclaration(
      block(JSON.stringify([{ service: 'asset-store', location: location(MAX_IDENTITY_CHARS) }])),
    )
    expect(atCap.candidates[0]?.location).toBe(location(MAX_IDENTITY_CHARS))
    expect(atCap.invalidEntries).toBe(0)

    const pastCap = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([{ service: 'asset-store', location: location(MAX_IDENTITY_CHARS + 1) }]),
      ),
    )
    expect(pastCap.candidates).toEqual([])
    expect(pastCap.invalidEntries).toBe(1)
  })

  it('elides an over-long DISPLAY field to exactly the cap, with a marker', () => {
    // The opposite disposition, for the opposite reason: a note is read by a human comparing
    // candidates, so a long one is worth keeping shortened, and the marker is what says so.
    //
    // The retained LENGTH is asserted rather than merely "shorter with a marker": a slice bound
    // that collapsed to nothing would still end in the marker and still be shorter, so the loose
    // assertion passes on a note thrown away whole.
    const note = 'n'.repeat(MAX_DISPLAY_CHARS + 600)
    const parsed = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([{ service: 'asset-store', location: 'a.png', note, label: '  Anvil  ' }]),
      ),
    )
    const [candidate] = parsed.candidates
    expect(candidate?.note).toBe(`${'n'.repeat(MAX_DISPLAY_CHARS)}…`)
    expect(candidate?.label).toBe('Anvil')
  })

  it('keeps a display field that fits exactly as written, with no marker', () => {
    // AT the cap, not comfortably inside it: `>` and `>=` differ on exactly this note, and only
    // this length can tell them apart. Reading the bound as `>=` appends a marker to a note that
    // lost nothing, which claims a truncation that did not happen.
    const note = 'n'.repeat(MAX_DISPLAY_CHARS)
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([{ service: 'asset-store', location: 'a.png', note }])),
    )
    expect(parsed.candidates[0]?.note).toBe(note)
  })
})

describe('parseBinaryCandidateDeclaration: a refused preview versus none at all', () => {
  // Two different facts the surface reports to a human: "the agent offered a link we would not
  // render" and "the agent offered no link". Counting the second as the first turns every ordinary
  // candidate into a reported problem, which is how a real refusal stops being noticed.
  it('counts NO refusal for a candidate that declared no preview', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([{ service: 'asset-store', location: 'a.png' }])),
    )
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.unusablePreviews).toBe(0)
  })

  it('counts NO refusal for a preview it accepted', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(
        JSON.stringify([
          { service: 'asset-store', location: 'a.png', previewUrl: 'https://cdn.example/a.png' },
        ]),
      ),
    )
    expect(parsed.candidates[0]?.previewUrl).toBe('https://cdn.example/a.png')
    expect(parsed.unusablePreviews).toBe(0)
  })

  it('counts a whitespace-only preview as no preview rather than as a refusal', () => {
    const parsed = parseBinaryCandidateDeclaration(
      block(JSON.stringify([{ service: 'asset-store', location: 'a.png', previewUrl: '   ' }])),
    )
    expect(parsed.candidates[0]?.previewUrl).toBeUndefined()
    expect(parsed.unusablePreviews).toBe(0)
  })
})

describe('renderBinaryCandidateSection: how many, and from where', () => {
  const section = (input: Parameters<typeof renderBinaryCandidateSection>[0]) =>
    renderBinaryCandidateSection(input).join('\n')

  it('asks for ONE candidate per subject in the singular', () => {
    const one = section({
      comparison: { perGenerator: 1 },
      selected: [generator(), generator({ id: 'flux' })],
    })
    expect(one).toContain('- Generate one candidate per subject from EVERY integration')
    // Nothing to say about batching or seeds while one call per integration is the whole ask.
    expect(one).not.toContain('from ONE call')
    expect(one).not.toContain('repeat the request with a different seed')
  })

  it('asks for several per subject in the plural, from every integration', () => {
    const several = section({
      comparison: { perGenerator: 4 },
      selected: [generator(), generator({ id: 'flux' })],
    })
    expect(several).toContain('- Generate 4 candidates per subject from EVERY integration')
  })

  it('asks a SINGLE integration to make its candidates differ, and says how to record that', () => {
    // With one producer the comparison is within it, so the instruction changes: sameness is the
    // failure mode, and the `note` is where the difference is stated.
    const solo = section({ comparison: { perGenerator: 3 }, selected: [generator()] })
    expect(solo).toContain('- Generate 3 candidates per subject.')
    expect(solo).toContain('Make them meaningfully different from each other')
    expect(solo).not.toContain('EVERY integration')
  })

  it('inflects the single-integration ask for exactly one candidate', () => {
    const solo = section({ comparison: { perGenerator: 1 }, selected: [generator()] })
    expect(solo).toContain('- Generate 1 candidate per subject.')
  })

  it('defaults to one candidate per subject when the comparison names no count', () => {
    expect(section({ comparison: {}, selected: [generator()] })).toContain(
      '- Generate 1 candidate per subject.',
    )
  })

  it('names the batching integrations without a stray conjunction for a single one', () => {
    const one = section({
      comparison: { perGenerator: 2 },
      selected: [generator({ capabilities: ['candidate-batch'] })],
    })
    expect(one).toContain('- `retro-diffusion` can return several candidates from ONE call')
    const two = section({
      comparison: { perGenerator: 2 },
      selected: [
        generator({ capabilities: ['candidate-batch'] }),
        generator({ id: 'flux', capabilities: ['candidate-batch'] }),
      ],
    })
    expect(two).toContain('- `retro-diffusion` and `flux` can return several candidates')
  })

  it('says nothing about a fixed seed while only one candidate per subject is asked for', () => {
    // Varying a seed is meaningless below two candidates, and the fixed seed is then simply the
    // seed: a paragraph reconciling them would read as a contradiction that is not there.
    expect(
      section({ comparison: { perGenerator: 1 }, selected: [generator()], fixedSeed: 7 }),
    ).not.toContain('fixes a seed')
    expect(section({ comparison: { perGenerator: 2 }, selected: [generator()] })).not.toContain(
      'fixes a seed',
    )
    expect(
      section({ comparison: { perGenerator: 2 }, selected: [generator()], fixedSeed: 0 }),
    ).toContain('fixes a seed (0)')
  })
})

describe('renderBinaryCandidateChoiceSection: the decision as work', () => {
  const state = (overrides: Partial<BinaryCandidateStepState> = {}): BinaryCandidateStepState => ({
    status: 'chosen',
    multiSelect: true,
    invalidEntries: 0,
    omitted: 0,
    unusablePreviews: 0,
    candidates: [
      { id: 'cand_1', service: 'asset-store', location: 'staging/a.png', generator: 'flux' },
      { id: 'cand_2', service: 'asset-store', location: 'staging/b.png' },
    ],
    choice: { kept: [{ candidateId: 'cand_1' }], discarded: ['cand_2'], at: 1 },
    ...overrides,
  })

  it('skips a kept id no candidate answers to rather than throwing', () => {
    // The choice and the candidate list are two persisted halves of one step, so a decision can
    // name an id the list no longer holds. Rendering the rest is the honest outcome; a property
    // read on the missing one would fail the whole dispatch.
    const lines = renderBinaryCandidateChoiceSection(
      state({
        choice: {
          kept: [{ candidateId: 'cand_gone' }, { candidateId: 'cand_1' }],
          discarded: [],
          at: 1,
        },
      }),
    ).join('\n')
    expect(lines).toContain('`staging/a.png`')
    expect(lines).not.toContain('cand_gone')
  })

  it('falls back to the step ordinary naming where the decision named no id', () => {
    const lines = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(lines).toContain("Store it under this step's ordinary naming.")
    expect(lines).not.toContain('Store it as `')
  })

  it('names an unattributed candidate as unattributed rather than omitting the clause', () => {
    const lines = renderBinaryCandidateChoiceSection(
      state({ choice: { kept: [{ candidateId: 'cand_2' }], discarded: [], at: 1 } }),
    ).join('\n')
    expect(lines).toContain('(from an unattributed generator)')
  })

  it('inflects the discard instruction for one candidate and for several', () => {
    const one = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(one).toContain(
      'DISCARD the 1 candidate the person did not keep, and remove the staged file ',
    )

    const two = renderBinaryCandidateChoiceSection(
      state({
        candidates: [
          { id: 'cand_1', service: 'asset-store', location: 'staging/a.png' },
          { id: 'cand_2', service: 'asset-store', location: 'staging/b.png' },
          { id: 'cand_3', service: 'asset-store', location: 'staging/c.png' },
        ],
        choice: { kept: [{ candidateId: 'cand_1' }], discarded: ['cand_2', 'cand_3'], at: 1 },
      }),
    ).join('\n')
    expect(two).toContain(
      'DISCARD the 2 candidates the person did not keep, and remove the staged files',
    )
    expect(two).toContain('`staging/b.png`, `staging/c.png`')
  })

  // The same two persisted halves the kept-id case above is about, read from the other side. The
  // count and the list are produced from ONE reduction on purpose, so the instruction can never
  // claim more files than it names: an agent told to remove three and handed two locations has to
  // guess at the third.
  it('counts only the discarded candidates it can still name', () => {
    const lines = renderBinaryCandidateChoiceSection(
      state({
        choice: {
          kept: [{ candidateId: 'cand_1' }],
          discarded: ['cand_gone', 'cand_2'],
          at: 1,
        },
      }),
    ).join('\n')
    expect(lines).toContain('DISCARD the 1 candidate the person did not keep')
    expect(lines).toContain('`staging/b.png`')
    expect(lines).not.toContain('cand_gone')
  })

  it('omits the discard instruction when NO discarded id resolves, having no file to name', () => {
    // The honest end of the same rule rather than an oversight: a candidate the list no longer
    // holds has no recorded `location`, so there is no staged file to point the agent at and an
    // instruction naming none would be one it cannot act on. The loss is the candidate record,
    // which happened before this render.
    const lines = renderBinaryCandidateChoiceSection(
      state({
        choice: { kept: [{ candidateId: 'cand_1' }], discarded: ['cand_gone'], at: 1 },
      }),
    ).join('\n')
    expect(lines).not.toContain('DISCARD')
    // The rest of the brief is unaffected: the kept candidate still gets its instruction.
    expect(lines).toContain('`staging/a.png`')
  })

  it('says nothing about discarding when the person kept everything', () => {
    const lines = renderBinaryCandidateChoiceSection(
      state({
        choice: {
          kept: [{ candidateId: 'cand_1' }, { candidateId: 'cand_2' }],
          discarded: [],
          at: 1,
        },
      }),
    ).join('\n')
    expect(lines).not.toContain('DISCARD')
  })

  it('omits the note paragraph entirely when the person left none', () => {
    const lines = renderBinaryCandidateChoiceSection(state()).join('\n')
    expect(lines).not.toContain('The person who chose added:')
  })
})
