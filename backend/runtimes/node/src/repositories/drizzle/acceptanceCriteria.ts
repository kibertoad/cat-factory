import type {
  AcceptanceCriterionProvenance,
  AcceptanceCriterionRecord,
  AcceptanceCriterionRepository,
  AcceptanceCriterionStatus,
} from '@cat-factory/kernel'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { acceptanceCriteria } from '../../db/schema.js'

// The per-service ACCEPTANCE CRITERIA over Postgres — the Drizzle mirror of the Worker's
// `D1AcceptanceCriterionRepository` (migration 0063). One row per criterion, keyed by the
// SERVICE FRAME block; the cross-runtime conformance suite asserts the two behave identically.
// See docs/initiatives/acceptance-criteria-store.md.

type AcceptanceCriterionRow = typeof acceptanceCriteria.$inferSelect

/**
 * Postgres has no bound-parameter ceiling as tight as D1's, but an unbounded `IN` list still
 * builds a pathological query plan, so the batch read chunks too. Mirrors the D1 side's shape
 * (the number differs because the constraint does).
 */
const MAX_IN_PARAMS = 500

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Parse the persisted `tags` JSON array, tolerating a corrupt row: a malformed blob degrades to
 * "no tags" rather than throwing inside a dispatch's frame read. Mirrors the D1 parser.
 */
function parseTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
  } catch {
    return []
  }
}

/**
 * Coerce a persisted status. An unknown value reads as `proposed` — the INERT status — so a row
 * written by a newer deployment can never accidentally steer an agent on an older one (only
 * `confirmed` reaches a prompt). Mirrors the D1 coercion.
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

function recordToRow(record: AcceptanceCriterionRecord): typeof acceptanceCriteria.$inferInsert {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    block_id: record.blockId,
    title: record.title,
    given_text: record.given,
    when_text: record.when,
    outcome_text: record.outcome,
    tags: JSON.stringify(record.tags),
    status: record.status,
    provenance: record.provenance,
    source_review_id: record.sourceReviewId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

export class DrizzleAcceptanceCriterionRepository implements AcceptanceCriterionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<AcceptanceCriterionRecord | null> {
    const rows = await this.db
      .select()
      .from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.workspace_id, workspaceId), eq(acceptanceCriteria.id, id)))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listByFrameBlocks(
    workspaceId: string,
    blockIds: readonly string[],
  ): Promise<AcceptanceCriterionRecord[]> {
    if (blockIds.length === 0) return []
    const out: AcceptanceCriterionRecord[] = []
    // ONE chunked `IN` per batch — never a point-read per frame (the repo's no-N+1 rule).
    for (const ids of chunk(blockIds, MAX_IN_PARAMS)) {
      const rows = await this.db
        .select()
        .from(acceptanceCriteria)
        .where(
          and(
            eq(acceptanceCriteria.workspace_id, workspaceId),
            inArray(acceptanceCriteria.block_id, ids),
          ),
        )
        .orderBy(asc(acceptanceCriteria.created_at), asc(acceptanceCriteria.id))
      for (const row of rows) out.push(rowToRecord(row))
    }
    return out
  }

  async listByWorkspace(workspaceId: string): Promise<AcceptanceCriterionRecord[]> {
    const rows = await this.db
      .select()
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.workspace_id, workspaceId))
      .orderBy(
        asc(acceptanceCriteria.block_id),
        asc(acceptanceCriteria.created_at),
        asc(acceptanceCriteria.id),
      )
    return rows.map(rowToRecord)
  }

  async upsertMany(records: readonly AcceptanceCriterionRecord[]): Promise<void> {
    if (records.length === 0) return
    // ONE multi-row insert rather than a statement per record: the accretion pass writes a
    // whole extraction batch at once, and a loop of point-writes here would be the write-side
    // twin of the N+1 the batch read exists to avoid.
    await this.db
      .insert(acceptanceCriteria)
      .values(records.map(recordToRow))
      .onConflictDoUpdate({
        target: acceptanceCriteria.id,
        // The conflict target is the id ALONE (it is the primary key), so without this guard an
        // upsert carrying another workspace's criterion id would rewrite THAT row's contents —
        // and since `workspace_id` is not in the `set` below, the rewritten row would stay in the
        // victim's workspace. The raw repository is reachable over the mothership persistence RPC,
        // whose `workspaceFieldList` rule can only vouch for the record's OWN `workspaceId` field,
        // so the cross-tenant check has to live HERE, in the statement. A mismatched row is left
        // untouched (the update matches nothing) rather than erroring: the caller was never
        // entitled to it, and a raised error would confirm the id exists.
        setWhere: sql`${acceptanceCriteria.workspace_id} = excluded.workspace_id`,
        set: {
          block_id: sqlExcluded('block_id'),
          title: sqlExcluded('title'),
          given_text: sqlExcluded('given_text'),
          when_text: sqlExcluded('when_text'),
          outcome_text: sqlExcluded('outcome_text'),
          tags: sqlExcluded('tags'),
          status: sqlExcluded('status'),
          provenance: sqlExcluded('provenance'),
          source_review_id: sqlExcluded('source_review_id'),
          updated_at: sqlExcluded('updated_at'),
        },
      })
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.workspace_id, workspaceId), eq(acceptanceCriteria.id, id)))
  }

  async deleteByBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void> {
    if (blockIds.length === 0) return
    // ONE chunked `IN` per batch, mirroring the batch read — the board's delete cascade hands
    // over a whole doomed subtree, and a statement per block would be an N+1 write.
    for (const ids of chunk(blockIds, MAX_IN_PARAMS)) {
      await this.db
        .delete(acceptanceCriteria)
        .where(
          and(
            eq(acceptanceCriteria.workspace_id, workspaceId),
            inArray(acceptanceCriteria.block_id, ids),
          ),
        )
    }
  }
}

/**
 * `excluded.<column>` in an `ON CONFLICT DO UPDATE` set clause. A MULTI-row upsert can't use
 * the literal values object the single-row upserts elsewhere in this package use — each row
 * needs its OWN incoming value, which is exactly what `excluded` names.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`)
}
