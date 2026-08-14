import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Public run-EVIDENCE wire shapes (`/api/v1/runs/:runId/report`, `…/artifacts`, and the
// bytes at `/api/v1/artifacts/:artifactId/blob`).
//
// The platform already captures everything a reviewer needs to believe a run: the engine's
// verification report (the same bundle it maintains on the pull request) and the binary
// artifacts its agents captured. Both were reachable only from a browser session, so a
// headless consumer (a trial harness deciding whether to accept a change, an evaluation
// pipeline scoring a fleet of runs) had to scrape the PR body for one and could not reach
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
 * What an artifact IS.
 *
 * `screenshot` and `reference` are the EVIDENCE pair, and pairing them is what the vocabulary
 * was for: `screenshot` is machine-captured during a run, `reference` is the image a human
 * uploaded for the run to be judged against.
 *
 * `asset` is a third thing and not a third kind of evidence: it is a DELIVERABLE a binary-output
 * step generated and stored through the platform's own asset storage, so it is what the run
 * produced rather than proof of what it did. It is listed here because a caller enumerating a
 * run's artifacts is entitled to the bytes the run made, and because the alternative (projecting
 * it as a `screenshot`) would put a generated sprite into the set a visual-confirmation consumer
 * pairs against reference designs. An added enum member is the additive change the public API
 * makes freely; a consumer that branches on the two it knows treats this one as unrecognised,
 * which is the correct reading for it.
 */
export const publicArtifactKindSchema = v.picklist(['screenshot', 'reference', 'asset'])
export type PublicArtifactKind = v.InferOutput<typeof publicArtifactKindSchema>

/**
 * What an artifact is ANCHORED on, which is what says whether the run produced it:
 *
 * - `run`: captured by THIS run. It carries the run's id, and a re-run captures its own.
 * - `task`: attached to the run's task and outliving any single run of it. A reference design a
 *   person uploaded before the first run is the case that matters: it is what the run's
 *   screenshots are judged against, and it is deliberately not run-anchored, because uploading one
 *   per attempt is exactly what a reference exists to avoid.
 *
 * Stated per row rather than folded away, because the two sets answer different questions and a
 * silent union would make "the run captured 3 screenshots" unreadable off a list of 5. It is also
 * why the list is not simply the run's own rows: a caller enumerating a run's artifacts to compare
 * a screenshot against its reference saw only one half, so the reference rendered as ABSENT on the
 * one surface whose job is to say what a run proved, while being individually fetchable all along.
 */
export const publicArtifactScopeSchema = v.picklist(['run', 'task'])
export type PublicArtifactScope = v.InferOutput<typeof publicArtifactScopeSchema>

/** One binary artifact a run produced (metadata; the bytes are a separate fetch). */
export const publicRunArtifactSchema = v.object({
  /** The id to pass to `GET /api/v1/artifacts/{artifactId}/blob`. */
  artifactId: v.string(),
  kind: publicArtifactKindSchema,
  /** Which anchor this row came from ({@link publicArtifactScopeSchema}). */
  scope: publicArtifactScopeSchema,
  /** Logical view name, which is what pairs a screenshot with its reference. Null when unnamed. */
  view: v.nullable(v.string()),
  /** The MIME type the blob endpoint will answer with (always a raster image today). */
  contentType: v.string(),
  /**
   * Exact size of the bytes, so a consumer can size the fetch (or decline it) BEFORE issuing
   * it: the same discipline every `/api/v1/debug` read follows.
   */
  byteSize: v.number(),
  /** Content hash (sha-256 hex): two runs that captured the same pixels share one value. */
  hash: v.string(),
  createdAt: v.number(),
})
export type PublicRunArtifact = v.InferOutput<typeof publicRunArtifactSchema>

/**
 * A run's artifacts (the ones it CAPTURED plus the ones attached to its task, each saying which
 * it is: {@link publicArtifactScopeSchema}), whole rather than paginated.
 *
 * Deliberately unpaged where every sibling list is keyset-paginated: the capture path enforces
 * a per-run ceiling and a task's uploads are a human-sized set, so the row count is bounded by
 * construction and the response size is computable before the request. A cursor here would be a
 * page-2 that structurally cannot exist.
 *
 * An artifact that is BOTH (a screenshot a run captured against its own task) appears ONCE, as
 * `run`: the run is the more specific anchor, and a row appearing twice under two scopes would
 * make every count off this list wrong in the direction that reads as extra evidence.
 */
export const publicRunArtifactListSchema = v.object({
  artifacts: v.array(publicRunArtifactSchema),
})
export type PublicRunArtifactList = v.InferOutput<typeof publicRunArtifactListSchema>
