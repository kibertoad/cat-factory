import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  binaryFormatCoverage,
  binaryModalityOverlaps,
  binaryModalitySchema,
  isBinaryModality,
  mediaTypeSchema,
  modalitiesOfMediaType,
  modalityOfMediaType,
  normalizeMediaType,
} from './binary-modalities.js'
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

describe('isBinaryModality', () => {
  it('accepts every member of the vocabulary it is derived from', () => {
    for (const modality of binaryModalitySchema.options)
      expect(isBinaryModality(modality)).toBe(true)
  })

  it('rejects a RETIRED member, which persisted state goes on carrying', () => {
    // The reason this guard exists: the vocabulary is closed but `stepOptions.binaryOutput
    // .modalities` is SAVED, so `3d` outlived the union when it split. A reader mapping a modality
    // through an exhaustive `Record` is total against the type and partial against the data.
    expect(isBinaryModality('3d')).toBe(false)
    expect(isBinaryModality('')).toBe(false)
  })
})

describe('modalitiesOfMediaType', () => {
  it('recognises the containers an EDITABLE 3D deliverable arrives in', () => {
    // A `.blend` file is what a 3D deliverable looks like when the consumer is an artist rather
    // than an engine — the same reason the OBJ and STL legacy types are recognised.
    for (const mediaType of ['application/x-blender', 'model/gltf-binary', 'model/vnd.usdz+zip'])
      expect(modalitiesOfMediaType(mediaType)).toEqual(['3d-model', '3d-scene'])
  })

  it('answers BOTH 3D modalities, because the container does not record which it holds', () => {
    // The load-bearing fact behind the split: a GLB is one prop or an entire environment, and no
    // media type distinguishes them. Answering `3d-model` here would classify every delivered
    // scene as an asset and make the boot check refuse a correct scene-generator registration.
    expect(modalitiesOfMediaType('model/gltf-binary')).toContain('3d-scene')
    expect(modalitiesOfMediaType('model/obj')).toContain('3d-scene')
  })

  it('keeps a one-answer modality to exactly one', () => {
    expect(modalitiesOfMediaType('image/png')).toEqual(['image'])
    expect(modalitiesOfMediaType('application/pdf')).toEqual(['document'])
  })

  it('keeps “we cannot tell” apart from a modality', () => {
    expect(modalitiesOfMediaType('application/octet-stream')).toEqual([])
    expect(modalitiesOfMediaType('application/x-brand-new')).toEqual([])
  })
})

describe('modalityOfMediaType', () => {
  it('classifies only what is UNAMBIGUOUS, so a 3D artifact is left unclassified', () => {
    // For classifying something that already exists, a guess is worse than an absence: the step's
    // own declaration is the only thing that ever knew whether a `.glb` was an asset or a scene.
    expect(modalityOfMediaType('image/png')).toBe('image')
    expect(modalityOfMediaType('model/gltf-binary')).toBeNull()
    expect(modalityOfMediaType('application/octet-stream')).toBeNull()
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

describe('binaryModalityOverlaps', () => {
  const flux = { id: 'flux', modalities: ['image'] as const }
  const retro = { id: 'retro-diffusion', modalities: ['image'] as const }
  const meshy = { id: 'meshy', modalities: ['3d-model'] as const }

  it('says nothing while one integration produces each content type', () => {
    // The common case, and the reason the callers render nothing on an empty result: a warning
    // that fires on every correct selection is one nobody reads.
    expect(binaryModalityOverlaps([retro, meshy])).toEqual([])
    expect(binaryModalityOverlaps([])).toEqual([])
    expect(binaryModalityOverlaps([retro])).toEqual([])
  })

  it('names the shared content type and every id that produces it', () => {
    expect(binaryModalityOverlaps([flux, retro, meshy])).toEqual([
      { modality: 'image', generatorIds: ['flux', 'retro-diffusion'] },
    ])
  })

  it('reports each shared content type separately, in first-appearance order', () => {
    const overlaps = binaryModalityOverlaps([
      { id: 'a', modalities: ['audio', 'image'] },
      { id: 'b', modalities: ['image'] },
      { id: 'c', modalities: ['audio'] },
    ])
    expect(overlaps).toEqual([
      { modality: 'audio', generatorIds: ['a', 'c'] },
      { modality: 'image', generatorIds: ['a', 'b'] },
    ])
  })

  it('counts one integration ONCE, however often it is named', () => {
    // A step that listed an id twice holds one producer, not two, and telling it otherwise would
    // put a paragraph about a choice into a brief where no choice exists. The same rule inside a
    // single definition: a modality declared twice is still one producer of it.
    expect(binaryModalityOverlaps([retro, retro])).toEqual([])
    expect(binaryModalityOverlaps([{ id: 'a', modalities: ['image', 'image'] }])).toEqual([])
  })

  it('ranks nothing: the ids come back in the order they were given', () => {
    // Deliberate: the platform has no cost, quality or intent model, so any ordering it invented
    // would read as a recommendation it has no basis for.
    expect(binaryModalityOverlaps([retro, flux])[0]?.generatorIds).toEqual([
      'retro-diffusion',
      'flux',
    ])
    expect(binaryModalityOverlaps([flux, retro])[0]?.generatorIds).toEqual([
      'flux',
      'retro-diffusion',
    ])
  })
})

describe('binaryFormatCoverage', () => {
  it('covers a format some selected integration declares', () => {
    expect(
      binaryFormatCoverage(['model/gltf-binary'], [{ mediaTypes: ['model/gltf-binary'] }]),
    ).toEqual({ uncovered: [], unverifiable: [] })
  })

  it('refuses a format every selected integration declared its way out of', () => {
    // Every integration DECLARED its formats, so the answer is a fact rather than a gap: the step
    // is asking for a container nothing it selected emits.
    expect(binaryFormatCoverage(['model/fbx'], [{ mediaTypes: ['model/gltf-binary'] }])).toEqual({
      uncovered: ['model/fbx'],
      unverifiable: [],
    })
  })

  it('keeps UNVERIFIABLE apart from uncovered, which is the whole reason it exists', () => {
    // A generator declaring no formats has said "only my modality is known": a documented state,
    // not an empty answer. Collapsing it into `uncovered` refuses steps the backend admits;
    // collapsing it into silence presents an unchecked requirement as a checked one. An ABSENT
    // list and an empty one are the same state, because the wire type omits the field and a
    // code-registered definition may list nothing.
    expect(binaryFormatCoverage(['model/fbx'], [{ mediaTypes: [] }])).toEqual({
      uncovered: [],
      unverifiable: ['model/fbx'],
    })
    expect(binaryFormatCoverage(['model/fbx'], [{}])).toEqual({
      uncovered: [],
      unverifiable: ['model/fbx'],
    })
  })

  it('lets ONE silent integration cover for the whole selection, never per integration', () => {
    // The judgement is about the SELECTION: one integration that declared nothing might be the
    // one that emits it, and no rule here can tell. Judging per integration would report a
    // requirement as refused and unverifiable at once.
    expect(
      binaryFormatCoverage(['model/fbx'], [{ mediaTypes: ['model/gltf-binary'] }, {}]),
    ).toEqual({ uncovered: [], unverifiable: ['model/fbx'] })
  })

  it('refuses a format outright when NOTHING is selected to be silent about it', () => {
    // An empty selection declares nothing and hides nothing, exactly as a modality requirement
    // against an empty selection is already uncovered rather than unknowable.
    expect(binaryFormatCoverage(['model/fbx'], [])).toEqual({
      uncovered: ['model/fbx'],
      unverifiable: [],
    })
  })

  it('says nothing about a step that requires no format', () => {
    expect(binaryFormatCoverage([], [{ mediaTypes: [] }])).toEqual({
      uncovered: [],
      unverifiable: [],
    })
  })
})
