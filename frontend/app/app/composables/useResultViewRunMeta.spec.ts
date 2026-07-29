import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '~/types/execution'
import { resultViewStepIndex } from '~/composables/useResultViewRunMeta'

// The off-path fallback: which step a result window reports run metadata for when it was opened
// from a board card / the inspector rather than from the run's timeline. The precedence exists
// because a window's kind set can mix model-running steps with bookkeeping ones — the initiative
// tracker is registered for the analyst AND `initiative-committer`, which runs no model — so
// "the most recent one" alone would anchor on the step with no telemetry.
//
// `initiative-planner` appears in these fixtures as a step that declares NO result view (it opens
// the generic reader, since its human gate needs the approve / request-changes / reject rail the
// tracker has no room for), which is why it never wins a match here however recent or metered it
// is — a case worth pinning, since the run it belongs to is the tracker's own.

function step(agentKind: string, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind, state: 'pending', ...overrides } as PipelineStep
}

/** A step that recorded model calls (the shape `attachStepMetrics` folds onto the run). */
function metered(agentKind: string, calls: number, startedAt = 1_000): PipelineStep {
  return step(agentKind, { startedAt, metrics: { calls } as PipelineStep['metrics'] })
}

describe('resultViewStepIndex', () => {
  it('is null when no step declares the view', () => {
    const steps = [step('coder'), step('tester')]
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBeNull()
  })

  it('falls back to the first declaring step before the run reaches any of them', () => {
    const steps = [
      step('initiative-interviewer'),
      step('initiative-analyst'),
      step('initiative-planner'),
    ]
    // Index 1 — the analyst; the interviewer declares the PLANNING window, not the tracker.
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(1)
  })

  it('prefers the last started step while the run is mid-flight with no telemetry yet', () => {
    const steps = [
      step('initiative-interviewer', { startedAt: 10 }),
      step('initiative-analyst', { startedAt: 20 }),
      step('initiative-planner'),
    ]
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(1)
  })

  it('prefers the last step that actually ran a model over a later bookkeeping step', () => {
    const steps = [
      metered('initiative-interviewer', 4),
      metered('initiative-analyst', 12),
      // Declares no result view, so it is not a candidate however metered it is.
      metered('initiative-planner', 31),
      // Runs no model, so it records no calls — and must not shadow the analyst's telemetry.
      step('initiative-committer', { startedAt: 2_000 }),
    ]
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(1)
  })

  it('ignores a metered step belonging to another window', () => {
    const steps = [metered('initiative-interviewer', 9), step('initiative-analyst')]
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(1)
    expect(resultViewStepIndex(steps, 'initiative-planning')).toBe(0)
  })

  it('treats a zero-call rollup as unmetered', () => {
    const steps = [
      metered('initiative-analyst', 5),
      step('initiative-committer', {
        startedAt: 3_000,
        metrics: { calls: 0 } as PipelineStep['metrics'],
      }),
    ]
    // The analyst keeps the tier-1 match: a rollup that recorded nothing is not telemetry, so
    // the later step doesn't shadow it just for having a `metrics` object.
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(0)
  })

  it('ignores the planner, which opens the generic reader rather than the tracker', () => {
    // The planner is the planning run's most recent, most metered step at its human gate — and
    // still must not be what the tracker reports on, because it declares no result view. If it
    // ever regained one, its approval gate would lose the review rail again.
    const steps = [metered('initiative-analyst', 5), metered('initiative-planner', 40, 9_000)]
    expect(resultViewStepIndex(steps, 'initiative-tracker')).toBe(0)
  })
})
