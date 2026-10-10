import type {
  MergeClassRollup,
  MergeTrackDecision,
  MergeTrackRecord,
  ReviewEffort,
} from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence port for the merge track record — one row per merge decision,
// carrying the run's deterministic change class, the merger's scores, what
// happened, and the reviewer-effort tag a human left. Mirrored across both
// runtimes (D1 ⇄ Drizzle) with a conformance assertion, per "Keep the runtimes
// symmetric".
//
// Two properties the implementations MUST honour:
//
//  - `insertIfAbsent` is FIRST-WRITE-WINS, never an upsert. Record ids are
//    deterministic (`mtr_<executionId>`), and the durable driver can re-resolve a
//    merger step whose decision already landed; an upsert would let a replay
//    clobber a human's effort tag with nulls. Same reasoning as
//    `LlmCallMetricRepository.record`.
//  - `rollupByClass` is a SINGLE aggregate query (`GROUP BY change_class` with
//    conditional `SUM`s), NEVER rows loaded and reduced in JS, and NEVER one query
//    per class — the preset editor renders every class at once.
// ---------------------------------------------------------------------------

/** The mutable half of a record: the terminal decision and/or the effort tag. */
export interface MergeTrackRecordPatch {
  decision?: MergeTrackDecision
  /** `null` clears the tag; omitted leaves it untouched. */
  reviewEffort?: ReviewEffort | null
  /** Epoch ms the decision became terminal. */
  resolvedAt?: number | null
  /** Epoch ms the effort tag was recorded. */
  taggedAt?: number | null
}

export interface MergeTrackRecordRepository {
  /**
   * Insert a record, IGNORING the write when its id already exists (first write wins). Returns
   * the row that is now stored — the freshly-inserted one, or the pre-existing one a replay
   * collided with — so a caller can carry its id onto a notification payload either way.
   */
  insertIfAbsent(workspaceId: string, record: MergeTrackRecord): Promise<MergeTrackRecord>
  /** A record by id, or null when absent. */
  get(workspaceId: string, id: string): Promise<MergeTrackRecord | null>
  /** The record for a run, or null when none was written (classification is best-effort). */
  getByExecution(workspaceId: string, executionId: string): Promise<MergeTrackRecord | null>
  /**
   * The most recent record for a block, or null. Used by the merge paths that know only a
   * block (the inspector's merge control, which is not run-scoped). A single point-read —
   * never called inside a loop.
   */
  getLatestByBlock(workspaceId: string, blockId: string): Promise<MergeTrackRecord | null>
  /**
   * The record covering a specific pull request, or null. This is how an EXTERNAL merge (a
   * human merging on the provider) is attributed: the webhook knows only `(repoId, prNumber)`,
   * and a record written at the merger step already carries both — so no unindexed scan of the
   * blocks' JSON pull-request column is needed.
   */
  getByPullRequest(
    workspaceId: string,
    repoId: string,
    prNumber: number,
  ): Promise<MergeTrackRecord | null>
  /** Apply the terminal decision and/or the effort tag. No-op when the id is absent. */
  patch(workspaceId: string, id: string, patch: MergeTrackRecordPatch): Promise<void>
  /**
   * Per-change-class rollups for a workspace, as ONE SQL aggregate. Classes with no records
   * are simply absent from the result (the caller fills them in with `emptyMergeClassRollup`),
   * so the query stays a plain `GROUP BY` with no synthetic class list to join against.
   */
  rollupByClass(workspaceId: string): Promise<MergeClassRollup[]>
}
