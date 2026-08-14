import { describe, expect, it, vi } from 'vitest'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'
import { useWorkspaceStore } from '~/stores/workspace'

// What a resolved artifact reports about ITSELF, and why the answer is not the declaration that
// came with it.
//
// A stored asset carries two media types: the one the producing agent declared (optional,
// model-authored, a claim about a file) and the one the server SERVES the bytes as, after
// `blobResponseHeaders` has clamped anything outside the inline-image list down to
// `application/octet-stream`. Only the second is a fact about the response, so it is the one a
// surface may decide picture-versus-file from. Deciding from the declaration is wrong in both
// directions: an undeclared PNG renders as a generic file, and a mis-declared bundle renders as a
// broken `<img>` that reports itself as loaded, because the fetch genuinely succeeded.

function stubApi(contentType: string): { calls: number } {
  const state = { calls: 0 }
  vi.stubGlobal('useApi', () => ({
    fetchArtifactBlob: async (_ws: string, id: string) => {
      state.calls += 1
      return { url: `blob:${id}`, contentType }
    },
  }))
  return state
}

function blobs(contentType: string) {
  const calls = stubApi(contentType)
  useWorkspaceStore().workspaceId = 'ws_1'
  return { blobs: useArtifactBlobs(), calls }
}

describe('useArtifactBlobs', () => {
  it('records the media type the server served, beside the URL', async () => {
    const { blobs: cache } = blobs('image/png')
    await cache.resolve('art_1')
    expect(cache.urlFor('art_1')).toBe('blob:art_1')
    expect(cache.typeFor('art_1')).toBe('image/png')
  })

  it('reports the clamped type for bytes the server refused to serve inline', async () => {
    // A GLB, a zip, a PDF, or an image type the allow-list does not carry: the response is an
    // attachment, and a row that pointed an `<img>` at it would render a broken frame with the
    // load reported as successful.
    const { blobs: cache } = blobs('application/octet-stream')
    await cache.resolve('art_1')
    expect(cache.typeFor('art_1')).toBe('application/octet-stream')
  })

  it('knows nothing about a type until the bytes are in hand', async () => {
    // The loading state has no answer to give, which is what keeps a surface from committing to
    // picture-or-file before the response says which.
    const { blobs: cache } = blobs('image/png')
    expect(cache.typeFor('art_1')).toBeUndefined()
    await cache.resolve('art_1')
    expect(cache.typeFor('art_1')).toBe('image/png')
  })

  it('drops the recorded type on a retry, so a re-fetch cannot be read through the old one', async () => {
    const { blobs: cache } = blobs('image/png')
    await cache.resolve('art_1')
    const pending = cache.retry('art_1')
    expect(cache.typeFor('art_1')).toBeUndefined()
    await pending
    expect(cache.typeFor('art_1')).toBe('image/png')
  })

  it('forgets every type when the owning component unmounts', async () => {
    // The cache is per component and `revokeAll` is what releases the bytes; a type left behind
    // would outlive the URL it describes.
    const { blobs: cache } = blobs('image/png')
    await cache.resolve('art_1')
    cache.revokeAll()
    expect(cache.typeFor('art_1')).toBeUndefined()
  })
})
