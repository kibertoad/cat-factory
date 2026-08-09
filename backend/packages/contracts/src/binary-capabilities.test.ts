import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  binaryCapabilityCoverage,
  binaryCapabilityProviders,
  binaryGenerationOptionsObject,
  binaryGeneratorCapabilitySchema,
  isBinaryGeneratorCapability,
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
