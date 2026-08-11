import { binaryGeneratorCapabilitySchema } from '@cat-factory/contracts'
import type { BinaryGenerationOptions } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { BinaryGeneratorView } from './binary-generator-registry.js'
import {
  binaryGeneratorSelectionIssues,
  describeBinaryGeneratorSelectionIssues,
  renderBinaryGeneratorSection,
  resolveBinaryGeneratorSelection,
} from './binary-generators.js'

// The GENERATION OPTIONS half of `binary-generators.ts`: the two finest refusal axes (a capability
// nothing declares, a value nothing accepts) and the instructions `generationOptionLines` writes
// for the options that were admitted.
//
// Its own file rather than more of `binary-generators.test.ts`, which the selection, the brief's
// per-integration entries and the requirement lines already fill: this is one function's surface
// and every fixture here declares capabilities, which nothing in that file needs.

function generator(overrides: Partial<BinaryGeneratorView> = {}): BinaryGeneratorView {
  return {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: 'Good for sprites and tiles; not for photorealism.',
    modalities: ['image'],
    mediaTypes: ['image/png'],
    capabilities: [],
    endpoint: 'https://api.retrodiffusion.ai/v1',
    credentials: [{ key: 'RD_TOKEN', usage: 'the X-RD-Token request header' }],
    contracts: [],
    ...overrides,
  }
}

describe('generation options', () => {
  // The THIRD refusal axis, and it has the same three outcomes the format one does. That is what
  // lets it ship without invalidating every integration registered before capabilities existed.
  it('refuses an option no DECLARING integration supports', () => {
    const issues = binaryGeneratorSelectionIssues(
      {
        storageServiceId: 'store',
        generatorIds: ['retro-diffusion'],
        generation: { seed: 7 },
      },
      [generator({ capabilities: ['aspect-ratio'] })],
    )
    expect(issues).toEqual([{ problem: 'capability_unsupported', capability: 'seed' }])
  })

  // The motivating case, end to end at the refusal: a step whose deliverable is a 96x96 sprite,
  // holding an integration that can only be asked for a bucket, is refused BEFORE it spends
  // anything. Left admitted it succeeds, charges, stores a downscaled render, and every other
  // check on it passes.
  it('refuses an exact size against an integration that only takes a shape', () => {
    const issues = binaryGeneratorSelectionIssues(
      {
        storageServiceId: 'store',
        generatorIds: ['retro-diffusion'],
        generation: { outputSize: { width: 96, height: 96 } },
      },
      [generator({ capabilities: ['aspect-ratio'] })],
    )
    expect(issues).toEqual([{ problem: 'capability_unsupported', capability: 'exact-size' }])
  })

  it('states the exact size to the agent as a requirement, not a preference', () => {
    const section = renderBinaryGeneratorSection({
      selection: resolveBinaryGeneratorSelection(
        { storageServiceId: 'store', generatorIds: ['retro-diffusion'] },
        [generator({ capabilities: ['exact-size'] })],
      ),
      requestedModalities: [],
      generation: { outputSize: { width: 96, height: 96 } },
    }).join('\n')
    expect(section).toContain('EXACTLY 96x96 pixels')
    // The brief deliberately states NO resize policy: the platform has no view of whether a
    // downscale is acceptable for a given asset. What it does require is that a substitution is
    // reported and the delivered size declared, so the loss is never silent.
    expect(section).toContain('declare the size you actually delivered')
  })

  it('admits an option nothing has declared either way', () => {
    const issues = binaryGeneratorSelectionIssues(
      { storageServiceId: 'store', generatorIds: ['retro-diffusion'], generation: { seed: 7 } },
      [generator({ capabilities: [] })],
    )
    expect(issues).toEqual([])
  })

  // The requirement is DERIVED, so one reference image never trips the multi-reference rule.
  it('asks for multi-reference only above one reference image', () => {
    const config = (count: number) => ({
      storageServiceId: 'store',
      generatorIds: ['retro-diffusion'],
      generation: {
        referenceImages: Array.from({ length: count }, () => ({
          location: 'a.png',
          role: 'style' as const,
        })),
      },
    })
    const only = [generator({ capabilities: ['reference-image'] })]
    expect(binaryGeneratorSelectionIssues(config(1), only)).toEqual([])
    expect(binaryGeneratorSelectionIssues(config(2), only)).toEqual([
      { problem: 'capability_unsupported', capability: 'multi-reference' },
    ])
  })

  it('names the unsupported capability in words an operator can act on', () => {
    const message = describeBinaryGeneratorSelectionIssues('imager', [
      { problem: 'capability_unsupported', capability: 'mask-edit' },
    ])
    expect(message).toContain('editing only the region an image mask names')
    expect(message).not.toContain('undefined')
  })

  it('states the options, who honours them, and what could not be checked', () => {
    const lines = renderBinaryGeneratorSection({
      selection: {
        selected: [
          generator({ id: 'flux', capabilities: ['seed', 'reference-image'] }),
          generator({ id: 'nano', capabilities: ['reference-image'] }),
        ],
        unresolvedIds: [],
      },
      requestedModalities: [],
      generation: {
        seed: 7,
        referenceImages: [{ location: 'refs/hero.png', service: 'asset-store', role: 'subject' }],
      },
    }).join('\n')
    // A reference the platform never fetches has to be NAMED, or the agent generates without it
    // and reports success.
    expect(lines).toContain('`refs/hero.png` in the `asset-store` service')
    // With two producers, "supported" is not the whole answer: an option one of them ignores
    // leaves nothing on the artifact to say which happened.
    expect(lines).toContain('a fixed seed: `flux`.')
    expect(lines).toContain('The others do not declare it')
  })

  it('states an unverifiable option as unknown rather than as unavailable', () => {
    const lines = renderBinaryGeneratorSection({
      selection: { selected: [generator({ capabilities: [] })], unresolvedIds: [] },
      requestedModalities: [],
      generation: { tileable: true },
    }).join('\n')
    expect(lines).toContain('unknown rather than settled')
  })
})

describe('generation option VALUES', () => {
  const bucketed = generator({
    id: 'grok-imagine',
    capabilities: ['aspect-ratio'],
    accepts: { aspectRatios: ['1:1', '16:9', '9:16'] },
  })
  const anyRatio = generator({ id: 'flux', capabilities: ['aspect-ratio'] })

  // The fourth refusal axis, and the failure it exists for: the option is supported, so the call
  // succeeds and comes back cropped to whatever the vendor's picklist rounded to. Every check
  // downstream passes.
  it('refuses a value every declaring integration enumerated away', () => {
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'store',
          generatorIds: ['grok-imagine'],
          generation: { aspectRatio: '7:3' },
        },
        [bucketed],
      ),
    ).toEqual([
      {
        problem: 'option_value_unaccepted',
        value: { option: 'aspectRatio', requested: '7:3', accepted: ['1:1', '16:9', '9:16'] },
      },
    ])
  })

  // The state that keeps this from retroactively refusing working selections: an integration
  // that declared the capability and no set has said nothing about this value, so the step is
  // admitted and the gap is reported to the agent instead.
  it('admits a value a silent declarer might still serve', () => {
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'store',
          generatorIds: ['grok-imagine', 'flux'],
          generation: { aspectRatio: '7:3' },
        },
        [bucketed, anyRatio],
      ),
    ).toEqual([])
  })

  it('names the value and what IS accepted in words an operator can act on', () => {
    const message = describeBinaryGeneratorSelectionIssues('imager', [
      {
        problem: 'option_value_unaccepted',
        value: { option: 'outputSize', requested: '96x96', accepted: ['1024x1024'] },
      },
    ])
    expect(message).toContain('an output size of 96x96')
    expect(message).toContain('1024x1024')
    expect(message).not.toContain('undefined')
  })

  // On the integration's own entry rather than only under the step's options, because an agent
  // holding two image APIs picks per artifact and this is the kind of fact that decides.
  it('states each integration’s accepted sets beside its formats', () => {
    const lines = renderBinaryGeneratorSection({
      selection: {
        selected: [
          generator({
            id: 'recraft',
            capabilities: ['exact-size', 'upscale'],
            accepts: { outputSizes: [{ width: 1024, height: 1024 }], upscaleFactors: [2] },
          }),
        ],
        unresolvedIds: [],
      },
      requestedModalities: [],
    }).join('\n')
    expect(lines).toContain('Renders at these exact sizes and no others: 1024x1024.')
    expect(lines).toContain('Accepts these upscale factors and no others: 2.')
  })

  // Admission let the step through on the strength of the silent integration, so the agent is the
  // party that has to route around the one that refuses the value, and it can only do that if it
  // is told which fact it is holding.
  it('tells the agent when one integration refuses the value and another has not said', () => {
    const lines = renderBinaryGeneratorSection({
      selection: { selected: [bucketed, anyRatio], unresolvedIds: [] },
      requestedModalities: [],
      generation: { aspectRatio: '7:3' },
    }).join('\n')
    expect(lines).toContain('does NOT accept what this step asks for (an aspect ratio)')
  })

  // The state every registration is in until an endpoint is audited. A brief paragraph fired here
  // would ride nearly every step carrying an aspect ratio, which is how a line stops being read.
  it('says nothing when no selected integration states a set', () => {
    const lines = renderBinaryGeneratorSection({
      selection: { selected: [anyRatio], unresolvedIds: [] },
      requestedModalities: [],
      generation: { aspectRatio: '7:3' },
    }).join('\n')
    expect(lines).not.toContain('does NOT accept what this step asks for')
  })

  // Two enumerating endpoints where only one takes the value: the step is servable, so admission
  // stays out of it, and the providers list directly above names BOTH as honouring the option.
  // Naming the one that will crop is the whole remedy, because routing is the agent's call.
  it('names the integration that enumerated the value away when another accepts it', () => {
    const wide = generator({
      id: 'nano-banana',
      capabilities: ['aspect-ratio'],
      accepts: { aspectRatios: ['7:3', '1:1'] },
    })
    const lines = renderBinaryGeneratorSection({
      selection: { selected: [wide, bucketed], unresolvedIds: [] },
      requestedModalities: [],
      generation: { aspectRatio: '7:3' },
    }).join('\n')
    expect(lines).toContain('`grok-imagine` states the values it accepts')
    expect(lines).toContain('does NOT accept the 7:3 this step asks for')
    expect(lines).not.toContain('`nano-banana` states the values it accepts')
    // Servable by part of the selection, so it is a brief paragraph and not a refusal.
    expect(
      binaryGeneratorSelectionIssues(
        {
          storageServiceId: 'store',
          generatorIds: ['nano-banana', 'grok-imagine'],
          generation: { aspectRatio: '7:3' },
        },
        [wide, bucketed],
      ),
    ).toEqual([])
  })
})

describe('renderBinaryGeneratorSection: the generation-option instructions', () => {
  // One integration declaring EVERY capability, so each case below is about the option's own line
  // and never about a coverage paragraph reacting to an undeclared capability.
  const omnivore = generator({
    id: 'omni',
    capabilities: [...binaryGeneratorCapabilitySchema.options],
  })
  const optionLines = (generation: BinaryGenerationOptions, selected = [omnivore]) =>
    renderBinaryGeneratorSection({
      selection: { selected, unresolvedIds: [] },
      requestedModalities: [],
      generation,
    }).join('\n')

  it('states nothing at all when the step carries no generation options', () => {
    // An empty options bag exercises no capability, so there is no requirement to state. A
    // paragraph here would ride every brief that never asked for anything.
    expect(optionLines({})).not.toContain('These generation options apply to EVERY artifact')
    expect(
      renderBinaryGeneratorSection({
        selection: { selected: [omnivore], unresolvedIds: [] },
        requestedModalities: [],
      }).join('\n'),
    ).not.toContain('These generation options apply to EVERY artifact')
  })

  // Each option is rendered by its own `if`, so each needs both verdicts asserted: an option that
  // is stated when it was never asked for is as wrong as one silently dropped, and a step's
  // options are the only place these values exist — the artifact carries no trace of them.
  const cases: { option: string; generation: BinaryGenerationOptions; marker: string }[] = [
    {
      option: 'negativePrompt',
      generation: { negativePrompt: 'no text' },
      marker: '- Negative prompt: no text',
    },
    { option: 'seed', generation: { seed: 4242 }, marker: '- Seed: 4242.' },
    { option: 'aspectRatio', generation: { aspectRatio: '16:9' }, marker: '- Aspect ratio: 16:9' },
    {
      option: 'outputSize',
      generation: { outputSize: { width: 1024, height: 768 } },
      marker: '- Output size: EXACTLY 1024x768 pixels',
    },
    { option: 'upscale', generation: { upscale: 2 }, marker: '- Upscale the result 2x' },
    {
      option: 'transparentBackground',
      generation: { transparentBackground: true },
      marker: '- Deliver a TRANSPARENT background',
    },
    {
      option: 'tileable',
      generation: { tileable: true },
      marker: '- Deliver a SEAMLESSLY TILING image',
    },
  ]

  for (const { option, generation, marker } of cases) {
    it(`states ${option} when the step asks for it, and says nothing about it otherwise`, () => {
      expect(optionLines(generation)).toContain(marker)
      // Asked for one option, told about one: the other cases' markers must all be absent, which
      // is what pins each `if` to its OWN field rather than to whatever ran first.
      for (const other of cases) {
        if (other.option === option) continue
        expect(optionLines(generation)).not.toContain(other.marker)
      }
    })
  }

  it('states a seed of 0, which is a real seed and the one a falsy check would drop', () => {
    expect(optionLines({ seed: 0 })).toContain('- Seed: 0.')
  })

  it('states an upscale factor without treating it as a flag', () => {
    // `upscale` and `seed` are the two numeric options, so both are read with `!== undefined`.
    expect(optionLines({ upscale: 4 })).toContain('- Upscale the result 4x')
  })
})

describe('renderBinaryGeneratorSection: a step that EDITS existing artifacts', () => {
  const editor = generator({
    id: 'omni',
    capabilities: ['instruction-edit', 'mask-edit', 'reference-image', 'multi-reference'],
  })
  const editLines = (generation: BinaryGenerationOptions) =>
    renderBinaryGeneratorSection({
      selection: { selected: [editor], unresolvedIds: [] },
      requestedModalities: [],
      generation,
    }).join('\n')

  it('names the edit MODE, because the two need different inputs', () => {
    expect(editLines({ edit: { mode: 'mask' } })).toContain(
      '- This step EDITS existing artifacts (masked region only)',
    )
    expect(editLines({ edit: { mode: 'instruction' } })).toContain(
      '- This step EDITS existing artifacts (whole-artifact instruction)',
    )
  })

  it('carries the instruction when the step wrote one, and omits the clause otherwise', () => {
    expect(editLines({ edit: { mode: 'instruction', instruction: 'make it dusk' } })).toContain(
      'What to change: make it dusk',
    )
    expect(editLines({ edit: { mode: 'instruction' } })).not.toContain('What to change:')
  })

  it('points at the artifact to revise, or says the scope services decide which one', () => {
    // The platform never fetches these, so an agent not told where the file lives generates
    // without it and reports success.
    expect(
      editLines({
        edit: { mode: 'instruction', source: { location: 'sprites/hero.png', service: 'assets' } },
      }),
    ).toContain('- The artifact to revise: `sprites/hero.png` in the `assets` service')
    expect(editLines({ edit: { mode: 'instruction' } })).toContain(
      'comes from the scope services below, not from this step',
    )
  })

  // The deadliest line in this module: told nothing, an agent handed a masked edit with no mask
  // does the whole-artifact edit instead, and every downstream check passes on an artifact that
  // was rewritten where it should have been untouched.
  it('REFUSES to let a masked edit with no mask fall back to editing the whole artifact', () => {
    const missing = editLines({ edit: { mode: 'mask' } })
    expect(missing).toContain('NO mask was configured for this masked edit')
    expect(missing).toContain('Do not fall back to editing the whole artifact')
    expect(missing).toContain('report that the mask was missing')
  })

  it('points at the mask when one was configured', () => {
    expect(editLines({ edit: { mode: 'mask', mask: { location: 'masks/corner.png' } } })).toContain(
      '- The mask: `masks/corner.png` (fetch it yourself; it is not attached to this job)',
    )
  })

  it('says nothing about a mask for an INSTRUCTION edit, which takes none', () => {
    const instruction = editLines({ edit: { mode: 'instruction' } })
    expect(instruction).not.toContain('The mask:')
    expect(instruction).not.toContain('NO mask was configured')
  })

  it('names each reference image by role, with its note, and where it lives', () => {
    const text = editLines({
      referenceImages: [
        { location: 'refs/palette.png', role: 'style', note: 'match the palette only.' },
        { location: 'refs/hero.png', role: 'subject', service: 'assets' },
      ],
    })
    expect(text).toContain('- Reference image (style): `refs/palette.png` (fetch it yourself')
    expect(text).toContain('match the palette only.')
    expect(text).toContain('- Reference image (subject): `refs/hero.png` in the `assets` service')
  })
})

describe('renderBinaryGeneratorSection: which integrations honour which option', () => {
  const seeded = generator({ id: 'retro-diffusion', capabilities: ['seed', 'aspect-ratio'] })
  const plain = generator({
    id: 'studio-art',
    capabilities: ['aspect-ratio'],
    modalities: ['image'],
  })

  const text = (selected: BinaryGeneratorView[], generation: BinaryGenerationOptions) =>
    renderBinaryGeneratorSection({
      selection: { selected, unresolvedIds: [] },
      requestedModalities: [],
      generation,
    }).join('\n')

  it('says nothing about routing while the step holds ONE integration', () => {
    // With one producer there is no choice to make, and a paragraph that rides every brief is one
    // agents stop reading.
    expect(text([seeded], { seed: 7 })).not.toContain('Not every integration honours every option')
  })

  it('warns that the OTHERS do not declare an option only some of them honour', () => {
    const both = text([seeded, plain], { seed: 7 })
    expect(both).toContain('Not every integration honours every option')
    expect(both).toContain('- a fixed seed: `retro-diffusion`.')
    expect(both).toContain('The others do not declare it')
  })

  it('drops the "others" clause where EVERY selected integration declares the option', () => {
    // The boundary is `declaring < selected`: an option all of them honour is a covered
    // requirement, and warning about others that do not exist would read as a partial capability.
    const shared = text([seeded, plain], { aspectRatio: '16:9' })
    expect(shared).toContain('- an explicit aspect ratio: `retro-diffusion` and `studio-art`.')
    expect(shared).not.toContain('The others do not declare it')
  })

  it('inflects the unverifiable-capability sentence for one option and for several', () => {
    // Nothing declares the capability AND at least one integration declared no capabilities at
    // all: unknown rather than settled, which is neither of the two things the agent would assume.
    const silent = generator({ id: 'quiet', capabilities: undefined })
    const one = text([silent], { seed: 7 })
    expect(one).toContain('No selected integration declares support for a fixed seed')
    expect(one).toContain('before relying on it')
    const several = text([silent], { seed: 7, tileable: true })
    expect(several).toContain('before relying on them')
  })
})
