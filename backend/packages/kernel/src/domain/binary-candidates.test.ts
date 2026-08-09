import { describe, expect, it } from 'vitest'
import type { BinaryCandidateStepState } from '@cat-factory/contracts'
import type { BinaryGeneratorView } from './binary-generator-registry.js'
import {
  MAX_BINARY_CANDIDATES,
  isRenderablePreviewUrl,
  parseBinaryCandidateDeclaration,
  renderBinaryCandidateChoiceSection,
  renderBinaryCandidateSection,
} from './binary-candidates.js'

function generator(overrides: Partial<BinaryGeneratorView> = {}): BinaryGeneratorView {
  return {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: '',
    modalities: ['image'],
    mediaTypes: ['image/png'],
    capabilities: [],
    credentials: [],
    contracts: [],
    ...overrides,
  }
}

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
