import type {
  AcceptanceCriterionProvenance,
  AcceptanceCriterionRecord,
  AcceptanceCriterionRepository,
  AcceptanceCriterionStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface AcceptanceCriterionRow {
  id: string
  workspace_id: string
  block_id: string
  title: string
  given_text: string
  when_text: string
  outcome_text: string
  tags: string
  status: string
  provenance: string
  source_review_id: string | null
  created_at: number
  updated_at: number
}

/**
 * How many single-row upserts go in one `db.batch`. The accretion pass writes at most a dozen
 * criteria at a time, so this is only a backstop against a caller handing over a very long
 * list (a bulk import) and blowing D1's statement limit.
 */
const UPSERT_BATCH_SIZE = 50

/**
 * Parse the persisted `tags` JSON array, tolerating a corrupt row: a malformed blob degrades
 * to "no tags" rather than throwing inside a dispatch's frame read. Tags are a labelling
 * convenience — losing them must never cost the criterion itself.
 */
function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
  } catch {
    return []
  }
}

/**
 * Coerce a persisted status. An unknown value reads as `proposed` — the INERT status — so a
 * row written by a newer deployment can never accidentally steer an agent on an older one
 * (only `confirmed` reaches a prompt).
 */
function parseStatus(value: string): AcceptanceCriterionStatus {
  return value === 'confirmed' || value === 'retired' ? value : 'proposed'
}

function parseProvenance(value: string): AcceptanceCriterionProvenance {
  return value === 'derived' ? 'derived' : 'authored'
}

function rowToRecord(row: AcceptanceCriterionRow): AcceptanceCriterionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    title: row.title,
    given: row.given_text,
    when: row.when_text,
    outcome: row.outcome_text,
    tags: parseTags(row.tags),
    status: parseStatus(row.status),
    provenance: parseProvenance(row.provenance),
    sourceReviewId: row.source_review_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-service-frame ACCEPTANCE CRITERIA (migration 0063): the durable given/when/outcome
 * behaviour statements a service accumulates. One row per criterion — each carries its own
 * lifecycle and a stable id the tester verdicts / PR report join on. Mirrors the Node facade's
 * Drizzle repository; the cross-runtime conformance suite asserts they behave identically.
 * See docs/initiatives/acceptance-criteria-store.md.
 */
export class D1AcceptanceCriterionRepository implements AcceptanceCriterionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<AcceptanceCriterionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<AcceptanceCriterionRow>()
    return row ? rowToRecord(row) : null
  }

  async listByFrameBlocks(
    workspaceId: string,
    blockIds: readonly string[],
  ): Promise<AcceptanceCriterionRecord[]> {
    if (blockIds.length === 0) return []
    const out: AcceptanceCriterionRecord[] = []
    // ONE chunked `IN` per batch — never a point-read per frame (the repo's no-N+1 rule).
    for (const chunk of chunkForIn(blockIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM acceptance_criteria
             WHERE workspace_id = ? AND block_id IN (${placeholders})
             ORDER BY created_at ASC, id ASC`,
        )
        .bind(workspaceId, ...chunk)
        .all<AcceptanceCriterionRow>()
      for (const row of results ?? []) out.push(rowToRecord(row))
    }
    return out
  }

  async listByWorkspace(workspaceId: string): Promise<AcceptanceCriterionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM acceptance_criteria
           WHERE workspace_id = ?
           ORDER BY block_id ASC, created_at ASC, id ASC`,
      )
      .bind(workspaceId)
      .all<AcceptanceCriterionRow>()
    return (results ?? []).map(rowToRecord)
  }

  async upsertMany(records: readonly AcceptanceCriterionRecord[]): Promise<void> {
    if (records.length === 0) return
    // The conflict target is the id ALONE (the primary key), so the trailing `WHERE` on the
    // `DO UPDATE` is what stops an upsert carrying ANOTHER workspace's criterion id from
    // rewriting that row's contents: `workspace_id` is deliberately absent from the SET list, so
    // such a row would otherwise stay in the victim's workspace with the caller's text — and
    // status — in it. This repository is reachable over the mothership persistence RPC, whose
    // `workspaceFieldList` rule can only vouch for the record's OWN `workspaceId` field, so the
    // cross-tenant check has to live in the statement. A mismatch updates nothing rather than
    // erroring: the caller was never entitled to the row, and an error would confirm the id
    // exists. Mirrored by the Drizzle repo's `setWhere`.
    const statements = records.map((record) =>
      this.db
        .prepare(
          `INSERT INTO acceptance_criteria
             (id, workspace_id, block_id, title, given_text, when_text, outcome_text, tags,
              status, provenance, source_review_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             block_id = excluded.block_id,
             title = excluded.title,
             given_text = excluded.given_text,
             when_text = excluded.when_text,
             outcome_text = excluded.outcome_text,
             tags = excluded.tags,
             status = excluded.status,
             provenance = excluded.provenance,
             source_review_id = excluded.source_review_id,
             updated_at = excluded.updated_at
           WHERE acceptance_criteria.workspace_id = excluded.workspace_id`,
        )
        .bind(
          record.id,
          record.workspaceId,
          record.blockId,
          record.title,
          record.given,
          record.when,
          record.outcome,
          JSON.stringify(record.tags),
          record.status,
          record.provenance,
          record.sourceReviewId,
          record.createdAt,
          record.updatedAt,
        ),
    )
    for (let i = 0; i < statements.length; i += UPSERT_BATCH_SIZE) {
      await this.db.batch(statements.slice(i, i + UPSERT_BATCH_SIZE))
    }
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM acceptance_criteria WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }

  async deleteByBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void> {
    if (blockIds.length === 0) return
    // ONE chunked `IN` per batch, mirroring the batch read — the board's delete cascade hands
    // over a whole doomed subtree, and a statement per block would be an N+1 write.
    for (const chunk of chunkForIn(blockIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      await this.db
        .prepare(
          `DELETE FROM acceptance_criteria
             WHERE workspace_id = ? AND block_id IN (${placeholders})`,
        )
        .bind(workspaceId, ...chunk)
        .run()
    }
  }
}
