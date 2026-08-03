import type { ExecutionInstance } from '@cat-factory/contracts'
import type { LlmRunSpan, LlmStepSpan } from '@cat-factory/kernel'

// The PARENTS of everything a run emitted to the external trace: its root span and one span
// per agent kind that actually ran. Pure, so the fold is testable without an engine.
//
// They are built at SETTLEMENT because that is the first moment a run's boundaries are known.
// A generation exported hours earlier already named its parent by DERIVING the id from the run
// (see `deriveStepSpanId` in `@cat-factory/observability-otel`), so nothing has to be buffered
// and no producer has to have seen another — the backend assembles the tree from ids alone.
// It is also the ordinary OpenTelemetry ordering, where a parent exports after the children it
// outlives; the only unusual thing here is how long "outlives" can be.

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
  settledAt: number,
): RunTraceSpans | null {
  const started = instance.steps
    .map((step) => step.startedAt)
    .filter((at): at is number => typeof at === 'number')
  const runStartedAt = instance.createdAt ?? (started.length > 0 ? Math.min(...started) : null)
  if (runStartedAt === null) return null

  // A settle time earlier than the start would render as a negative-width span; clamp rather
  // than drop, since the run itself is real either way.
  const runEndedAt = Math.max(runStartedAt, settledAt)
  const failure = instance.failure ?? null
  const ok = instance.status === 'done'

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
      failed: (existing?.failed ?? false) || (!ok && failure?.stepIndex === index),
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
