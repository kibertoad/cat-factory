import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  blobResponseHeaders,
} from '../src/modules/artifacts/imageArtifacts.js'

// The artifact-blob endpoint is the one `/api/v1` operation documented BY HAND: its response is an
// image, so no route contract produces its OpenAPI entry and nothing else checks that what the
// document promises is what the handler sends.
//
// That gap is not cosmetic. `docs/openapi.json` is the published surface four generated SDKs and
// every third-party client are built from, and a declared media type is what such a client sends
// in `Accept` and switches on when the response lands. A document naming one type while the server
// answers with another is a lie that only shows up in somebody else's client.
//
// So this asserts the RELATION rather than re-pinning a list: the spec's set must be exactly the
// server's own allow-list plus the octet-stream fallback. Adding a format to
// `ALLOWED_IMAGE_CONTENT_TYPES` without re-running `pnpm gen:openapi` fails here, naming the
// missing type, instead of shipping a spec that under-states what the endpoint can return.

const BLOB_PATH = '/api/v1/artifacts/{artifactId}/blob'

/** The committed spec — the emitter's output and the SDK generator's input. */
function spec(): {
  paths: Record<string, Record<string, { responses: Record<string, { content?: object }> }>>
} {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url)), 'utf8'),
  )
}

describe('the artifact-blob endpoint in the published spec', () => {
  it('declares exactly the media types the handler can answer with', () => {
    const declared = Object.keys(spec().paths[BLOB_PATH]!.get!.responses['200']!.content!)
    // The handler clamps a stored content type to the allow-list and serves anything it does not
    // recognise as an octet-stream attachment, so those are precisely the two sources.
    const servable = [...ALLOWED_IMAGE_CONTENT_TYPES, 'application/octet-stream']
    expect([...declared].sort()).toEqual([...servable].sort())
  })

  it('serves every declared image type as itself, and only those inline', () => {
    // The other half of the promise: a declared type must survive `blobResponseHeaders` unchanged,
    // or the spec would name a type the clamp downgrades on the way out.
    for (const media of ALLOWED_IMAGE_CONTENT_TYPES) {
      const headers = blobResponseHeaders(media)
      expect(headers['Content-Type']).toBe(media)
      expect(headers['Content-Disposition']).toBe('inline')
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
    }
    // And the fallback is the one declared type that is NOT served inline: an unrecognised row
    // leaves as an opaque download, which is what keeps a stored surprise from executing.
    const fallback = blobResponseHeaders('text/html')
    expect(fallback['Content-Type']).toBe('application/octet-stream')
    expect(fallback['Content-Disposition']).toBe('attachment')
  })
})
