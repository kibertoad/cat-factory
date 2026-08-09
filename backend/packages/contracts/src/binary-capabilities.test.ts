import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  binaryCapabilityCoverage,
  binaryCapabilityProviders,
  binaryGenerationOptionsObject,
  binaryGeneratorCapabilitySchema,
  conflictingOutputSizeOptions,
  isBinaryGeneratorCapability,
  MAX_BINARY_PIXEL_EXTENT,
  requiredBinaryCapabilities,
  type BinaryGenerationOptions,
} from './binary-capabilities.js'

// The DRIFT GUARD for the one hand-written type in this module. `binaryGenerationOptionsSchema`
// is annotated `GenericSchema<unknown, BinaryGenerationOptions>` so no consumer re-infers a shape
// that sits at the bottom of the deepest schema chain in the product (inferring it there pushed
// `tsc` past its instantiation limit in a package three hops away). The cost of that annotation is
// that the schema and the interface can no longer disagree loudly on their own, so they are made
// to disagree HERE: the two assignments below fail the typecheck the moment either side gains,
// loses or retypes a field.
//
// Assignability BOTH ways, not one: a one-directional check passes happily while the interface
// carries a field the schema never parses, which is the more likely drift (someone adds an option
// to the type, forgets the schema, and every value of it silently disappears at the write
// boundary).
type Inferred = v.InferOutput<typeof binaryGenerationOptionsObject>
const _schemaSatisfiesInterface: BinaryGenerationOptions = {} as Inferred
const _interfaceSatisfiesSchema: Inferred = {} as BinaryGenerationOptions
void _schemaSatisfiesInterface
void _interfaceSatisfiesSchema

describe('binary generation options', () => {
  it('parses a full option bag through the annotated schema', () => {
    const parsed = v.parse(binaryGenerationOptionsObject, {
      referenceImages: [{ location: 'assets/hero.png', service: 'asset-store', role: 'subject' }],
      edit: { mode: 'mask', instruction: 'repaint the sky', mask: { location: 'm.png' } },
      negativePrompt: 'text, watermark',
      seed: 42,
      aspectRatio: '16:9',
      upscale: 2,
      transparentBackground: true,
      tileable: true,
    })
    expect(parsed.referenceImages?.[0]?.role).toBe('subject')
    expect(parsed.edit?.mask?.location).toBe('m.png')
  })

  it('refuses an aspect ratio that is not W:H', () => {
    expect(v.safeParse(binaryGenerationOptionsObject, { aspectRatio: 'wide' }).success).toBe(false)
  })

  // Both members together, always. A width with no height describes no deliverable, and a size
  // that parsed with half of it would reach the brief as a requirement nothing could satisfy.
  it('requires both halves of an output size, as whole positive pixels', () => {
    const parse = (outputSize: unknown) =>
      v.safeParse(binaryGenerationOptionsObject, { outputSize }).success
    expect(parse({ width: 96, height: 96 })).toBe(true)
    expect(parse({ width: 96 })).toBe(false)
    expect(parse({ width: 96, height: 0 })).toBe(false)
    expect(parse({ width: 96, height: 96.5 })).toBe(false)
    expect(parse({ width: 96, height: MAX_BINARY_PIXEL_EXTENT + 1 })).toBe(false)
  })
})

describe('requiredBinaryCapabilities', () => {
  // The requirement is DERIVED, so a step is never refused over a capability it does not
  // exercise. One reference image is not the same ask as three.
  it('asks for multi-reference only above one reference image', () => {
    expect(requiredBinaryCapabilities({ referenceImages: [ref()] })).toEqual(['reference-image'])
    expect(requiredBinaryCapabilities({ referenceImages: [ref(), ref()] })).toEqual([
      'reference-image',
      'multi-reference',
    ])
  })

  it('maps an edit to exactly the capability its mode names', () => {
    expect(requiredBinaryCapabilities({ edit: { mode: 'instruction' } })).toEqual([
      'instruction-edit',
    ])
    expect(requiredBinaryCapabilities({ edit: { mode: 'mask' } })).toEqual(['mask-edit'])
  })

  // The whole reason `exact-size` is its own member. A bucketed endpoint (`image_size`,
  // `resolution: 1k | 2k`) honours a RATIO exactly and exact dimensions not at all, so a step
  // whose deliverable is a 96x96 icon must not be admitted against one on the strength of an
  // `aspect-ratio` declaration. Asserted from both directions, because the failure that matters
  // is silent in one of them: a size requirement resolving to `aspect-ratio` would look covered.
  it('tells an exact size apart from an aspect ratio', () => {
    expect(requiredBinaryCapabilities({ outputSize: { width: 96, height: 96 } })).toEqual([
      'exact-size',
    ])
    expect(requiredBinaryCapabilities({ aspectRatio: '1:1' })).toEqual(['aspect-ratio'])

    // Grok Imagine's shape: a `resolution` of 1k or 2k, so a ratio is honoured exactly and a
    // pixel size not at all. Only `capabilities` is read here, which is why the vendor each list
    // stands for is carried by its NAME rather than by an id the function never looks at.
    const bucketed = [{ capabilities: ['aspect-ratio' as const] }]
    expect(binaryCapabilityCoverage(['exact-size'], bucketed)).toEqual({
      uncovered: ['exact-size'],
      unverifiable: [],
    })
    // And the converse holds: the vocabulary is FLAT, so an integration that takes width and
    // height covers a ratio only by DECLARING that too. Forgetting the second word is a loud
    // refusal naming the capability, which is the trade an implication table would buy out.
    const dimensioned = [{ capabilities: ['exact-size' as const] }]
    expect(binaryCapabilityCoverage(['aspect-ratio'], dimensioned).uncovered).toEqual([
      'aspect-ratio',
    ])
    expect(
      binaryCapabilityCoverage(
        ['aspect-ratio', 'exact-size'],
        [{ capabilities: ['aspect-ratio' as const, 'exact-size' as const] }],
      ).uncovered,
    ).toEqual([])
  })

  it('requires nothing of a step with no options', () => {
    expect(requiredBinaryCapabilities(undefined)).toEqual([])
    expect(requiredBinaryCapabilities({})).toEqual([])
  })

  // Every option key maps to a capability, checked against the schema's own key list rather than
  // a hand-written one: an option added without a requirement would otherwise ship as a control
  // the platform offers and never checks. A total over the vocabulary would be re-pinned unread
  // on every addition, so what is asserted is the structural property.
  it('derives a requirement for every declared option', () => {
    const full: BinaryGenerationOptions = {
      referenceImages: [ref()],
      edit: { mode: 'instruction' },
      negativePrompt: 'x',
      seed: 1,
      aspectRatio: '1:1',
      outputSize: { width: 96, height: 96 },
      upscale: 2,
      transparentBackground: true,
      tileable: true,
    }
    for (const key of Object.keys(binaryGenerationOptionsObject.entries)) {
      const only = { [key]: full[key as keyof BinaryGenerationOptions] }
      expect(requiredBinaryCapabilities(only as BinaryGenerationOptions).length).toBeGreaterThan(0)
    }
  })
})

// The one rule the pipeline SAVE and the pipeline BUILDER both read, so a selection the backend
// refuses cannot be one the builder offers without comment.
describe('conflictingOutputSizeOptions', () => {
  it('names every option that restates the delivered dimensions', () => {
    const size = { width: 96, height: 96 }
    expect(conflictingOutputSizeOptions({ outputSize: size })).toEqual([])
    expect(conflictingOutputSizeOptions({ outputSize: size, aspectRatio: '16:9' })).toEqual([
      'aspectRatio',
    ])
    expect(conflictingOutputSizeOptions({ outputSize: size, upscale: 2 })).toEqual(['upscale'])
    expect(
      conflictingOutputSizeOptions({ outputSize: size, aspectRatio: '16:9', upscale: 2 }),
    ).toEqual(['aspectRatio', 'upscale'])
  })

  it('finds no conflict where there is no exact size to conflict with', () => {
    // The options are not mutually exclusive with EACH OTHER: an aspect ratio beside an upscale
    // states a shape and a multiple, which compose. Only a stated SIZE makes either one a second
    // answer to a question already answered.
    expect(conflictingOutputSizeOptions({ aspectRatio: '16:9', upscale: 2 })).toEqual([])
    expect(conflictingOutputSizeOptions(undefined)).toEqual([])
  })
})

describe('binaryCapabilityCoverage', () => {
  // The same three outcomes the format check has, and for the same reason: a definition that
  // declares no capabilities has said "only the coarse facts are known", not "I can do nothing".
  // That is what lets every integration registered before this axis existed keep running.
  it('reports an undeclared integration as unverifiable rather than uncovered', () => {
    expect(binaryCapabilityCoverage(['seed'], [{ capabilities: [] }])).toEqual({
      uncovered: [],
      unverifiable: ['seed'],
    })
  })

  it('refuses only against integrations that declared their capabilities', () => {
    expect(binaryCapabilityCoverage(['seed'], [{ capabilities: ['aspect-ratio'] }])).toEqual({
      uncovered: ['seed'],
      unverifiable: [],
    })
  })

  it('treats an empty selection as covering nothing', () => {
    expect(binaryCapabilityCoverage(['seed'], []).uncovered).toEqual(['seed'])
  })

  it('is satisfied by any one of the selected integrations', () => {
    const selected = [{ capabilities: [] }, { capabilities: ['seed' as const] }]
    expect(binaryCapabilityCoverage(['seed'], selected)).toEqual({
      uncovered: [],
      unverifiable: [],
    })
  })
})

describe('binaryCapabilityProviders', () => {
  // "Covered" is not the whole answer once a step holds two producers: an aspect ratio honoured
  // by one of them and ignored by the other leaves nothing on the artifact to say which happened.
  it('names which integrations honour each requirement, in selection order', () => {
    expect(
      binaryCapabilityProviders(
        ['seed'],
        [
          { id: 'flux', capabilities: ['seed'] },
          { id: 'nano', capabilities: ['aspect-ratio'] },
          { id: 'retro', capabilities: ['seed'] },
        ],
      ),
    ).toEqual([{ capability: 'seed', generatorIds: ['flux', 'retro'] }])
  })

  it('omits a capability nothing declares rather than reporting an empty list', () => {
    expect(binaryCapabilityProviders(['seed'], [{ id: 'nano', capabilities: [] }])).toEqual([])
  })
})

describe('isBinaryGeneratorCapability', () => {
  it('accepts every member of the picklist it is derived from', () => {
    for (const capability of binaryGeneratorCapabilitySchema.options) {
      expect(isBinaryGeneratorCapability(capability)).toBe(true)
    }
  })

  // The guard exists for the mothership seam: a node resolves its integrations from a process
  // that may be a build ahead of it, so a capability this build never defined can arrive.
  it('rejects a capability this build does not define', () => {
    expect(isBinaryGeneratorCapability('holographic')).toBe(false)
  })
})

function ref() {
  return { location: 'assets/hero.png', role: 'style' as const }
}
