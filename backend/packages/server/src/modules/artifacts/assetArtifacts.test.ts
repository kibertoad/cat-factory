import { describe, expect, it } from 'vitest'
import { INLINE_IMAGE_MEDIA_TYPES } from '@cat-factory/contracts'
import { normalizeAssetContentType } from './assetArtifacts.js'
import { ALLOWED_IMAGE_CONTENT_TYPES, blobResponseHeaders } from './imageArtifacts.js'

describe('normalizeAssetContentType', () => {
  it('accepts the media a generating step actually delivers', () => {
    for (const type of [
      'image/png',
      'image/webp',
      'audio/mpeg',
      'video/mp4',
      'model/gltf-binary',
      'application/pdf',
      'application/zip',
      'application/octet-stream',
    ]) {
      expect(normalizeAssetContentType(type), type).toBe(type)
    }
  })

  it('reduces case and parameters through the shared media-type normalisation', () => {
    expect(normalizeAssetContentType('IMAGE/PNG')).toBe('image/png')
    expect(normalizeAssetContentType('model/GLTF-binary; charset=binary')).toBe('model/gltf-binary')
  })

  it('refuses SVG, which the image allow-list has always excluded for the same reason', () => {
    expect(normalizeAssetContentType('image/svg+xml')).toBeNull()
  })

  it('refuses markup and every other application subtype it does not name', () => {
    for (const type of ['text/html', 'application/javascript', 'application/json', 'text/plain']) {
      expect(normalizeAssetContentType(type), type).toBeNull()
    }
  })

  it('refuses an upload that declares nothing rather than guessing a type for it', () => {
    // The screenshot path defaults a typeless upload to PNG because a screenshot is always one.
    // An asset could be anything, and a guess is a mislabelled row somebody later downloads by.
    expect(normalizeAssetContentType(undefined)).toBeNull()
    expect(normalizeAssetContentType('')).toBeNull()
    expect(normalizeAssetContentType('png')).toBeNull()
  })
})

describe('what an accepted asset is served back as', () => {
  it('serves an image inline and everything else as an inert attachment', () => {
    // This is what makes the wide upload gate safe: the serve path, not the write path, is where
    // active content is contained. A type outside the image allow-list can never come back with a
    // content type a browser will execute, whatever it was stored as.
    expect(blobResponseHeaders('image/png')['Content-Disposition']).toBe('inline')
    for (const type of ['model/gltf-binary', 'application/pdf', 'application/octet-stream']) {
      const headers = blobResponseHeaders(type)
      expect(headers['Content-Type'], type).toBe('application/octet-stream')
      expect(headers['Content-Disposition'], type).toBe('attachment')
      expect(headers['X-Content-Type-Options'], type).toBe('nosniff')
    }
  })

  it('accepts every inline-image type the SPA will point an <img> at', () => {
    // The two halves of one judgement: contracts says which types render as a picture, this
    // package says which may be stored. A type the SPA would render and the store would refuse
    // is a preview nobody can produce.
    for (const type of INLINE_IMAGE_MEDIA_TYPES) {
      expect(normalizeAssetContentType(type), type).toBe(type)
      expect(ALLOWED_IMAGE_CONTENT_TYPES.has(type), type).toBe(true)
    }
  })
})
