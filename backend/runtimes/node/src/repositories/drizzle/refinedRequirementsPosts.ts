import type {
  RefinedRequirementsPostClaimWindow,
  RefinedRequirementsPostKey,
  RefinedRequirementsPostRecord,
  RefinedRequirementsPostRepository,
  RefinedRequirementsPostStatus,
} from '@cat-factory/kernel'
import { and, eq, lte, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { refinedRequirementsPosts as table } from '../../db/schema.js'

const byKey = (key: RefinedRequirementsPostKey) =>
  and(
    eq(table.workspace_id, key.workspaceId),
    eq(table.review_id, key.reviewId),
    eq(table.issue_ref, key.issueRef),
    eq(table.document_hash, key.documentHash),
  )

/**
 * Idempotency markers for posting refined requirements to a linked issue, in
 * `refined_requirements_posts` (mirror of `D1RefinedRequirementsPostRepository`). The claim is one
 * atomic statement: a read-then-write would let two concurrent requests both decide to post.
 */
export class DrizzleRefinedRequirementsPostRepository implements RefinedRequirementsPostRepository {
  constructor(private readonly db: DrizzleDb) {}

  async claim(
    key: RefinedRequirementsPostKey,
    window: RefinedRequirementsPostClaimWindow,
  ): Promise<boolean> {
    const claimed = await this.db
      .insert(table)
      .values({
        workspace_id: key.workspaceId,
        review_id: key.reviewId,
        issue_ref: key.issueRef,
        document_hash: key.documentHash,
        status: 'pending',
        attempts: 1,
        error: null,
        updated_at: window.now,
      })
      .onConflictDoUpdate({
        target: [table.workspace_id, table.review_id, table.issue_ref, table.document_hash],
        set: {
          status: 'pending',
          attempts: sql`${table.attempts} + 1`,
          error: null,
          updated_at: window.now,
        },
        // `failed` retries a tracker outage and an old `pending` takes over from a dead poster;
        // a fresh `pending` is a post still in flight and must not be stolen.
        setWhere: or(
          eq(table.status, 'failed'),
          and(eq(table.status, 'pending'), lte(table.updated_at, window.reclaimPendingBefore)),
        ),
      })
      .returning({ issueRef: table.issue_ref })
    return claimed.length > 0
  }

  async settle(
    key: RefinedRequirementsPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .update(table)
      .set({
        status: outcome.status,
        error: outcome.status === 'failed' ? outcome.error : null,
        updated_at: now,
      })
      .where(byKey(key))
  }

  async get(key: RefinedRequirementsPostKey): Promise<RefinedRequirementsPostRecord | null> {
    const [row] = await this.db.select().from(table).where(byKey(key)).limit(1)
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      reviewId: row.review_id,
      issueRef: row.issue_ref,
      documentHash: row.document_hash,
      status: row.status as RefinedRequirementsPostStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}
