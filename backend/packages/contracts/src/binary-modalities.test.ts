import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { mediaTypeSchema, modalityOfMediaType, normalizeMediaType } from './binary-modalities.js'
import { binaryOutputConfigSchema } from './binary-outputs.js'

describe('normalizeMediaType', () => {
  it('reduces a media type to what two people mean the same thing by', () => {
    expect(normalizeMediaType('  Model/GLTF-Binary ')).toBe('model/gltf-binary')
    expect(normalizeMediaType('image/png; charset=binary')).toBe('image/png')
  })

  it('answers null for anything that is not a type/subtype at all', () => {
    expect(normalizeMediaType('gltf')).toBeNull()
    expect(normalizeMediaType('')).toBeNull()
  })

  it('maps NO synonyms, because a format requirement is checked by exact match', () => {
    // `model/obj` and `application/x-tgif` are the same file. Collapsing them here would make a
    // matcher that quietly accepts a near-neighbour — and admitting a GLB where an OBJ was
    // required is the exact failure the requirement exists to prevent.
    expect(normalizeMediaType('application/x-tgif')).not.toBe(normalizeMediaType('model/obj'))
  })
})

describe('modalityOfMediaType', () => {
  it('recognises the containers an EDITABLE 3D deliverable arrives in', () => {
    // A `.blend` file is what a 3D deliverable looks like when the consumer is an artist rather
    // than an engine — the same reason the OBJ and STL legacy types are recognised.
    expect(modalityOfMediaType('application/x-blender')).toBe('3d')
    expect(modalityOfMediaType('model/gltf-binary')).toBe('3d')
    expect(modalityOfMediaType('model/vnd.usdz+zip')).toBe('3d')
  })

  it('keeps “we cannot tell” apart from a modality', () => {
    expect(modalityOfMediaType('application/octet-stream')).toBeNull()
    expect(modalityOfMediaType('application/x-brand-new')).toBeNull()
  })
})

describe('binaryOutputConfigSchema.mediaTypes', () => {
  it('normalises what a step declares, so both sides of the check are spelled one way', () => {
    const parsed = v.parse(binaryOutputConfigSchema, {
      storageServiceId: 'asset-store',
      mediaTypes: ['Model/GLTF-Binary'],
    })
    expect(parsed.mediaTypes).toEqual(['model/gltf-binary'])
  })

  it('refuses a parameterised or malformed format at the boundary', () => {
    expect(v.safeParse(mediaTypeSchema, 'model/gltf-binary; q=1').success).toBe(false)
    expect(v.safeParse(mediaTypeSchema, 'gltf').success).toBe(false)
  })
})
