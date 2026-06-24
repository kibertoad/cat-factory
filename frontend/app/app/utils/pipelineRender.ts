// Shared rendering helpers for the run-step / pipeline views (PipelineProgress,
// TaskPipelineMini, AgentStepDetail), so the "is this step still live?" logic stays
// in one place rather than being re-derived as inline ternaries per component.

import type { AgentState, PipelineStep } from '~/types/execution'

/**
 * Visual state of a conditionally-run companion attached to a gate step (today the
 * Tester's `fixer`): it MIGHT run (`possible`), is running now (`running`), ran at
 * least once (`completed`), the gate passed without ever needing it (`skipped`), or
 * it was mid-run when the pipeline failed and gave up (`failed`).
 */
export type CompanionState = 'possible' | 'running' | 'completed' | 'skipped' | 'failed'

/**
 * Visual language for a step (or its companion) that was left `working` when its
 * run failed. A failed mid-flight step is NOT live — it should read as "Failed" with
 * a red cross, never a frozen/spinning loader or a misleading "Working" label.
 */
export const FAILED_STEP_META = {
  label: 'Failed',
  color: '#ef4444',
  icon: 'i-lucide-circle-x',
} as const

/**
 * Whether a step left in `working` state should be rendered as failed: it never
 * finished, and its run has terminated as `failed`, so the engine gave up on it.
 */
export function isFailedStep(state: AgentState, runFailed: boolean): boolean {
  return runFailed && state === 'working'
}

/** Descriptor for the companion node a gate step renders beneath itself. */
export interface GateCompanion {
  /** Agent kind of the companion (resolved through `agentKindMeta` for icon/label). */
  kind: string
  state: CompanionState
}

/** Display metadata per companion state (badge label + Tailwind colour classes). */
export const COMPANION_STATE_META: Record<
  CompanionState,
  { label: string; dot: string; text: string; icon: string }
> = {
  possible: {
    label: 'May run',
    dot: 'border-slate-600 bg-slate-800/40',
    text: 'text-slate-400',
    icon: 'i-lucide-circle-dashed',
  },
  running: {
    label: 'Running',
    dot: 'border-amber-400 bg-amber-500/20',
    text: 'text-amber-300',
    icon: 'i-lucide-loader',
  },
  completed: {
    label: 'Ran',
    dot: 'border-emerald-500 bg-emerald-500/20',
    text: 'text-emerald-300',
    icon: 'i-lucide-circle-check',
  },
  skipped: {
    label: 'Skipped',
    dot: 'border-slate-700 bg-slate-800/40',
    text: 'text-slate-500',
    icon: 'i-lucide-circle-slash',
  },
  failed: {
    label: 'Gave up',
    dot: 'border-rose-500 bg-rose-500/20',
    text: 'text-rose-400',
    icon: 'i-lucide-circle-x',
  },
}

/**
 * The conditionally-run companion (if any) a gate step drives, with its current
 * state — so the pipeline views can render it as a distinct sub-node marked
 * possible / running / completed / skipped. The Tester's `fixer` loop is modelled via
 * `step.test`; the polling gates (`ci` → `ci-fixer`, `conflicts` → `conflict-resolver`)
 * via `step.gate`, which all share the same possible/running/completed/skipped shape.
 */
export function gateCompanionFor(step: PipelineStep, runFailed = false): GateCompanion | null {
  if (step.agentKind === 'tester') {
    const attempts = step.test?.attempts ?? 0
    if (step.state === 'done') {
      // The gate finished: it ran the fixer iff it ever dispatched one.
      return { kind: 'fixer', state: attempts > 0 ? 'completed' : 'skipped' }
    }
    // A fixer caught mid-loop by a failed run gave up, not "running".
    if (step.test?.phase === 'fixing')
      return { kind: 'fixer', state: runFailed ? 'failed' : 'running' }
    if (attempts > 0) return { kind: 'fixer', state: 'completed' }
    // Pending, or testing with no attempt yet — the fixer might still be needed.
    return { kind: 'fixer', state: 'possible' }
  }
  const helper =
    step.agentKind === 'ci'
      ? 'ci-fixer'
      : step.agentKind === 'conflicts'
        ? 'conflict-resolver'
        : null
  if (helper) {
    const attempts = step.gate?.attempts ?? 0
    if (step.state === 'done') {
      // The gate passed: it ran the helper iff it ever dispatched one.
      return { kind: helper, state: attempts > 0 ? 'completed' : 'skipped' }
    }
    // A helper (ci-fixer / conflict-resolver) caught mid-run when the gate exhausted
    // its attempt budget and the run failed gave up — never show it as "running".
    if (step.gate?.phase === 'working')
      return { kind: helper, state: runFailed ? 'failed' : 'running' }
    if (attempts > 0) return { kind: helper, state: 'completed' }
    // Checking the precheck with no escalation yet — the helper might still be needed.
    return { kind: helper, state: 'possible' }
  }
  return null
}

/**
 * Whether an agent kind is a companion of a producer step (the quality companions
 * that grade-and-loop, plus the Tester's `fixer`). Used to give companion steps a
 * visually distinct treatment in the pipeline.
 */
export function isCompanionKind(kind: string): boolean {
  return (
    kind === 'reviewer' ||
    kind === 'architect-companion' ||
    kind === 'spec-companion' ||
    kind === 'fixer'
  )
}

/**
 * Tailwind classes for a subtask-item status icon. An in-progress item spins only
 * while the run is live: once the run has failed, a step left mid-flight (its item
 * state still `in_progress`) keeps its colour but stops spinning, matching the frozen
 * failure card. Completed items are emerald, everything else muted.
 */
export function subtaskIconClass(status: string, runFailed: boolean): string[] {
  return [
    status === 'in_progress'
      ? runFailed
        ? 'text-indigo-400'
        : 'animate-spin text-indigo-400'
      : '',
    status === 'completed' ? 'text-emerald-400' : 'text-slate-500',
  ]
}
