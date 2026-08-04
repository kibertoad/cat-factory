import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Public run-EVIDENCE wire shapes (`/api/v1/runs/:runId/report`, `…/artifacts`, and the
// bytes at `/api/v1/artifacts/:artifactId/blob`).
//
// The platform already captures everything a reviewer needs to believe a run: the engine's
// verification report (the same bundle it maintains on the pull request) and the binary
// artifacts its agents captured. Both were reachable only from a browser session, so a
// headless consumer — a trial harness deciding whether to accept a change, an evaluation
// pipeline scoring a fleet of runs — had to scrape the PR body for one and could not reach
// the other at all.
//
// Two rules shape these shapes specifically:
//
//  1. **The report is served VERBATIM**, the same `PrVerificationReport` the PR body carries
//     in its fenced JSON block. A second, API-shaped projection of the same facts is how the
//     two surfaces start disagreeing about what a run proved. The consequence is worth
//     stating: from here on the report schema is part of the STABLE public surface, so it
//     grows additively (see CLAUDE.md, "The public API does not break").
//  2. **An artifact row carries no storage vocabulary.** `storage`/`storageKey` name the
//     account's blob backend (R2 / S3 / a `bytea` table) and are an implementation detail the
//     bytes endpoint exists to hide; what a consumer needs is the id to fetch, the type and
//     size it is about to receive, and the hash to dedupe against.
// ---------------------------------------------------------------------------

/**
 * What an artifact IS, which is what pairs a captured screenshot with the design it is
 * reviewed against: `screenshot` is machine-captured during a run, `reference` is the image a
 * human uploaded for the run to be judged against.
 */
export const publicArtifactKindSchema = v.picklist(['screenshot', 'reference'])
export type PublicArtifactKind = v.InferOutput<typeof publicArtifactKindSchema>

/** One binary artifact a run produced (metadata; the bytes are a separate fetch). */
export const publicRunArtifactSchema = v.object({
  /** The id to pass to `GET /api/v1/artifacts/{artifactId}/blob`. */
  artifactId: v.string(),
  kind: publicArtifactKindSchema,
  /** Logical view name, which is what pairs a screenshot with its reference. Null when unnamed. */
  view: v.nullable(v.string()),
  /** The MIME type the blob endpoint will answer with (always a raster image today). */
  contentType: v.string(),
  /**
   * Exact size of the bytes, so a consumer can size the fetch (or decline it) BEFORE issuing
   * it — the same discipline every `/api/v1/debug` read follows.
   */
  byteSize: v.number(),
  /** Content hash (sha-256 hex): two runs that captured the same pixels share one value. */
  hash: v.string(),
  createdAt: v.number(),
})
export type PublicRunArtifact = v.InferOutput<typeof publicRunArtifactSchema>

/**
 * A run's artifacts, whole rather than paginated.
 *
 * Deliberately unpaged where every sibling list is keyset-paginated: the capture path enforces
 * a per-run ceiling, so the row count is bounded by construction and the response size is
 * computable before the request. A cursor here would be a page-2 that structurally cannot exist.
 */
export const publicRunArtifactListSchema = v.object({
  artifacts: v.array(publicRunArtifactSchema),
})
export type PublicRunArtifactList = v.InferOutput<typeof publicRunArtifactListSchema>
