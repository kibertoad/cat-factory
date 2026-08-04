import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentContextSnapshot,
  AgentSearchQuery,
  AgentToolCall,
  LlmCallMetric,
} from '@cat-factory/kernel'
import {
  type MetricRow,
  type SearchQueryRow,
  type SnapshotRow,
  type ToolCallRow,
  rowToMetric,
  rowToQuery,
  rowToSnapshot,
  rowToToolCall,
} from './telemetryRows.js'

// The UPSTREAM half of the mothership-mode telemetry bucket, on the LOCAL side
// (docs/initiatives/mothership-mode.md, PR 5): the reads the node's ingest sweep walks over its
// own `node:sqlite` telemetry, plus the per-run high-water mark recording what it has already
// carried up to the mothership.
//
// Its own module rather than more of `telemetryStore.ts` because it is a distinct concern reading
// the same tables: the store OWNS the sinks (capture, the product's own reads, the retention
// prune), while this walks them once, forwards, for a sync that only exists on the laptop side.

/** A run whose captured telemetry has not been uploaded to the mothership yet. */
export interface PendingIngestRun {
  workspaceId: string
  executionId: string
  /** The newest captured row across the run's sinks — the high-water mark to mark. */
  lastWriteAt: number
}

/** EXCLUSIVE keyset on the `(createdAt, id)` composite every ingest read walks forwards. */
export interface IngestCursor {
  createdAt: number
  id: string
}

/**
 * The UPSTREAM half of the telemetry bucket (docs/initiatives/mothership-mode.md, PR 5): the
 * reads a mothership-mode node's ingest sweep walks, plus the per-run high-water mark it keeps.
 *
 * These are deliberately NOT kernel port methods. They exist only on the laptop side of the
 * sync — the mothership never reads its telemetry this way — so they are a local-facade
 * differentiator like the work queue, with no symmetry obligation.
 *
 * Every read is FORWARD-ordered (`created_at, id` ascending) and keyset-paged, because the sweep
 * uploads a run oldest-first and must resume exactly where it stopped. Bodies are returned WHOLE
 * — unlike the debug API's bounded pages, the point here is to move the stored bytes — so the
 * caller bounds memory with `limit`, sized per sink to the weight of one row.
 */
export interface LocalTelemetryIngestReader {
  /**
   * Runs whose newest captured row is older than `quiescentBefore` and newer than what was last
   * ingested, oldest-quiescence first. Quiescence is what stands in for "finished": the node
   * holds no run index of its own (executions live on the mothership), and a run that has stopped
   * producing telemetry for the grace period is done as far as its telemetry is concerned. A
   * resumed run simply becomes a candidate again.
   *
   * One grouped query over every sink — never a per-run probe.
   */
  listPendingRuns(quiescentBefore: number, limit: number): PendingIngestRun[]
  listMetrics(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): LlmCallMetric[]
  listSnapshots(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentContextSnapshot[]
  listSearchQueries(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentSearchQuery[]
  listToolCalls(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentToolCall[]
  /** Record that the run is uploaded through `throughAt` (its `lastWriteAt` at sweep time). */
  markIngested(workspaceId: string, executionId: string, throughAt: number, at: number): void
  /**
   * Retention for the bookkeeping table itself. Nothing else bounds it: the rows outlive the
   * telemetry they describe (that is the point — a re-appearing run must not be re-uploaded), so
   * they are pruned on the same window as the sinks, one sweep later than the rows they tracked.
   */
  deleteIngestStateOlderThan(epochMs: number): number
}

/** `WHERE` fragment + binds for the forward keyset every ingest read shares. */
function ingestKeyset(cursor: IngestCursor | undefined): {
  sql: string
  binds: (string | number)[]
} {
  if (!cursor) return { sql: '', binds: [] }
  // Composite, matching the ORDER BY: telemetry is appended in same-millisecond bursts, so a
  // timestamp-only cursor would silently drop rows from the next page.
  return {
    sql: ' AND (created_at > ? OR (created_at = ? AND id > ?))',
    binds: [cursor.createdAt, cursor.createdAt, cursor.id],
  }
}

export class SqliteTelemetryIngestReader implements LocalTelemetryIngestReader {
  constructor(private readonly db: DatabaseSync) {}

  listPendingRuns(quiescentBefore: number, limit: number): PendingIngestRun[] {
    // ONE grouped query across the run-scoped sinks, anti-joined against the high-water
    // marks. `execution_id IS NOT NULL` drops the un-run-scoped LLM calls (an inline call that
    // resolved no run): they are not part of "a finished run's telemetry" and there is nothing to
    // key their upload on.
    const rows = this.db
      .prepare(
        `SELECT w.workspace_id, w.execution_id, MAX(w.last_write) AS last_write
           FROM (
             SELECT workspace_id, execution_id, MAX(created_at) AS last_write
               FROM llm_call_metrics WHERE execution_id IS NOT NULL GROUP BY 1, 2
             UNION ALL
             SELECT workspace_id, execution_id, MAX(created_at)
               FROM agent_context_snapshots GROUP BY 1, 2
             UNION ALL
             SELECT workspace_id, execution_id, MAX(created_at)
               FROM agent_search_queries GROUP BY 1, 2
             UNION ALL
             SELECT workspace_id, execution_id, MAX(created_at)
               FROM agent_tool_calls GROUP BY 1, 2
           ) AS w
           LEFT JOIN telemetry_ingest_state s
             ON s.workspace_id = w.workspace_id AND s.execution_id = w.execution_id
          GROUP BY w.workspace_id, w.execution_id
         HAVING MAX(w.last_write) <= ?
            AND (MAX(s.ingested_through) IS NULL OR MAX(s.ingested_through) < MAX(w.last_write))
          ORDER BY last_write ASC
          LIMIT ?`,
      )
      .all(quiescentBefore, limit) as unknown as {
      workspace_id: string
      execution_id: string
      last_write: number
    }[]
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      executionId: row.execution_id,
      lastWriteAt: row.last_write,
    }))
  }

  private page<Row>(
    table: string,
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): Row[] {
    const keyset = ingestKeyset(cursor)
    return this.db
      .prepare(
        `SELECT * FROM ${table}
          WHERE workspace_id = ? AND execution_id = ?${keyset.sql}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(workspaceId, executionId, ...keyset.binds, limit) as unknown as Row[]
  }

  listMetrics(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): LlmCallMetric[] {
    return this.page<MetricRow>('llm_call_metrics', workspaceId, executionId, cursor, limit).map(
      rowToMetric,
    )
  }

  listSnapshots(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentContextSnapshot[] {
    return this.page<SnapshotRow>(
      'agent_context_snapshots',
      workspaceId,
      executionId,
      cursor,
      limit,
    ).map(rowToSnapshot)
  }

  listSearchQueries(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentSearchQuery[] {
    return this.page<SearchQueryRow>(
      'agent_search_queries',
      workspaceId,
      executionId,
      cursor,
      limit,
    ).map(rowToQuery)
  }

  listToolCalls(
    workspaceId: string,
    executionId: string,
    cursor: IngestCursor | undefined,
    limit: number,
  ): AgentToolCall[] {
    // Walked on the `(created_at, id)` keyset like every other sink, NOT in trajectory order:
    // the upload only has to move each row exactly once, and the mothership re-derives the
    // trajectory from the `(job_id, seq)` the rows carry.
    return this.page<ToolCallRow>('agent_tool_calls', workspaceId, executionId, cursor, limit).map(
      rowToToolCall,
    )
  }

  markIngested(workspaceId: string, executionId: string, throughAt: number, at: number): void {
    // Monotonic: a concurrent sweep that got further must not be walked back, so the update only
    // moves the mark forwards.
    this.db
      .prepare(
        `INSERT INTO telemetry_ingest_state
           (workspace_id, execution_id, ingested_through, ingested_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, execution_id) DO UPDATE SET
           ingested_through = MAX(excluded.ingested_through, telemetry_ingest_state.ingested_through),
           ingested_at = excluded.ingested_at`,
      )
      .run(workspaceId, executionId, throughAt, at)
  }

  deleteIngestStateOlderThan(epochMs: number): number {
    const res = this.db
      .prepare('DELETE FROM telemetry_ingest_state WHERE ingested_at < ?')
      .run(epochMs)
    return Number(res.changes)
  }
}
