// The spec constants shared between `generate-openapi.mjs` and the hand-documented routes
// beside it: the surface's path prefix and the human descriptions OpenAPI requires on a response.
//
// Their own module rather than an export from the generator, so the hand-documented block can be
// read (and moved) without importing the whole emitter.

/** The prefix every public route sits under. */
export const API_PREFIX = '/api/v1'

/** Human descriptions for the response status codes we emit (OpenAPI requires a description). */
export const STATUS_DESCRIPTIONS = {
  200: 'Success',
  201: 'Created',
  202: 'Accepted, the run has started',
  204: 'No content',
  '4XX': 'Client error (validation, unauthorized, not found, conflict, rate limit)',
  '5XX': 'Server error',
}

/**
 * The media types the artifact-blob route can answer with: the image allow-list it clamps a
 * stored content type to, plus the octet-stream it falls back to for a row it does not recognise
 * (which it also serves as an attachment, so nothing executes).
 *
 * Stated here because the blob endpoint is documented by hand rather than from a route contract,
 * and kept honest by `blobMediaTypes.spec.ts`, which asserts this set IS the server's own
 * allow-list. A spec that names one type while the server sends another is a lie a third-party
 * client generated from this document would act on.
 */
export const BLOB_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/octet-stream',
]

/** OpenAPI's spelling of "opaque bytes". */
export const BINARY_SCHEMA = { type: 'string', format: 'binary' }
