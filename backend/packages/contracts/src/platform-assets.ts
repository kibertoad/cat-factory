import { normalizeMediaType } from './binary-modalities.js'

// ---------------------------------------------------------------------------
// The PLATFORM's own asset storage, as a foundational service.
//
// A binary-output step stores its deliverables through a catalog service carrying the
// `asset-storage` capability (see `docs/initiatives/binary-output-foundational-storage.md`).
// That is the right shape for an org that already runs an asset store, and it leaves a
// deployment that runs none with a generating step it cannot configure: the built-in Media task
// type would ship pointing at nothing.
//
// So the platform registers ONE `builtin`-tier service of its own, backed by the binary-artifact
// store an account already configures for screenshots (R2 / S3 / a Postgres table / the local
// filesystem, which is what a local deployment gets with nothing configured at all). It is the
// same seam every other storage target uses: the agent reads a contract and calls an HTTP API,
// and nothing in the container knows it is talking to the platform.
//
// What is DIFFERENT about it, and the reason it is worth having beside the org-storage story: the
// platform holds these bytes, so it can serve them back. A run's stored assets are previewable
// and downloadable from the step's report, where an artifact in an org's private bucket is a
// location string and nothing more. That is the whole of "see the results again, and save them
// elsewhere".
//
// Both halves of the platform have to agree about the id (the backend registers and resolves it,
// the SPA branches on it to render a preview), which is why it lives here and not in kernel.
// ---------------------------------------------------------------------------

/**
 * The catalog id of the platform's own asset-storage service.
 *
 * A plain lower-kebab slug like every other catalog id, so nothing about it is special to
 * admission, the picker or the brief: a deployment that prefers its own store selects that one
 * instead, and one that wants neither can suppress this id at either stored tier exactly as it
 * can suppress any other `builtin`.
 */
export const PLATFORM_ASSET_STORAGE_SERVICE_ID = 'platform-assets'

/**
 * The prefix every binary-artifact id carries (`art_…`), and therefore the shape of a `location`
 * this service reports.
 *
 * Stated so {@link platformAssetIdOf} can REFUSE anything else rather than handing a rendered
 * surface a string it will turn into a request. A `location` is model-authored text: the agent
 * copies back whatever the ingest response gave it, and a model that paraphrases, truncates or
 * invents one must cost the row its preview, never the whole record.
 */
const PLATFORM_ASSET_ID_PATTERN = /^art_[A-Za-z0-9_-]{1,64}$/

/**
 * The artifact id a stored/staged binary names, or `null` when this row is not one the platform
 * itself holds the bytes for.
 *
 * Returns null for BOTH "stored somewhere else" and "stored here, but the location is not an
 * artifact id", and the collapse is deliberate: the caller's question is only ever "can I render
 * this", and the two negatives have the same answer. What must NOT collapse is the row itself,
 * which every surface keeps and renders as metadata either way.
 *
 * The service id is compared case-insensitively because a declaration's `service` is lowercased
 * on read-back and a candidate's is too; comparing exactly here would work today and break the
 * first time a caller passes an un-normalised value.
 */
export function platformAssetIdOf(row: {
  service?: string | null
  location?: string | null
}): string | null {
  if (row.service?.trim().toLowerCase() !== PLATFORM_ASSET_STORAGE_SERVICE_ID) return null
  const location = row.location?.trim() ?? ''
  return PLATFORM_ASSET_ID_PATTERN.test(location) ? location : null
}

/**
 * Whether a SELECTED storage id is the platform's own asset service — the one fact that decides
 * whether the account's content-storage configuration is involved in a step at all.
 *
 * A function rather than a comparison written twice, because two seams on opposite sides of one
 * hand-off ask it and they must not disagree. The container executor asks it to decide whether the
 * job is handed an upload seam into the platform's asset ingest; run admission asks it to decide
 * whether the `binary-storage` PRECONDITION applies to a step. Those two used to answer it from
 * different facts — the seam from the step's selection, the precondition from the kind's trait — so
 * a step repointed at an org's own object service was refused a run over a store its bytes were
 * never going to reach, and the refusal named a settings page unrelated to the failure.
 *
 * Strictly about a STATED id: absent answers false, because "no selection" is not a claim about the
 * platform's store and the two callers read that state differently. The upload seam falls through
 * to its own rule; admission treats a trait-carrying kind with nothing to select as bound to the
 * account store, which is the only target it could have. Neither reading belongs here.
 *
 * Compared case-insensitively for the reason {@link platformAssetIdOf} gives: a stored selection is
 * a lower-kebab slug today, and a comparison that assumed it would break on the first caller
 * passing an un-normalised one.
 */
export function storesThroughPlatformAssets(storageServiceId: string | null | undefined): boolean {
  return storageServiceId?.trim().toLowerCase() === PLATFORM_ASSET_STORAGE_SERVICE_ID
}

/**
 * The media types a stored artifact is served back INLINE as, and therefore the ones a surface may
 * point an `<img>` at.
 *
 * ONE list, read by both sides, because the two are the same judgement about the same bytes and a
 * divergence is invisible from either end. The backend clamps a blob response to it: anything
 * outside comes back as `application/octet-stream` with `Content-Disposition: attachment`, so a
 * stored SVG or an HTML document can never be served as active content. The SPA reads it to decide
 * whether a row renders as a picture or as a download. Had the SPA kept its own copy, a type added
 * on the server would render as a broken image, and one removed would render as a picture the
 * server refuses to serve inline.
 *
 * SVG is deliberately absent: it is markup with script in it.
 */
export const INLINE_IMAGE_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

const INLINE_IMAGE_MEDIA_TYPE_SET: ReadonlySet<string> = new Set(INLINE_IMAGE_MEDIA_TYPES)

/**
 * Whether bytes of this media type are served back inline as an image. Takes the raw claim (a
 * model's `image/PNG`, a header's `image/png; charset=binary`) and reduces it through the ONE
 * media-type normalisation, so a caller never has to remember to.
 */
export function rendersInlineAsImage(contentType: string | null | undefined): boolean {
  const type = normalizeMediaType(contentType ?? '')
  return type !== null && INLINE_IMAGE_MEDIA_TYPE_SET.has(type)
}
