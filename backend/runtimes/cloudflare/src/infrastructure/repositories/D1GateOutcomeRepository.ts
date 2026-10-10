import type {
  GateOutcomeKind,
  GateOutcomeRecord,
  GateOutcomeRepository,
  PlatformGateOutcomeCount,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// The settled-gate projection on D1: the write the engine's gate machine makes, and the ONE
// aggregate the operator dashboard's gate statistics read. Mirrors
// {@link DrizzleGateOutcomeRepository}; the cross-runtime conformance suite asserts they agree.

/** The account's workspace ids, as the scalar sub-select the account-scoped read uses. */
const ACCOUNT_WORKSPACES = 'SELECT id FROM workspaces WHERE account_id = ?'

/** Guard a stored `outcome` into the port's union; anything else is treated as exhausted. */
function decodeOutcome(raw: string): GateOutcomeKind {
  return raw === 'passed' ? 'passed' : 'exhausted'
}

export class D1GateOutcomeRepository implements GateOutcomeRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(row: GateOutcomeRecord): Promise<void> {
    // FIRST WRITE WINS on the derived id: the durable drivers replay, so the same settle can
    // arrive twice, and re-inserting it would inflate every count this table exists to report.
    // `ON CONFLICT(id) DO NOTHING` rather than `INSERT OR IGNORE`, which would also swallow a
    // genuine constraint violation (the `llm_call_metrics` precedent).
    await this.db
      .prepare(
        `INSERT INTO gate_outcomes
           (id, workspace_id, execution_id, block_id, gate_kind, helper_kind, outcome,
            attempts, max_attempts, helper_failures, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        row.id,
        row.workspaceId,
        row.executionId,
        row.blockId,
        row.gateKind,
        row.helperKind,
        row.outcome,
        row.attempts,
        row.maxAttempts,
        row.helperFailures,
        row.durationMs,
        row.createdAt,
      )
      .run()
  }

  async statsSince(accountId: string, sinceEpochMs: number): Promise<PlatformGateOutcomeCount[]> {
    const { results } = await this.db
      .prepare(
        // One GROUP BY: the counts, the attempt sums and the precheck-clean tally all come off
        // the same scan. `helper_kind` joins the grouping key rather than being aggregated:
        // it is a property of the gate definition, so it does not vary within a gate kind.
        `SELECT gate_kind, helper_kind, outcome,
                COUNT(*) AS gates,
                SUM(attempts) AS attempts,
                SUM(helper_failures) AS helper_failures,
                SUM(CASE WHEN attempts = 0 THEN 1 ELSE 0 END) AS clean_gates
         FROM gate_outcomes
         WHERE workspace_id IN (${ACCOUNT_WORKSPACES}) AND created_at >= ?
         GROUP BY gate_kind, helper_kind, outcome
         ORDER BY gates DESC`,
      )
      .bind(accountId, sinceEpochMs)
      .all<{
        gate_kind: string
        helper_kind: string | null
        outcome: string
        gates: number
        attempts: number | null
        helper_failures: number | null
        clean_gates: number | null
      }>()
    return (results ?? []).map((r) => ({
      gateKind: r.gate_kind,
      helperKind: r.helper_kind ?? null,
      outcome: decodeOutcome(r.outcome),
      gates: Number(r.gates),
      attempts: Number(r.attempts ?? 0),
      helperFailures: Number(r.helper_failures ?? 0),
      cleanGates: Number(r.clean_gates ?? 0),
    }))
  }

  async deleteOlderThan(cutoff: number): Promise<number> {
    const res = await this.db
      .prepare('DELETE FROM gate_outcomes WHERE created_at < ?')
      .bind(cutoff)
      .run()
    return res.meta.changes ?? 0
  }
}
