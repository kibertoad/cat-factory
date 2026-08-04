import type { ExecutionInstance } from '@cat-factory/contracts'
import type { LlmRunSpan, LlmStepSpan } from '@cat-factory/kernel'

// The PARENTS of everything a run emitted to the external trace: its root span and one span
// per agent kind that actually ran. Pure, so the fold is testable without an engine.
//
// They are built at SETTLEMENT because that is the first moment a run's boundaries are known.
// A generation exported hours earlier already named its parent by DERIVING the id from the run
// (see `deriveStepSpanId` in `@cat-factory/observability-otel`), so nothing has to be buffered
// and no producer has to have seen another: the backend assembles the tree from ids alone.
// It is also the ordinary OpenTelemetry ordering, where a parent exports after the children it
// outlives; the only unusual thing here is how long "outlives" can be.
//
// This is a pure function of the PERSISTED RUN, which is a correctness property rather than a
// testing convenience. `emitInstance` fires again for an already-terminal run (a durable
// re-drive, a decision resolved against a run that has settled), so this fold runs more than
// once for one run. Every id it feeds is DERIVED, so a re-emission re-exports the SAME span
// ids; reading the wall clock for the run's extent would pair those stable ids with a
// DIFFERENT duration each time, which a backend cannot collapse the way it collapses a
// byte-identical duplicate. The extent therefore comes from stamps the run already recorded,
// each of them set-once precisely so a replay cannot move it (`StepGraph.finishStep`,
// `AgentFailure.occurredAt`).

/** A settled run's root span plus the per-agent-kind step spans that hang under it. */
export interface RunTraceSpans {
  run: LlmRunSpan
  steps: LlmStepSpan[]
}

/** One agent kind's slice, accumulated across every step of that kind. */
interface StepFold {
  startedAt: number
  endedAt: number
  stepCount: number
  failed: boolean
}

/** Every epoch-ms stamp the run itself recorded, in no particular order. */
function observedStamps(instance: ExecutionInstance): number[] {
  const stamps: number[] = []
  for (const step of instance.steps) {
    // A step in flight when the run settled carries no `finishedAt` (it is stamped only on the
    // transition to `done`), so its start and its last observed sign of life are what bound it.
    for (const stamp of [step.startedAt, step.finishedAt, step.lastActivityAt]) {
      if (typeof stamp === 'number') stamps.push(stamp)
    }
  }
  // The exact instant a FAILED run settled. A `done` run's counterpart is its last step's
  // `finishedAt`, already collected above, so both terminal states are bounded by a fact the
  // run recorded rather than by how long the platform took to notice.
  if (typeof instance.failure?.occurredAt === 'number') stamps.push(instance.failure.occurredAt)
  return stamps
}

/**
 * Build the trace parents for a settled run, or null when the run has no observable extent at
 * all (never stamped with a creation time and never started a step). Null rather than a
 * zero-width span: a run that ran nothing emitted no children, so there is nothing to be the
 * parent of, and inventing a root would put an empty trace in front of an operator.
 *
 * The steps fold by agent KIND rather than by index, because that is the only grain a
 * generation can name (its event carries no step ordinal) and the grain the rest of the LLM
 * telemetry already buckets by. Two `coder` steps in one pipeline therefore become one span
 * covering both, reported as `stepCount: 2` rather than passed off as a single long step.
 */
export function buildRunTraceSpans(
  workspaceId: string | null,
  instance: ExecutionInstance,
): RunTraceSpans | null {
  const started = instance.steps
    .map((step) => step.startedAt)
    .filter((at): at is number => typeof at === 'number')
  const runStartedAt = instance.createdAt ?? (started.length > 0 ? Math.min(...started) : null)
  if (runStartedAt === null) return null

  // The run's end is the latest thing it was OBSERVED to do. Taking the max against the start
  // also covers a creation stamp that postdates every step, which would otherwise render as a
  // negative-width span.
  const runEndedAt = Math.max(runStartedAt, ...observedStamps(instance))
  const failure = instance.failure ?? null
  const ok = instance.status === 'done'
  // A failed run whose failure was never attributed to a step (`stepIndex` is optional, and a
  // bootstrap failure has no step to point at) leaves every step span UNSET rather than
  // guessing at one. The root still carries the error, so the failure is not lost; what is
  // withheld is the single thing the run does not know, which is where it happened.
  const failedStepIndex = ok ? null : (failure?.stepIndex ?? null)

  const folds = new Map<string, StepFold>()
  for (const [index, step] of instance.steps.entries()) {
    // A step that never started contributed no telemetry, so it gets no span. A SKIPPED step is
    // the case that matters: an estimate-gated step is absent from the run's work, and giving
    // it a span would show an operator a step that was deliberately not run.
    if (typeof step.startedAt !== 'number') continue
    const endedAt = Math.min(runEndedAt, step.finishedAt ?? runEndedAt)
    const existing = folds.get(step.agentKind)
    folds.set(step.agentKind, {
      startedAt: Math.min(existing?.startedAt ?? step.startedAt, step.startedAt),
      endedAt: Math.max(existing?.endedAt ?? endedAt, endedAt),
      stepCount: (existing?.stepCount ?? 0) + 1,
      // Only the step the run actually failed ON is marked ERROR. Marking every step of a
      // failed run would say the reviewer that passed had failed too.
      failed: (existing?.failed ?? false) || failedStepIndex === index,
    })
  }

  const steps: LlmStepSpan[] = [...folds].map(([agentKind, fold]) => ({
    workspaceId,
    executionId: instance.id,
    agentKind,
    startedAt: fold.startedAt,
    endedAt: Math.max(fold.startedAt, fold.endedAt),
    stepCount: fold.stepCount,
    ok: !fold.failed,
    errorMessage: fold.failed ? (failure?.message ?? null) : null,
  }))

  return {
    run: {
      workspaceId,
      executionId: instance.id,
      pipelineName: instance.pipelineName,
      startedAt: runStartedAt,
      endedAt: runEndedAt,
      ok,
      errorMessage: ok ? null : (failure?.message ?? null),
    },
    steps,
  }
}
