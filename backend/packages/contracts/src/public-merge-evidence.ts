import * as v from 'valibot'
import {
  changeClassSchema,
  mergeClassRollupSchema,
  mergeTrackDecisionSchema,
  reviewEffortSchema,
} from './mergeTrackRecord.js'
import { vcsProviderSchema } from './routes/auth.js'

// ---------------------------------------------------------------------------
// Public MERGE-EVIDENCE wire shapes (`/api/v1/runs/:runId/merge-record`,
// `/api/v1/merge-records/:recordId`, `…/effort`, and `/api/v1/merge-records/rollups`).
//
// The merge track record (ADR 0046) is the accumulated human evidence behind the auto-merge
// policy: what KIND of change a run made, what the merger scored it, what happened, and how
// much review a human actually spent. It was reachable only from a browser session, which
// split the headless story in half: an integration could START a run and MERGE its pull
// request through `/api/v1`, and then had nowhere to record how much review that merge took,
// nor any way to read back what the workspace has accumulated. So the one signal the policy is
// meant to eventually stand on was collectable only by the people who were not driving the runs.
//
// Three rules shape these shapes:
//
//  1. **The ROLLUPS are served verbatim** ({@link mergeClassRollupSchema}), the same aggregate
//     the preset editor renders each class's rule against. A second, API-shaped projection of
//     one `GROUP BY` is how two surfaces start reporting different auto-merge shares for one
//     workspace. The consequence is worth stating: that schema is now part of the STABLE public
//     surface and grows additively (CLAUDE.md, "The public API does not break").
//  2. **The RECORD is projected, because its id vocabulary differs.** `/api/v1` says `taskId`
//     and `runId` where the stored row says `blockId` and `executionId`; publishing the row
//     as-is would hand a caller two ids it cannot address anything with, next to the ones it
//     can. Nothing is dropped in the projection: a consumer sees every field the record holds.
//  3. **`unknown` reaches the wire.** It is a first-class outcome (no VCS client wired, or an
//     unreadable diff), not an error, and it never matches a per-class rule. A consumer that
//     collapsed it onto a class would be reading a classification failure as a policy input.
// ---------------------------------------------------------------------------

/**
 * One persisted merge decision, as `/api/v1` speaks it: the deterministic change class, the
 * merger's scores at the decision, what happened to the pull request, and the reviewer-effort
 * tag a human left (null until somebody tags it; tagging is never mandatory).
 *
 * The projection of the stored row (`mergeTrackRecordSchema`) onto the public id vocabulary:
 * `recordId`/`taskId`/`runId` for the row, its task and its run. Provider-neutral by
 * construction, so a GitLab deployment reads the same shape.
 */
export const publicMergeRecordSchema = v.object({
  /** The id to pass to `POST /api/v1/merge-records/{recordId}/effort`. */
  recordId: v.string(),
  /** The board task whose pull request this covers (`GET /api/v1/tasks/{taskId}`). */
  taskId: v.string(),
  /**
   * The run that produced the pull request (`GET /api/v1/runs/{runId}/report`). Nullable
   * because the column is; every record written today is born at a merge decision inside a run,
   * so in practice it is set. An external merge does not mint a record, it settles the one the
   * run already wrote.
   */
  runId: v.nullable(v.string()),
  /**
   * What kind of change the pull request made, derived on the backend from its changed-file
   * list and never from an agent's opinion. A mixed diff resolves to the highest-ranked class
   * present, so a per-class rule can only fire on a diff carrying nothing riskier.
   */
  changeClass: changeClassSchema,
  /** How many files the pull request changed, when the changed-file list was readable. */
  changedFileCount: v.nullable(v.number()),
  /**
   * The merger's complexity score at the decision, 0..1. The three scores move together: all
   * null means the merger produced no parseable assessment, not that it scored zero.
   */
  complexity: v.nullable(v.number()),
  /** The merger's risk score at the decision, 0..1 (see `complexity`). */
  risk: v.nullable(v.number()),
  /** The merger's impact score at the decision, 0..1 (see `complexity`). */
  impact: v.nullable(v.number()),
  /**
   * The merge-threshold preset the decision was compared against. The id is absent for the
   * deployment's built-in fallback preset, which has no stored row; the name is set either way.
   */
  mergePresetId: v.nullable(v.string()),
  mergePresetName: v.nullable(v.string()),
  /** What ultimately happened to the pull request. */
  decision: mergeTrackDecisionSchema,
  /** How much review a human spent, once somebody tagged it; null while untagged. */
  reviewEffort: v.nullable(reviewEffortSchema),
  /** The pull-request number within its repository, when known. */
  prNumber: v.nullable(v.number()),
  /** The pull request's web URL. */
  prUrl: v.nullable(v.string()),
  /** Provider-neutral id of the repository the pull request belongs to. */
  repoId: v.nullable(v.string()),
  /** Which VCS provider hosts it, so a mixed-provider workspace reads back correctly. */
  provider: v.nullable(vcsProviderSchema),
  /** Epoch ms the decision was recorded (the merger step's resolution). */
  createdAt: v.number(),
  /** Epoch ms the decision became terminal; null while `pending_review`. */
  resolvedAt: v.nullable(v.number()),
  /** Epoch ms the effort tag was recorded; null while untagged. */
  taggedAt: v.nullable(v.number()),
})
export type PublicMergeRecord = v.InferOutput<typeof publicMergeRecordSchema>

/**
 * Every change class's accumulated track record, whole rather than paginated: the set is the
 * closed {@link changeClassSchema} union, so the response is seven rows on every workspace and
 * its size is computable before the request.
 *
 * A class with no records is present as zeros rather than absent, for the same reason the app's
 * table renders every class: "nothing has landed in this class yet" and "this class was left out
 * of the response" are different facts, and only one of them is about the workspace.
 */
export const publicMergeClassRollupListSchema = v.object({
  rollups: v.array(mergeClassRollupSchema),
})
export type PublicMergeClassRollupList = v.InferOutput<typeof publicMergeClassRollupListSchema>
