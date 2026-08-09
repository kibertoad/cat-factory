import type { DatabaseSync } from 'node:sqlite'
import { queryOne } from './db.js'

// Which runs the LOCAL telemetry store is still AUTHORITATIVE for
// (docs/initiatives/mothership-mode.md, PR 5) — the fact the read-through needs and the sinks
// alone cannot supply.
//
// The read-through's rule is local-wins, and the gate it shipped with was emptiness: a local
// answer with rows in it was taken as the whole run. That is right for the two cases the feature
// was built for (a run this node is driving, and a run it never touched), and WRONG for the third,
// which the retention prune manufactures: the prune deletes by `created_at`, so a run that
// straddles the cutoff keeps its newer rows and loses its older ones. The store then answers with
// a strict SUBSET and nothing about the answer says so — the observability panel lists some of the
// calls, `countByExecution` returns fewer dispatches than happened, and `summarizeByExecution`
// reports a token total that is simply too low. That is the same defect the read-through exists to
// remove, one level in: not "absent renders as zero" but "partial renders as whole", and the
// rollup is worse than the list because a number carries no hint that it is short.
//
// A subset is not detectable AFTER the fact — the missing rows are missing — so the prune records
// it as it happens. This module owns that record: a run named here has had local telemetry
// deleted, so the local store is no longer the whole truth for it and the read-through consults
// the mothership (which holds the run's complete ingested copy).
//
// Its own module rather than more of `telemetryStore.ts`, for the same reason
// `telemetryIngestReader.ts` is: the store owns the SINKS, and this is one cross-cutting fact
// ABOUT them, written by all three and read by neither.

/**
 * The DDL for the coverage table, appended to the local telemetry schema.
 *
 * No `execution_id` foreign key and no cascade: the rows this marker is about are exactly the ones
 * that no longer exist. It is deliberately not scoped per SINK — the run-scoped sinks share
 * one retention window, so they lose the same runs together, and a marker that over-reports (this
 * run lost SOMETHING) only ever costs a round trip, where one that under-reports resurrects the
 * false-total this exists to prevent.
 */
export const TELEMETRY_COVERAGE_SCHEMA = `
-- Runs whose LOCAL telemetry the retention prune has partially deleted, so the local store is no
-- longer authoritative for them (docs/initiatives/mothership-mode.md, PR 5). Local-only
-- bookkeeping with no mothership counterpart, like telemetry_ingest_state.
CREATE TABLE IF NOT EXISTS telemetry_pruned_runs (
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  -- Refreshed by every prune that takes more of the run, so a long-lived run that keeps recording
  -- after losing its prefix stays marked for as long as that prefix is missing.
  pruned_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, execution_id)
);
`

/**
 * Whether the local telemetry store still holds ALL of a run's captured rows, and the prune-side
 * bookkeeping that keeps the answer true.
 *
 * Deliberately NOT a kernel port method. The question only means anything where a store is one of
 * two copies — a Postgres or D1 deployment holds the only copy there is, so "is it complete" is
 * always yes there and the read-through does not exist. Like the ingest reader, this is a
 * local-facade differentiator with no symmetry obligation.
 */
export interface LocalTelemetryCoverage {
  /**
   * False once the prune has deleted any of this run's local telemetry.
   *
   * Answering FALSE is the safe direction: it costs a round trip to the mothership and returns the
   * complete answer. Answering true when rows are missing is the failure mode — a short list and
   * an understated token total, rendered as though they were the run.
   */
  isRunLocallyComplete(workspaceId: string, executionId: string): boolean
  /**
   * Mark every run holding a row older than `cutoff` in `table` as partially pruned. Called by
   * each sink's `deleteOlderThan` BEFORE it deletes — afterwards the evidence is gone.
   *
   * One grouped query over the range the delete is about to take, never a per-run probe.
   */
  markPrunedBefore(table: PrunableTelemetryTable, cutoff: number): void
  /**
   * Drop markers for runs the store no longer holds ANY telemetry for, and report how many.
   *
   * A marker earns its keep only while the store still answers with a subset; once the last row of
   * a run is gone the read-through's emptiness gate already falls through, so keeping it would be
   * pure growth. Exact rather than time-based on purpose: ageing a marker out on the retention
   * window would expire it while the run's later rows were still present — precisely the window in
   * which it is load-bearing.
   */
  forgetSettledRuns(): number
}

/** A run-scoped telemetry table whose prune makes the local store non-authoritative. */
export type PrunableTelemetryTable =
  | 'llm_call_metrics'
  | 'agent_context_snapshots'
  | 'agent_search_queries'
  | 'agent_tool_calls'

/** Every prunable table, for the settled-marker sweep's "no rows anywhere" test. */
const PRUNABLE_TABLES: readonly PrunableTelemetryTable[] = [
  'llm_call_metrics',
  'agent_context_snapshots',
  'agent_search_queries',
  'agent_tool_calls',
]

export class SqliteTelemetryCoverage implements LocalTelemetryCoverage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  isRunLocallyComplete(workspaceId: string, executionId: string): boolean {
    // `SELECT 1 AS hit` — the marker row's existence is the whole answer, so only the
    // presence of a row is read.
    const row = queryOne<{ hit: number }>(
      this.db,
      'SELECT 1 AS hit FROM telemetry_pruned_runs WHERE workspace_id = ? AND execution_id = ? LIMIT 1',
      workspaceId,
      executionId,
    )
    return row === undefined
  }

  markPrunedBefore(table: PrunableTelemetryTable, cutoff: number): void {
    // The table name is a closed union, never caller text, so it is safe to interpolate — the
    // bound parameters are the values.
    //
    // `execution_id IS NOT NULL` because an inline call that resolved no run is nullable on the
    // metrics sink; such a row belongs to no run, so pruning it makes no run incomplete.
    this.db
      .prepare(
        `INSERT INTO telemetry_pruned_runs (workspace_id, execution_id, pruned_at)
         SELECT DISTINCT workspace_id, execution_id, ?
           FROM ${table}
          WHERE created_at < ? AND execution_id IS NOT NULL
         ON CONFLICT(workspace_id, execution_id) DO UPDATE SET pruned_at = excluded.pruned_at`,
      )
      .run(this.now(), cutoff)
  }

  forgetSettledRuns(): number {
    const noRowsLeft = PRUNABLE_TABLES.map(
      (table) => `NOT EXISTS (
           SELECT 1 FROM ${table} t
            WHERE t.workspace_id = telemetry_pruned_runs.workspace_id
              AND t.execution_id = telemetry_pruned_runs.execution_id
        )`,
    ).join(' AND ')
    const res = this.db.prepare(`DELETE FROM telemetry_pruned_runs WHERE ${noRowsLeft}`).run()
    return Number(res.changes)
  }
}
