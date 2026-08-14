import { describe, expect, it } from 'vitest'
import {
  INLINE_IMAGE_MEDIA_TYPES,
  PLATFORM_ASSET_STORAGE_SERVICE_ID,
  platformAssetIdOf,
  rendersInlineAsImage,
} from './platform-assets.js'

describe('platformAssetIdOf', () => {
  it('answers the artifact id for a row stored through the platform’s own asset storage', () => {
    expect(
      platformAssetIdOf({ service: PLATFORM_ASSET_STORAGE_SERVICE_ID, location: 'art_01hxyz' }),
    ).toBe('art_01hxyz')
  })

  it('tolerates the case and padding a model’s own declaration arrives with', () => {
    // A declaration's `service` is lowercased on read-back and a candidate's is too, so an
    // exact comparison would work today and break the first caller that passes a raw value.
    expect(platformAssetIdOf({ service: ' Platform-Assets ', location: '  art_01hxyz  ' })).toBe(
      'art_01hxyz',
    )
  })

  it('answers null for a row stored somewhere else, whatever its location looks like', () => {
    // An org's own store is free to address by an id shaped exactly like ours; the service is
    // what decides whose bytes these are.
    expect(platformAssetIdOf({ service: 'acme-assets', location: 'art_01hxyz' })).toBeNull()
  })

  it('answers null for a location that is not an artifact id, and never throws on one', () => {
    // The location is model-authored prose. A paraphrase, a full URL or an empty string costs
    // the row its preview; the row itself is kept and rendered by the caller either way.
    for (const location of [
      '',
      's3://bucket/anvil.png',
      'the sprite sheet',
      'art_',
      'x'.repeat(300),
    ]) {
      expect(
        platformAssetIdOf({ service: PLATFORM_ASSET_STORAGE_SERVICE_ID, location }),
        location,
      ).toBeNull()
    }
  })

  it('answers null for a row missing either half', () => {
    expect(platformAssetIdOf({})).toBeNull()
    expect(platformAssetIdOf({ service: PLATFORM_ASSET_STORAGE_SERVICE_ID })).toBeNull()
    expect(platformAssetIdOf({ location: 'art_01hxyz' })).toBeNull()
  })
})

describe('rendersInlineAsImage', () => {
  it('accepts every type the serve path clamps to, through the shared normalisation', () => {
    // Derived from the same list the rule reads rather than a hand-written copy: a pinned literal
    // set here would fail on every ordinary addition and say nothing about what broke.
    for (const type of INLINE_IMAGE_MEDIA_TYPES) {
      expect(rendersInlineAsImage(type), type).toBe(true)
      expect(rendersInlineAsImage(`${type.toUpperCase()}; charset=binary`), type).toBe(true)
    }
  })

  it('refuses SVG, which is an image by media type and a script host in practice', () => {
    expect(rendersInlineAsImage('image/svg+xml')).toBe(false)
  })

  it('refuses the deliverables that are not pictures, and an absent claim', () => {
    for (const type of ['model/gltf-binary', 'audio/mpeg', 'application/pdf', 'text/html']) {
      expect(rendersInlineAsImage(type), type).toBe(false)
    }
    expect(rendersInlineAsImage(undefined)).toBe(false)
    expect(rendersInlineAsImage('not a media type')).toBe(false)
  })
})
