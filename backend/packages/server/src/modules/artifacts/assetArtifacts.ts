import * as v from 'valibot'
import { mediaTypeSchema, normalizeMediaType } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// What the platform's own ASSET storage accepts, and why the rule is not the image allow-list
// beside it.
//
// A screenshot is always a PNG, so its ingest can name four types and refuse the rest. A
// generated asset is whatever the step asked for: a sprite sheet, a GLB an artist opens in
// Blender, a sound effect, a rendered PDF. Holding those to an image allow-list would make the
// Media task type an image-only feature with nothing saying so.
//
// The rule is therefore a TOP-LEVEL type gate plus a small set of container types, and what makes
// that safe is the SERVE path rather than this one: `blobResponseHeaders` puts everything outside
// the inline-image list (contracts' `INLINE_IMAGE_MEDIA_TYPES`) behind `application/octet-stream`
// + `Content-Disposition: attachment` + `nosniff`, so a stored asset can never come back as active
// content whatever it declared. This gate is about storing something legible, not about containing
// an XSS the serve path already contains.
//
// Two exclusions are still made HERE, at the write boundary, and both are the same judgement the
// image allow-list makes: an SVG is an image by media type and a script host in practice, and a
// markup/text document is not an asset anyone generates through this seam. Refusing them where
// the upload happens means the agent is TOLD (a 415 it can report), where refusing them at serve
// time would be a stored artifact nobody can open and nothing to say why.
// ---------------------------------------------------------------------------

/** Top-level media types a generated asset may carry. */
const ASSET_TOP_LEVEL_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'model'])

/**
 * The `application/*` subtypes accepted beside them: the containers real generators emit that
 * have no top-level type of their own. Named individually because `application/*` is where
 * everything else on the internet also lives.
 */
const ASSET_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  // A 3D container: glTF-binary is `model/gltf-binary`, but several vendors emit the older
  // `application/octet-stream` for a `.glb`, and a zipped asset bundle is legitimately this too.
  'application/octet-stream',
  'application/zip',
  // A rendered document deliverable (a spec sheet, a print-ready layout).
  'application/pdf',
])

/**
 * An image media type that is refused despite being one: SVG is markup with script in it, and the
 * platform's image allow-list has excluded it since it existed for exactly that reason.
 */
const REFUSED_IMAGE_SUBTYPES: ReadonlySet<string> = new Set(['image/svg+xml'])

/**
 * A hard ceiling on a single stored asset. Larger than a screenshot's because a 3D scene or a
 * short video legitimately is, and still bounded: a run that needs to deliver more than this per
 * file is delivering through the org's own object store, which is the other half of the feature.
 *
 * The number is sized by the TIGHTEST runtime the route serves, not by what a generator might
 * like to send. The `BinaryArtifactStore` port takes bytes (`store({ blob })`), so an ingest
 * necessarily materialises the whole file, and it does so TWICE at peak: once as the multipart
 * body the form parser holds, once as the `arrayBuffer()` read off the part. The Worker facade
 * runs that inside a workerd isolate with a fixed memory ceiling of 128 MB shared with everything
 * else the invocation holds, so a per-file limit anywhere near it does not answer 413, it kills
 * the isolate mid-upload, and a Node-only test cannot see the difference. 24 MiB keeps the peak
 * (~50 MiB with framing) well inside that budget on every facade.
 *
 * Raising it is therefore not a config decision: it needs the port to take a STREAM, and every
 * blob backend behind it (R2 / S3 / a Postgres `bytea` row / the filesystem) to accept one.
 */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024

/**
 * The coarse pre-buffer ceiling on the whole multipart request, with slack for the framing. See
 * the image sibling for why the exact per-file check still runs after parsing.
 */
export const MAX_ASSET_REQUEST_BYTES = MAX_ASSET_BYTES + 1024 * 1024

/**
 * Cap on how many assets ONE run may store. Generous (a step generating a full icon set legitimately
 * stores dozens) and finite, so a looping or compromised container cannot fill the store before the
 * job's own watchdog stops it. The same shape as the screenshot cap, with its own number because the
 * two answer different questions.
 */
export const MAX_ASSETS_PER_RUN = 200

/**
 * Canonicalise an uploaded asset's declared content type, or `null` when this store does not
 * accept it (the caller answers 415).
 *
 * Unlike the image sibling there is no default for a TYPELESS upload: a screenshot is always a
 * PNG so guessing one is safe, while an asset with no declared type could be anything and storing
 * it as a guess would mislabel the row that a reader later downloads by. An upload that declares
 * nothing is refused, which the agent can see and correct.
 *
 * The normalised value is then held to `mediaTypeSchema`, the platform's ONE definition of what a
 * media type may look like, before any allow-list is consulted. `normalizeMediaType` answers
 * "what did they mean by this", not "is this a media type at all": it drops parameters and lower-
 * cases, and returns whatever sat either side of the first slash. This value is MODEL-AUTHORED
 * and the only caller who bounds it is this one, since it lands on a persisted column and comes
 * back out on a public wire field (`GET /api/v1/runs/{runId}/artifacts`), so an unbounded subtype
 * would be stored and served verbatim. The schema is the same one a generator's declared formats
 * pass, which is also what keeps a stored `contentType` comparable to a step's requirement.
 */
export function normalizeAssetContentType(raw: string | null | undefined): string | null {
  const type = normalizeMediaType(raw ?? '')
  if (!type || !v.is(mediaTypeSchema, type)) return null
  if (REFUSED_IMAGE_SUBTYPES.has(type)) return null
  const top = type.split('/')[0]!
  if (ASSET_TOP_LEVEL_TYPES.has(top)) return type
  return ASSET_APPLICATION_TYPES.has(type) ? type : null
}
