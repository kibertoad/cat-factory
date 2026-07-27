import type {
  AcceptanceCriterionProvenance,
  AcceptanceCriterionStatus,
} from '@cat-factory/contracts'

// Persistence port for the per-service ACCEPTANCE CRITERIA (see
// docs/initiatives/acceptance-criteria-store.md). Mirrors across the D1 (Cloudflare) and
// Drizzle/Postgres (Node) facades — runtime parity is mandatory. Nothing here is secret:
// criteria are behaviour statements a human curates in the service inspector.
//
// Unlike the neighbouring frame-scoped configs (`validation_configs`,
// `release_health_configs`), a frame owns MANY criteria with independent lifecycles, so this
// is one ROW per criterion rather than one JSON blob per frame. That makes
// {@link AcceptanceCriterionRepository.listByFrameBlocks} — a single chunked `IN` — the
// primary read: a run resolves ONE frame, but the workspace hydrate and any future
// multi-frame consumer must never degrade into a point-read per frame.

/**
 * One persisted acceptance criterion: a durable, service-scoped statement of required
 * behaviour in given/when/outcome form.
 *
 * The clauses are stored in `given_text`/`when_text`/`outcome_text` columns on both runtimes:
 * `when` is a reserved word in Postgres and `then` in both dialects, so the suffix keeps the
 * two dialects identical. The domain field is `outcome` rather than `then` for a separate
 * reason — see the note in `@cat-factory/contracts`' `acceptance-criteria.ts`.
 */
export interface AcceptanceCriterionRecord {
  id: string
  workspaceId: string
  /** The SERVICE FRAME block this criterion belongs to. */
  blockId: string
  title: string
  /** Precondition / context; may be empty for a criterion that holds unconditionally. */
  given: string
  /** The action or trigger. */
  when: string
  /** The observable outcome — what makes the criterion verifiable. */
  outcome: string
  tags: string[]
  /** Only `confirmed` criteria ever reach a prompt (see the service's `resolveForFrame`). */
  status: AcceptanceCriterionStatus
  provenance: AcceptanceCriterionProvenance
  /** The requirements review a `derived` criterion was extracted from; else null. */
  sourceReviewId: string | null
  createdAt: number
  updatedAt: number
}

export interface AcceptanceCriterionRepository {
  get(workspaceId: string, id: string): Promise<AcceptanceCriterionRecord | null>
  /**
   * Every criterion belonging to any of `blockIds`, in ONE chunked `IN` query. The batch read
   * exists so no caller ever loops a point-read over a frame list (the repo's no-N+1 rule);
   * an empty `blockIds` returns an empty array without touching the database.
   */
  listByFrameBlocks(
    workspaceId: string,
    blockIds: readonly string[],
  ): Promise<AcceptanceCriterionRecord[]>
  listByWorkspace(workspaceId: string): Promise<AcceptanceCriterionRecord[]>
  /** Insert-or-replace a batch of criteria in one round trip (the accretion pass's write). */
  upsertMany(records: readonly AcceptanceCriterionRecord[]): Promise<void>
  delete(workspaceId: string, id: string): Promise<void>
  /** Drop every criterion on a frame (used when the frame itself goes away). */
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}
