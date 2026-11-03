import type {
  WritebackPostClaim,
  WritebackPostClaimWindow,
  WritebackPostKey,
  WritebackPostRecord,
  WritebackPostRepository,
  WritebackPostStatus,
} from '@cat-factory/kernel'
import { and, eq, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { writebackPosts as table } from '../../db/schema.js'

const byKey = (key: WritebackPostKey) =>
  and(
    eq(table.workspace_id, key.workspaceId),
    eq(table.kind, key.kind),
    eq(table.subject_id, key.subjectId),
    eq(table.issue_ref, key.issueRef),
    eq(table.discriminator, key.discriminator),
  )

/**
 * The writeback exactly-once markers in `writeback_posts` (mirror of `D1WritebackPostRepository`).
 * {@link claim} is ONE statement: the upsert rewrites a conflicting row only when it is
 * reclaimable and otherwise leaves it as it was, so `RETURNING` reports either this claim's own
 * token (won) or the holder's state (lost). SET expressions read the pre-update row, so every CASE
 * sees the same predicate.
 */
export class DrizzleWritebackPostRepository implements WritebackPostRepository {
  constructor(private readonly db: DrizzleDb) {}

  async claim(
    key: WritebackPostKey,
    window: WritebackPostClaimWindow,
  ): Promise<WritebackPostClaim> {
    const token = crypto.randomUUID()
    const reclaimable = sql`(${table.status} = 'failed' OR (${table.status} = 'pending' AND ${table.updated_at} <= ${window.reclaimPendingBefore}))`
    const [row] = await this.db
      .insert(table)
      .values({
        workspace_id: key.workspaceId,
        kind: key.kind,
        subject_id: key.subjectId,
        issue_ref: key.issueRef,
        discriminator: key.discriminator,
        status: 'pending',
        attempts: 1,
        error: null,
        claim_token: token,
        updated_at: window.now,
      })
      .onConflictDoUpdate({
        target: [
          table.workspace_id,
          table.kind,
          table.subject_id,
          table.issue_ref,
          table.discriminator,
        ],
        set: {
          status: sql`CASE WHEN ${reclaimable} THEN 'pending' ELSE ${table.status} END`,
          attempts: sql`CASE WHEN ${reclaimable} THEN ${table.attempts} + 1 ELSE ${table.attempts} END`,
          error: sql`CASE WHEN ${reclaimable} THEN NULL ELSE ${table.error} END`,
          claim_token: sql`CASE WHEN ${reclaimable} THEN excluded.claim_token ELSE ${table.claim_token} END`,
          updated_at: sql`CASE WHEN ${reclaimable} THEN excluded.updated_at ELSE ${table.updated_at} END`,
        },
      })
      .returning({ status: table.status, claimToken: table.claim_token })
    if (row?.claimToken === token) return 'claimed'
    return row?.status === 'posted' ? 'posted' : 'held'
  }

  async settle(
    key: WritebackPostKey,
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

  async get(key: WritebackPostKey): Promise<WritebackPostRecord | null> {
    const [row] = await this.db
      .select({
        status: table.status,
        attempts: table.attempts,
        error: table.error,
        updatedAt: table.updated_at,
      })
      .from(table)
      .where(byKey(key))
      .limit(1)
    if (!row) return null
    return { ...key, ...row, status: row.status as WritebackPostStatus }
  }
}
