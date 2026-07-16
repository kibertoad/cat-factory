import type { AgentConfigValues, RalphStepState, RalphVerdict } from '@cat-factory/kernel'
import {
  RALPH_AGENT_KIND,
  RALPH_DEFAULT_MAX_ITERATIONS,
  RALPH_MAX_ITERATIONS_CONFIG_ID,
  RALPH_VALIDATION_COMMAND_CONFIG_ID,
} from '@cat-factory/agents'

// Pure logic + constants for the "Ralph loop" step — a persistent, retry-until-done coding
// loop whose exit condition is a programmatic validation command run by the harness. Kept
// side-effect-free (no engine I/O) so it is unit- and conformance-testable in isolation; the
// stateful driving lives in `RalphController` + `RunDispatcher`.

// Re-exported so in-package sites source the kind id here (agents stays the single source).
export { RALPH_AGENT_KIND }

/** Default repo-relative path of the append-only progress log the ralph agent maintains. */
export const RALPH_PROGRESS_PATH = '.cat-factory/ralph-progress.md'

/**
 * Hard ceiling on the per-task iteration budget, so a fat-fingered config value can't make the
 * loop spin (near-)forever. Well above any sane hand-set budget; the default is much smaller.
 */
export const MAX_RALPH_ITERATIONS_CAP = 50

/** Whether a step's kind is the ralph-loop kind. */
export function isRalphKind(kind: string): boolean {
  return kind === RALPH_AGENT_KIND
}

/** A block's resolved ralph config: the completion command + the iteration budget. */
export interface RalphConfig {
  /** The programmatic completion criterion (empty when the task set none — the engine errors). */
  validationCommand: string
  /** The anti-runaway iteration budget (clamped to [1, {@link MAX_RALPH_ITERATIONS_CAP}]). */
  maxIterations: number
}

/**
 * Resolve a ralph step's per-task config from the block's agent-config values: the validation
 * command (the completion criterion) and the iteration budget (clamped, defaulting to
 * {@link RALPH_DEFAULT_MAX_ITERATIONS}). The command may resolve empty when the task pinned
 * none — the engine treats that as a misconfiguration and fails the step with a clear message
 * (a ralph loop is meaningless without a programmatic criterion).
 */
export function resolveRalphConfig(agentConfig: AgentConfigValues | undefined): RalphConfig {
  const validationCommand = (agentConfig?.[RALPH_VALIDATION_COMMAND_CONFIG_ID] ?? '').trim()
  const raw = Number(agentConfig?.[RALPH_MAX_ITERATIONS_CONFIG_ID])
  const maxIterations =
    Number.isFinite(raw) && raw >= 1
      ? Math.min(Math.floor(raw), MAX_RALPH_ITERATIONS_CAP)
      : RALPH_DEFAULT_MAX_ITERATIONS
  return { validationCommand, maxIterations }
}

/** Seed a fresh ralph step state from a resolved config (attempts start at 0, no history). */
export function seedRalphState(config: RalphConfig): RalphStepState {
  return {
    phase: 'iterating',
    attempts: 0,
    maxIterations: config.maxIterations,
    validationCommand: config.validationCommand,
    progressPath: RALPH_PROGRESS_PATH,
    attemptLog: [],
  }
}

/**
 * Fold a ralph step's state into the container context's `ralphValidation` block: the command
 * the harness runs, the progress-log path, and the 1-based iteration number about to run
 * (`attempts + 1`). Returns undefined when the step carries no ralph state or an empty command
 * (a misconfigured step must not dispatch a validation-less run — the engine fails it instead).
 */
export function buildRalphValidation(
  ralph: RalphStepState | null | undefined,
): { command: string; progressPath: string; iteration: number } | undefined {
  if (!ralph || !ralph.validationCommand.trim()) return undefined
  return {
    command: ralph.validationCommand,
    progressPath: ralph.progressPath ?? RALPH_PROGRESS_PATH,
    iteration: ralph.attempts + 1,
  }
}

/** The engine's decision after one ralph iteration's verdict is recorded. */
export type RalphDecision = 'done' | 'retry' | 'exhausted'

/**
 * Decide the loop's next move from the step state (AFTER the just-finished iteration has been
 * counted into `attempts`) and its verdict: the criterion passed ⇒ `done`; else another
 * iteration remains within the budget ⇒ `retry`; else the budget is spent ⇒ `exhausted`.
 */
export function decideRalphNext(
  ralph: RalphStepState,
  verdict: RalphVerdict | null,
): RalphDecision {
  if (verdict?.validationPassed) return 'done'
  return ralph.attempts < ralph.maxIterations ? 'retry' : 'exhausted'
}

/** One-line, human-readable summary of a verdict for notifications / failure messages. */
export function describeRalphVerdict(verdict: RalphVerdict | null): string {
  if (!verdict) return 'the validation run produced no verdict'
  if (verdict.validationPassed) return 'the validation command passed'
  const tail = verdict.validationOutputTail?.trim()
  const head = `the validation command failed (exit ${verdict.exitCode})`
  return tail ? `${head}:\n${tail}` : head
}
