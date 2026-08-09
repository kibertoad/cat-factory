import { describe, expect, it } from 'vitest'
import {
  formatReferenceImages,
  generationControlOffer,
  parseMediaTypeRequirement,
  parseReferenceImages,
  sameFormats,
} from './BinaryOutputStepPicker.logic'

describe('parseMediaTypeRequirement', () => {
  it('stores the reduction the backend compares against, not what was typed', () => {
    // The field is forgiving on the way in and exact on the way out. A locally-lowercased copy
    // would store a format that matches nothing and then reads everywhere as one that was simply
    // never emitted — indistinguishable from a real delivery failure.
    expect(parseMediaTypeRequirement(' Model/GLTF-Binary , image/PNG ').usable).toEqual([
      'model/gltf-binary',
      'image/png',
    ])
  })

  it('drops a parameter, because a requirement is a format and not one request encoding', () => {
    expect(parseMediaTypeRequirement('model/gltf-binary; charset=binary').usable).toEqual([
      'model/gltf-binary',
    ])
  })

  it('NAMES what it refused rather than quietly shortening the requirement', () => {
    // A requirement someone typed and the step does not carry is the "absent reads as fine"
    // failure the rest of this surface is built to avoid, so the entry survives verbatim for the
    // warning to quote.
    const parsed = parseMediaTypeRequirement('gltf, model/obj, ')
    expect(parsed.usable).toEqual(['model/obj'])
    expect(parsed.unusable).toEqual(['gltf'])
  })

  it('deduplicates what two spellings reduce to, keeping first-stated order', () => {
    const parsed = parseMediaTypeRequirement('model/obj, MODEL/OBJ, model/gltf-binary')
    expect(parsed.usable).toEqual(['model/obj', 'model/gltf-binary'])
  })

  it('maps no synonyms, so a near neighbour stays a separate requirement', () => {
    // `model/obj` and `application/x-tgif` are the same file. Collapsing them would make the
    // admission check accept a GLB where an OBJ was required — the failure it exists to prevent.
    const parsed = parseMediaTypeRequirement('model/obj, application/x-tgif')
    expect(parsed.usable).toEqual(['model/obj', 'application/x-tgif'])
  })

  it('reads an empty requirement as no requirement', () => {
    expect(parseMediaTypeRequirement('  ,  ')).toEqual({ usable: [], unusable: [] })
  })
})

describe('sameFormats', () => {
  it('treats an absent list and an empty one as the same write', () => {
    // Clearing the field stores `undefined`, so the two spellings of "no requirement" must not
    // read as a change that came from elsewhere.
    expect(sameFormats(undefined, [])).toBe(true)
  })

  it('is order-sensitive, because the field writes back exactly what it read', () => {
    expect(sameFormats(['a/b', 'c/d'], ['c/d', 'a/b'])).toBe(false)
    expect(sameFormats(['a/b', 'c/d'], ['a/b', 'c/d'])).toBe(true)
  })
})

describe('parseReferenceImages', () => {
  it('reads the role, the location and the optional service off each line', () => {
    const { usable, unusable } = parseReferenceImages(
      ['subject|assets/hero.png|asset-store', 'style|https://cdn.example/palette.png'].join('\n'),
    )
    expect(usable).toEqual([
      { role: 'subject', location: 'assets/hero.png', service: 'asset-store' },
      { role: 'style', location: 'https://cdn.example/palette.png' },
    ])
    expect(unusable).toEqual([])
  })

  // A reference someone typed and the step does not carry is a generation that silently ignores
  // it, which is the "absent reads as fine" failure the rest of this surface exists to avoid.
  it('reports a refused line rather than dropping it', () => {
    const { usable, unusable } = parseReferenceImages(
      ['mood|assets/hero.png', 'subject|', 'subject|assets/ok.png'].join('\n'),
    )
    expect(usable.map((ref) => ref.location)).toEqual(['assets/ok.png'])
    expect(unusable).toEqual(['mood|assets/hero.png', 'subject|'])
  })

  it('round-trips through the text the field shows', () => {
    const text = 'base|assets/hero.png|asset-store'
    expect(formatReferenceImages(parseReferenceImages(text).usable)).toBe(text)
  })
})

describe('generationControlOffer', () => {
  const declaring = (...capabilities: string[]) => ({ capabilities }) as never

  it('offers everything while a selected integration has declared nothing', () => {
    // An integration that pinned nothing down is not a denial: hiding a control would be a claim
    // about a vendor's API that nobody established. The advisory line says it is unconfirmed.
    const offers = generationControlOffer([declaring('seed'), declaring()], undefined)
    expect(offers('seed')).toBe(true)
    expect(offers('tileable')).toBe(true)
  })

  it('offers everything when nothing is selected yet', () => {
    expect(generationControlOffer([], undefined)('upscale')).toBe(true)
  })

  it('hides a control once every selection has declared and none has the capability', () => {
    const offers = generationControlOffer([declaring('seed'), declaring('aspect-ratio')], undefined)
    expect(offers('seed')).toBe(true)
    expect(offers('aspect-ratio')).toBe(true)
    expect(offers('tileable')).toBe(false)
  })

  // The regression this pins. Changing the selection does not clear options authored against the
  // old one, so a stored option whose capability nothing declares still REFUSES the run at
  // admission. Hiding its control leaves the reader an error saying to remove an option and no
  // control that removes it: a step that cannot be run and cannot be fixed from the surface that
  // configures it.
  it('keeps offering a control whose option is already SET, whatever the selection declares', () => {
    const selection = [declaring('seed')]
    expect(generationControlOffer(selection, {})('tileable')).toBe(false)
    expect(generationControlOffer(selection, { tileable: true })('tileable')).toBe(true)
  })

  it('keeps the control for every option shape that carries a requirement', () => {
    const selection = [declaring('seed')]
    // Each of these is stored differently (a flag, a number that may be zero, a list, a mode), and
    // the requirement is derived from the same helper admission uses rather than re-read here.
    const offers = generationControlOffer(selection, {
      seed: 0,
      aspectRatio: '16:9',
      negativePrompt: 'blurry',
      edit: { mode: 'mask' },
      referenceImages: [{ role: 'subject', location: 'assets/hero.png' }],
    } as never)
    for (const capability of [
      'aspect-ratio',
      'negative-prompt',
      'mask-edit',
      'reference-image',
    ] as const) {
      expect(offers(capability)).toBe(true)
    }
  })
})
