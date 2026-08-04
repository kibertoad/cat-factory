import type { ExecutionInstance, PipelineStep } from '@cat-factory/contracts'
import type { LlmRunSpan, LlmStepSpan } from '@cat-factory/kernel'

// The PARENTS of everything a run emitted to the external trace: its root span, one span per
// agent kind that ran, and one nested under those for each helper kind a step escalated to.
// Pure, so the fold is testable without an engine.
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
// `AgentFailure.occurredAt`, `PipelineStep.firstStartedAt`).
//
// Two facts the fold cannot get from `step.agentKind` alone, and both are about CYCLES, which
// is what this platform's runs actually repeat (a duplicate kind within one pipeline is rare;
// a review that spawns fixes four times is not):
//
//   - WHAT ran. A gate escalating to `ci-fixer`, a Tester handing off to the fixer and a
//     two-phase coder's `fork-proposer` are all dispatched under a kind that is not the step's,
//     and every telemetry row they produce is tagged with THAT kind. Without `step.dispatches`
//     those spans name a parent nobody emits, and dangle inside their own run's trace.
//   - HOW OFTEN. A span cannot separate the rounds of a loop, because its children carry no
//     attempt ordinal to be separated BY. So the rounds are counted and stated rather than
//     silently folded into one long span.

/** A settled run's root span plus the per-agent-kind step spans that hang under it. */
export interface RunTraceSpans {
  run: LlmRunSpan
  steps: LlmStepSpan[]
}

/** One agent kind's slice, accumulated across every step that ran it. */
interface StepFold {
  startedAt: number
  endedAt: number
  stepCount: number
  attemptCount: number
  failed: boolean
  parentAgentKind?: string
}

/** When a step actually began, across every attempt rather than only the one in flight. */
function stepStartedAt(step: PipelineStep): number | null {
  const at = step.firstStartedAt ?? step.startedAt
  return typeof at === 'number' ? at : null
}

/** Every epoch-ms stamp the run itself recorded, in no particular order. */
function observedStamps(instance: ExecutionInstance): number[] {
  const stamps: number[] = []
  for (const step of instance.steps) {
    // A step in flight when the run settled carries no `finishedAt` (it is stamped only on the
    // transition to `done`), so its start and its last observed sign of life are what bound it.
    for (const stamp of [stepStartedAt(step), step.finishedAt, step.lastActivityAt]) {
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
 * How many times a step dispatched a given kind. Falls back to the step's own start count for
 * its OWN kind, because an inline step (a judge, a consensus panel, a reviewer served without a
 * container) never reaches the dispatch funnel and would otherwise report zero rounds for work
 * that plainly ran.
 */
function dispatchCount(step: PipelineStep, agentKind: string): number {
  const recorded = step.dispatches?.find((d) => d.agentKind === agentKind)?.count
  if (recorded) return recorded
  return agentKind === step.agentKind ? (step.attempts ?? 1) : 1
}

/** The kinds one step contributed a span for: its own, then any helper it dispatched. */
function kindsOf(step: PipelineStep): { agentKind: string; parentAgentKind?: string }[] {
  const helpers = (step.dispatches ?? [])
    .map((d) => d.agentKind)
    .filter((kind) => kind !== step.agentKind)
    .map((agentKind) => ({ agentKind, parentAgentKind: step.agentKind }))
  return [{ agentKind: step.agentKind }, ...helpers]
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
    .map(stepStartedAt)
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
    const startedAt = stepStartedAt(step)
    if (startedAt === null) continue
    // A helper shares its host step's window. That is not an approximation to apologise for: a
    // parent span is REQUIRED to contain its children, and the helper ran inside the step, so
    // the host's window is the tightest bound the run actually recorded.
    const endedAt = Math.min(runEndedAt, step.finishedAt ?? runEndedAt)
    for (const { agentKind, parentAgentKind } of kindsOf(step)) {
      const existing = folds.get(agentKind)
      folds.set(agentKind, {
        startedAt: Math.min(existing?.startedAt ?? startedAt, startedAt),
        endedAt: Math.max(existing?.endedAt ?? endedAt, endedAt),
        stepCount: (existing?.stepCount ?? 0) + 1,
        attemptCount: (existing?.attemptCount ?? 0) + dispatchCount(step, agentKind),
        // Only the step the run actually failed ON is marked ERROR. Marking every step of a
        // failed run would say the reviewer that passed had failed too.
        failed: (existing?.failed ?? false) || failedStepIndex === index,
        // A kind that is some step's OWN kind keeps its run-level parent even if another step
        // also dispatched it as a helper: one span cannot hang in two places, and the spans
        // underneath it cannot be told apart to split it.
        parentAgentKind: existing ? existing.parentAgentKind : parentAgentKind,
      })
    }
  }

  const steps: LlmStepSpan[] = [...folds].map(([agentKind, fold]) => ({
    workspaceId,
    executionId: instance.id,
    agentKind,
    ...(fold.parentAgentKind ? { parentAgentKind: fold.parentAgentKind } : {}),
    startedAt: fold.startedAt,
    endedAt: Math.max(fold.startedAt, fold.endedAt),
    stepCount: fold.stepCount,
    attemptCount: fold.attemptCount,
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
