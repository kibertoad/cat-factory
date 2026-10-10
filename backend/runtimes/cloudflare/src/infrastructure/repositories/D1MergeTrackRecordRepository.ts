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
import type { D1Database } from '@cloudflare/workers-types'

interface MergeTrackRecordRow {
  id: string
  block_id: string
  execution_id: string | null
  change_class: string
  changed_file_count: number | null
  complexity: number | null
  risk: number | null
  impact: number | null
  risk_policy_id: string | null
  risk_policy_name: string | null
  decision: string
  review_effort: string | null
  pr_number: number | null
  pr_url: string | null
  repo_id: string | null
  provider: string | null
  created_at: number
  resolved_at: number | null
  tagged_at: number | null
}

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

/** One row of the per-class rollup aggregate (every count comes back from SQL). */
interface RollupRow {
  change_class: string
  total: number
  auto_merged: number
  human_merged: number
  external_merged: number
  rejected: number
  pending_review: number
  effort_none: number
  effort_minor: number
  effort_major: number
  effort_untagged: number
}

function rowToRollup(row: RollupRow): MergeClassRollup {
  return {
    changeClass: row.change_class as ChangeClass,
    total: row.total,
    merged: row.auto_merged + row.human_merged + row.external_merged,
    autoMerged: row.auto_merged,
    humanMerged: row.human_merged,
    externalMerged: row.external_merged,
    rejected: row.rejected,
    pendingReview: row.pending_review,
    effort: {
      none: row.effort_none,
      minor: row.effort_minor,
      major: row.effort_major,
      untagged: row.effort_untagged,
    },
  }
}

/**
 * Merge track records, one row per merge decision in `merge_track_records` (migration 0061).
 * The Drizzle/Postgres twin is `DrizzleMergeTrackRecordRepository`; the cross-runtime
 * conformance suite drives classify → merge → tag → rollup against both.
 *
 * Two invariants this implementation carries (see the port doc):
 *  - {@link insertIfAbsent} is `ON CONFLICT DO NOTHING` targeting the PRIMARY KEY, NOT `INSERT OR
 *    IGNORE` — the latter also swallows a NOT NULL/CHECK violation, which would silently drop a
 *    malformed record here while the Postgres twin throws.
 *  - {@link rollupByClass} is ONE aggregate query; no rows are loaded into JS to be counted.
 */
export class D1MergeTrackRecordRepository implements MergeTrackRecordRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insertIfAbsent(workspaceId: string, record: MergeTrackRecord): Promise<MergeTrackRecord> {
    await this.db
      .prepare(
        `INSERT INTO merge_track_records
           (workspace_id, id, block_id, execution_id, change_class, changed_file_count,
            complexity, risk, impact, risk_policy_id, risk_policy_name, decision, review_effort,
            pr_number, pr_url, repo_id, provider, created_at, resolved_at, tagged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO NOTHING`,
      )
      .bind(
        workspaceId,
        record.id,
        record.blockId,
        record.executionId,
        record.changeClass,
        record.changedFileCount,
        record.complexity,
        record.risk,
        record.impact,
        record.riskPolicyId,
        record.riskPolicyName,
        record.decision,
        record.reviewEffort,
        record.prNumber,
        record.prUrl,
        record.repoId,
        record.provider,
        record.createdAt,
        record.resolvedAt,
        record.taggedAt,
      )
      .run()
    // Read back rather than returning the input: on a conflict the STORED row is the pre-existing
    // one (first write wins), and the caller puts its id/state on a notification payload.
    return (await this.get(workspaceId, record.id)) ?? record
  }

  async get(workspaceId: string, id: string): Promise<MergeTrackRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM merge_track_records WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<MergeTrackRecordRow>()
    return row ? rowToRecord(row) : null
  }

  async getByExecution(workspaceId: string, executionId: string): Promise<MergeTrackRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM merge_track_records WHERE workspace_id = ? AND execution_id = ?`)
      .bind(workspaceId, executionId)
      .first<MergeTrackRecordRow>()
    return row ? rowToRecord(row) : null
  }

  async getLatestByBlock(workspaceId: string, blockId: string): Promise<MergeTrackRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM merge_track_records
           WHERE workspace_id = ? AND block_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<MergeTrackRecordRow>()
    return row ? rowToRecord(row) : null
  }

  async getByPullRequest(
    workspaceId: string,
    repoId: string,
    prNumber: number,
  ): Promise<MergeTrackRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM merge_track_records
           WHERE workspace_id = ? AND repo_id = ? AND pr_number = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, repoId, prNumber)
      .first<MergeTrackRecordRow>()
    return row ? rowToRecord(row) : null
  }

  async patch(workspaceId: string, id: string, patch: MergeTrackRecordPatch): Promise<void> {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    if (patch.decision !== undefined) {
      sets.push('decision = ?')
      values.push(patch.decision)
    }
    if (patch.reviewEffort !== undefined) {
      sets.push('review_effort = ?')
      values.push(patch.reviewEffort)
    }
    if (patch.resolvedAt !== undefined) {
      sets.push('resolved_at = ?')
      values.push(patch.resolvedAt)
    }
    if (patch.taggedAt !== undefined) {
      sets.push('tagged_at = ?')
      values.push(patch.taggedAt)
    }
    if (sets.length === 0) return
    await this.db
      .prepare(
        `UPDATE merge_track_records SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
      )
      .bind(...values, workspaceId, id)
      .run()
  }

  async rollupByClass(workspaceId: string): Promise<MergeClassRollup[]> {
    // ONE aggregate: per-class counts plus a conditional SUM per decision and per effort level.
    // Classes with no rows are simply absent — the service fills those in — so there is no
    // synthetic class list to LEFT JOIN against.
    const { results } = await this.db
      .prepare(
        `SELECT change_class,
                COUNT(*) AS total,
                SUM(CASE WHEN decision = 'auto_merged' THEN 1 ELSE 0 END) AS auto_merged,
                SUM(CASE WHEN decision = 'human_merged' THEN 1 ELSE 0 END) AS human_merged,
                SUM(CASE WHEN decision = 'external_merged' THEN 1 ELSE 0 END) AS external_merged,
                SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN decision = 'pending_review' THEN 1 ELSE 0 END) AS pending_review,
                SUM(CASE WHEN review_effort = 'none' THEN 1 ELSE 0 END) AS effort_none,
                SUM(CASE WHEN review_effort = 'minor' THEN 1 ELSE 0 END) AS effort_minor,
                SUM(CASE WHEN review_effort = 'major' THEN 1 ELSE 0 END) AS effort_major,
                SUM(CASE WHEN review_effort IS NULL THEN 1 ELSE 0 END) AS effort_untagged
           FROM merge_track_records
           WHERE workspace_id = ?
           GROUP BY change_class`,
      )
      .bind(workspaceId)
      .all<RollupRow>()
    return results.map(rowToRollup)
  }
}
