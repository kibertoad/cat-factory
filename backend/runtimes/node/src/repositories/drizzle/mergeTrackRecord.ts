import type {
  ChangeClass,
  MergeClassRollup,
  MergeTrackDecision,
  MergeTrackRecord,
  MergeTrackRecordPatch,
  MergeTrackRecordRepository,
  ReviewEffort,
  VcsProvider,
} from '@cat-factory/kernel'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { mergeTrackRecords } from '../../db/schema.js'

type MergeTrackRecordRow = typeof mergeTrackRecords.$inferSelect

function rowToRecord(row: MergeTrackRecordRow): MergeTrackRecord {
  return {
    id: row.id,
    blockId: row.block_id,
    executionId: row.execution_id,
    changeClass: row.change_class as ChangeClass,
    changedFileCount: row.changed_file_count,
    complexity: row.complexity,
    risk: row.risk,
    impact: row.impact,
    riskPolicyId: row.risk_policy_id,
    riskPolicyName: row.risk_policy_name,
    decision: row.decision as MergeTrackDecision,
    reviewEffort: row.review_effort as ReviewEffort | null,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    repoId: row.repo_id,
    provider: row.provider as VcsProvider | null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    taggedAt: row.tagged_at,
  }
}

/**
 * Merge track records over Postgres — the Drizzle mirror of the Worker's
 * `D1MergeTrackRecordRepository` (migration 0061). Behaviourally identical, so the
 * cross-runtime conformance suite drives classify → merge → tag → rollup against both.
 *
 * Two invariants this implementation carries (see the port doc):
 *  - {@link insertIfAbsent} is `ON CONFLICT DO NOTHING` targeting the PRIMARY KEY, so a durable
 *    driver replay can neither duplicate a record nor clobber an effort tag a human has added.
 *  - {@link rollupByClass} is ONE aggregate query; no rows are loaded into JS to be counted.
 */
export class DrizzleMergeTrackRecordRepository implements MergeTrackRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insertIfAbsent(workspaceId: string, record: MergeTrackRecord): Promise<MergeTrackRecord> {
    await this.db
      .insert(mergeTrackRecords)
      .values({
        workspace_id: workspaceId,
        id: record.id,
        block_id: record.blockId,
        execution_id: record.executionId,
        change_class: record.changeClass,
        changed_file_count: record.changedFileCount,
        complexity: record.complexity,
        risk: record.risk,
        impact: record.impact,
        risk_policy_id: record.riskPolicyId,
        risk_policy_name: record.riskPolicyName,
        decision: record.decision,
        review_effort: record.reviewEffort,
        pr_number: record.prNumber,
        pr_url: record.prUrl,
        repo_id: record.repoId,
        provider: record.provider,
        created_at: record.createdAt,
        resolved_at: record.resolvedAt,
        tagged_at: record.taggedAt,
      })
      .onConflictDoNothing({ target: [mergeTrackRecords.workspace_id, mergeTrackRecords.id] })
    // Read back rather than returning the input: on a conflict the STORED row is the pre-existing
    // one (first write wins), and the caller puts its id/state on a notification payload.
    return (await this.get(workspaceId, record.id)) ?? record
  }

  async get(workspaceId: string, id: string): Promise<MergeTrackRecord | null> {
    const rows = await this.db
      .select()
      .from(mergeTrackRecords)
      .where(and(eq(mergeTrackRecords.workspace_id, workspaceId), eq(mergeTrackRecords.id, id)))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async getByExecution(workspaceId: string, executionId: string): Promise<MergeTrackRecord | null> {
    const rows = await this.db
      .select()
      .from(mergeTrackRecords)
      .where(
        and(
          eq(mergeTrackRecords.workspace_id, workspaceId),
          eq(mergeTrackRecords.execution_id, executionId),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async getLatestByBlock(workspaceId: string, blockId: string): Promise<MergeTrackRecord | null> {
    const rows = await this.db
      .select()
      .from(mergeTrackRecords)
      .where(
        and(
          eq(mergeTrackRecords.workspace_id, workspaceId),
          eq(mergeTrackRecords.block_id, blockId),
        ),
      )
      .orderBy(desc(mergeTrackRecords.created_at))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async getByPullRequest(
    workspaceId: string,
    repoId: string,
    prNumber: number,
  ): Promise<MergeTrackRecord | null> {
    const rows = await this.db
      .select()
      .from(mergeTrackRecords)
      .where(
        and(
          eq(mergeTrackRecords.workspace_id, workspaceId),
          eq(mergeTrackRecords.repo_id, repoId),
          eq(mergeTrackRecords.pr_number, prNumber),
        ),
      )
      .orderBy(desc(mergeTrackRecords.created_at))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async patch(workspaceId: string, id: string, patch: MergeTrackRecordPatch): Promise<void> {
    const set: Partial<typeof mergeTrackRecords.$inferInsert> = {}
    if (patch.decision !== undefined) set.decision = patch.decision
    if (patch.reviewEffort !== undefined) set.review_effort = patch.reviewEffort
    if (patch.resolvedAt !== undefined) set.resolved_at = patch.resolvedAt
    if (patch.taggedAt !== undefined) set.tagged_at = patch.taggedAt
    if (Object.keys(set).length === 0) return
    await this.db
      .update(mergeTrackRecords)
      .set(set)
      .where(and(eq(mergeTrackRecords.workspace_id, workspaceId), eq(mergeTrackRecords.id, id)))
  }

  async rollupByClass(workspaceId: string): Promise<MergeClassRollup[]> {
    // ONE aggregate: per-class counts plus a conditional SUM per decision and per effort level.
    // Classes with no rows are simply absent — the service fills those in — so there is no
    // synthetic class list to LEFT JOIN against.
    const countOf = (column: unknown, value: string) =>
      sql<number>`COALESCE(SUM(CASE WHEN ${column} = ${value} THEN 1 ELSE 0 END), 0)::int`
    const rows = await this.db
      .select({
        changeClass: mergeTrackRecords.change_class,
        total: sql<number>`COUNT(*)::int`,
        autoMerged: countOf(mergeTrackRecords.decision, 'auto_merged'),
        humanMerged: countOf(mergeTrackRecords.decision, 'human_merged'),
        externalMerged: countOf(mergeTrackRecords.decision, 'external_merged'),
        rejected: countOf(mergeTrackRecords.decision, 'rejected'),
        pendingReview: countOf(mergeTrackRecords.decision, 'pending_review'),
        effortNone: countOf(mergeTrackRecords.review_effort, 'none'),
        effortMinor: countOf(mergeTrackRecords.review_effort, 'minor'),
        effortMajor: countOf(mergeTrackRecords.review_effort, 'major'),
        effortUntagged: sql<number>`COALESCE(SUM(CASE WHEN ${mergeTrackRecords.review_effort} IS NULL THEN 1 ELSE 0 END), 0)::int`,
      })
      .from(mergeTrackRecords)
      .where(eq(mergeTrackRecords.workspace_id, workspaceId))
      .groupBy(mergeTrackRecords.change_class)
    return rows.map((row) => ({
      changeClass: row.changeClass as ChangeClass,
      total: row.total,
      merged: row.autoMerged + row.humanMerged + row.externalMerged,
      autoMerged: row.autoMerged,
      humanMerged: row.humanMerged,
      externalMerged: row.externalMerged,
      rejected: row.rejected,
      pendingReview: row.pendingReview,
      effort: {
        none: row.effortNone,
        minor: row.effortMinor,
        major: row.effortMajor,
        untagged: row.effortUntagged,
      },
    }))
  }
}
