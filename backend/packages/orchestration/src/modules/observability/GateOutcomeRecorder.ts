import type {
  ExecutionInstance,
  GateOutcomeKind,
  GateOutcomeRepository,
  Logger,
  PipelineStep,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'

// Writes the `gate_outcomes` projection: one flat row per SETTLED polling gate, so the
// operator dashboard's gate/CI-fixer attempt statistics are an ordinary `GROUP BY` over
// columns instead of a JSON-blob expansion over `steps[].gate.*` (see the port's rationale).
//
// Best-effort by construction: this is observability about a run, and a projection write that
// failed the run it was describing would be the worst possible trade. Every failure is
// reported through `runBestEffort` rather than swallowed, because a silently broken sink
// looks exactly like a deployment whose gates never escalate.

/** What the caller knows at the moment a gate settles. */
export interface SettledGate {
  workspaceId: string
  instance: ExecutionInstance
  step: PipelineStep
  /** The gate step's index, which (with the run) gives the row its replay-stable identity. */
  stepIndex: number
  /** The helper agent kind this gate escalates to, or null when it has none. */
  helperKind: string | null
  outcome: GateOutcomeKind
}

export interface GateOutcomeRecorderDeps {
  gateOutcomeRepository: GateOutcomeRepository
  now: () => number
  logger?: Logger
}

export class GateOutcomeRecorder {
  constructor(private readonly deps: GateOutcomeRecorderDeps) {}

  /**
   * Record a gate's terminal verdict. Never throws.
   *
   * The row id is DERIVED (`<runId>:<stepIndex>:<outcome>`) rather than minted, because the
   * durable drivers replay: a minted id would let one settle become two rows and inflate every
   * statistic the projection exists to report. Deriving it makes the write idempotent under
   * replay while still letting a step that is RE-RUN and ends DIFFERENTLY record that second,
   * genuinely different verdict. A re-run that ends the same way collapses onto the first row,
   * which is the honest reading: the gate settled that way, once, on this step.
   */
  async record(settled: SettledGate): Promise<void> {
    const { workspaceId, instance, step, stepIndex, helperKind, outcome } = settled
    const gate = step.gate
    if (!gate) return
    const now = this.deps.now()
    // A gate that never dispatched a helper has no attempt log; the count of FAILED entries is
    // what separates "the fixer keeps crashing" from "the fixer cannot fix it".
    const helperFailures = (gate.attemptLog ?? []).filter((a) => a.outcome === 'failed').length
    await runBestEffort(
      this.deps.logger ?? noopLogger,
      'gate-outcome: record settled gate',
      () =>
        this.deps.gateOutcomeRepository.record({
          id: `${instance.id}:${stepIndex}:${outcome}`,
          workspaceId,
          executionId: instance.id,
          blockId: instance.blockId,
          gateKind: step.agentKind,
          helperKind,
          outcome,
          attempts: gate.attempts,
          maxAttempts: gate.maxAttempts,
          helperFailures,
          // `watchSince` is stamped on every gate's first entry (not only the time-windowed
          // ones), so it is the gate's own start. Null rather than 0 when it is somehow unset:
          // a duration of zero would read as an instant gate, which is a different claim.
          durationMs: gate.watchSince != null ? Math.max(0, now - gate.watchSince) : null,
          createdAt: now,
        }),
      { workspaceId, executionId: instance.id, gateKind: step.agentKind, outcome },
    )
  }
}
