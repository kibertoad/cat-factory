// Queryable projection of SETTLED polling gates: the store behind the operator dashboard's
// gate/CI-fixer attempt statistics.
//
// Why a projection at all: a gate's live state (`attempts`, `attemptLog`, the escalation
// phase) lives INSIDE the per-run `detail` JSON blob as `steps[].gate.*`, which is the right
// home for the run window and the wrong one for a rollup. Aggregating it would mean
// dialect-divergent JSON-array expansion (`json_each` versus `jsonb_array_elements`) reaching
// into the engine's internal step-serialization shape, in SQL, on both runtimes: a coupling
// that breaks the moment a step field is renamed, and that no `GROUP BY` can express in one
// query anyway. So the engine writes one flat row when a gate reaches a terminal verdict, and
// the rollup is an ordinary aggregate over columns.
//
// One row per SETTLED GATE, not per attempt. The per-round history is already durable on the
// step (and is what the run UI reads); what an operator cannot otherwise ask is how a gate
// ENDED and how much helper work it took to get there, which is exactly one row's worth of
// facts. Deliberately in the MAIN store beside `agent_runs`, not the telemetry store: it is
// account-scoped through the same `workspaces` sub-select every other platform rollup uses,
// and a telemetry-store home would have forced either a cross-store join or a workspace-id
// list threaded through the read (the one store rule in the initiative doc).

/** How a gate ended. A gate still looping has no row: only terminal verdicts are recorded. */
export type GateOutcomeKind =
  /** The precheck ultimately passed and the run advanced. */
  | 'passed'
  /** The attempt budget was spent (or no helper could be escalated to) and a human took over. */
  | 'exhausted'

/** One settled gate, written by the engine as the gate reaches its terminal verdict. */
export interface GateOutcomeRecord {
  id: string
  workspaceId: string
  /** The run whose step this gate was. */
  executionId: string
  /** The block the run belongs to, so a drill-down can reveal the task. */
  blockId: string
  /** The gate step's agent kind (`ci` / `conflicts` / `post-release-health` / a custom one). */
  gateKind: string
  /** The helper agent this gate escalates to (`ci-fixer` / …), or null when it has none. */
  helperKind: string | null
  outcome: GateOutcomeKind
  /** Helper dispatches spent on this gate. 0 ⇒ the precheck passed with nothing spun up. */
  attempts: number
  /** The attempt budget the task's merge preset allowed. */
  maxAttempts: number
  /**
   * Helper dispatches whose own job FAILED, as opposed to finishing and leaving the precheck
   * red. Recorded separately because the two need opposite fixes: a fixer that keeps crashing
   * is a platform fault, one that runs clean and cannot get the build green is a product one.
   */
  helperFailures: number
  /** Wall-clock ms from the gate's first entry to this verdict, or null when unknown. */
  durationMs: number | null
  /** When the gate settled (epoch ms). */
  createdAt: number
}

/** One `(gateKind, helperKind, outcome)` bucket of settled gates in the window. */
export interface PlatformGateOutcomeCount {
  gateKind: string
  helperKind: string | null
  outcome: GateOutcomeKind
  /** Gates that settled this way. */
  gates: number
  /** Helper dispatches summed across them. */
  attempts: number
  /** Helper dispatches whose job failed, summed across them. */
  helperFailures: number
  /** Of {@link gates}, how many settled with zero helper dispatches. */
  cleanGates: number
}

export interface GateOutcomeRepository {
  /**
   * Record a settled gate. Best-effort at the call site (a failed write must never fail the
   * run), and FIRST-WRITE-WINS on the id: the durable drivers replay, so the same gate can
   * settle twice with the same minted id and the second write must not recompute the row.
   */
  record(row: GateOutcomeRecord): Promise<void>
  /**
   * Gates that SETTLED at or after `sinceEpochMs`, grouped by `(gateKind, helperKind,
   * outcome)`, for the account's workspaces. One aggregate query; the service folds these
   * into the dashboard's per-gate statistics.
   */
  statsSince(accountId: string, sinceEpochMs: number): Promise<PlatformGateOutcomeCount[]>
  /** Prune settled gates older than `cutoff` (epoch ms). Returns the rows removed. */
  deleteOlderThan(cutoff: number): Promise<number>
}
