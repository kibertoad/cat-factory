import { describe, expect, it } from 'vitest'
import { INLINE_IMAGE_MEDIA_TYPES } from '@cat-factory/contracts'
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_REQUEST_BYTES,
  normalizeAssetContentType,
} from './assetArtifacts.js'
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

  it('holds the declared type to the platform’s own media-type bound', () => {
    // `normalizeMediaType` answers "what did they mean by this", not "is this a media type": it
    // returns whatever sat either side of the first slash. The value is MODEL-AUTHORED and this
    // is the only place that bounds it before it lands on a persisted column and comes back out
    // on `GET /api/v1/runs/{runId}/artifacts`, so an unbounded subtype would be stored and served
    // verbatim.
    expect(normalizeAssetContentType(`image/${'x'.repeat(500)}`)).toBeNull()
    expect(normalizeAssetContentType('image/png\nX-Injected: 1')).toBeNull()
    expect(normalizeAssetContentType('image/пнг')).toBeNull()
  })

  it('refuses an upload that declares nothing rather than guessing a type for it', () => {
    // The screenshot path defaults a typeless upload to PNG because a screenshot is always one.
    // An asset could be anything, and a guess is a mislabelled row somebody later downloads by.
    expect(normalizeAssetContentType(undefined)).toBeNull()
    expect(normalizeAssetContentType('')).toBeNull()
    expect(normalizeAssetContentType('png')).toBeNull()
  })
})

describe('how large an accepted asset may be', () => {
  it('leaves room for the double buffer inside the tightest isolate that serves the route', () => {
    // The `BinaryArtifactStore` port takes bytes, so an ingest materialises the whole file, and at
    // peak it holds TWO copies: the multipart body the form parser keeps, and the `arrayBuffer()`
    // read off the part. The Worker facade runs that inside a workerd isolate whose memory ceiling
    // is fixed at 128 MB and shared with everything else the invocation holds, so a ceiling near it
    // does not answer 413, it kills the isolate mid-upload. A Node-only test cannot see that, which
    // is why the budget is asserted here rather than left to a runtime one.
    //
    // Raising `MAX_ASSET_BYTES` therefore means changing the port to take a STREAM, and every blob
    // backend behind it to accept one. This failing is that conversation, not a number to edit.
    const WORKERD_ISOLATE_MEMORY_BYTES = 128 * 1024 * 1024
    expect(MAX_ASSET_REQUEST_BYTES).toBeGreaterThan(MAX_ASSET_BYTES)
    expect(MAX_ASSET_REQUEST_BYTES * 2).toBeLessThan(WORKERD_ISOLATE_MEMORY_BYTES / 2)
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
