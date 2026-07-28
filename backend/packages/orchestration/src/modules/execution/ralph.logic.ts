import type {
  AgentConfigValues,
  RalphAttempt,
  RalphStepState,
  RalphVerdict,
} from '@cat-factory/kernel'
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

/**
 * How many consecutive FAILING iterations against an UNCHANGED work-branch HEAD end the loop
 * early. The iteration budget alone is a poor runaway guard: a loop whose agent commits nothing
 * is provably not converging, and every further pass costs a full model run to re-learn that.
 * Two is the smallest value that can distinguish a stall from a single unlucky pass — one
 * no-commit iteration happens (a pass that only investigated), two in a row does not.
 */
export const RALPH_NO_PROGRESS_LIMIT = 2

/**
 * How many iterations the step's inspectable {@link RalphStepState.attemptLog} keeps. The loop
 * state rides the run's `detail` JSON blob, which is re-serialized on EVERY step-progress write,
 * so an uncapped log of up to {@link MAX_RALPH_ITERATIONS_CAP} entries (each carrying an output
 * tail and the iteration's prose summary) would bloat every write for the rest of the loop's
 * life — the same reason the run's failure and output trails are capped. The newest iterations
 * are the ones worth reading; what the cap drops is COUNTED, never silently discarded.
 */
export const MAX_RALPH_ATTEMPT_LOG = 20

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
 * Re-seed a ralph step's loop state for a RE-RUN (a retry, a restart-from-step, or a loop-back),
 * keeping the config frozen at run start — the completion command, the budget, the progress-log
 * path — while zeroing everything the previous attempt accumulated.
 *
 * Both halves matter and neither used to happen. A rebuild-from-scratch reset (the retry path)
 * DROPPED the state entirely, and a ralph step with no `ralph` state dispatches with no
 * validation block at all: the harness then runs a plain coding pass, returns no verdict, and
 * the loop interceptor never fires — the step silently completes as an ungated one-shot coder.
 * A preserve-everything reset (the loop-back path) kept `attempts` at the spent budget, so the
 * very first verdict of the re-run went straight to `exhausted`. Re-seeding from the step's own
 * frozen config is the one answer that is right for both, and needs no re-read of the block.
 *
 * Returns undefined for a step that carries no ralph state (every non-ralph kind), so callers
 * can spread it unconditionally.
 */
export function restartRalphState(
  ralph: RalphStepState | null | undefined,
): RalphStepState | undefined {
  if (!ralph) return undefined
  return {
    phase: 'iterating',
    attempts: 0,
    maxIterations: ralph.maxIterations,
    validationCommand: ralph.validationCommand,
    progressPath: ralph.progressPath ?? RALPH_PROGRESS_PATH,
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

/**
 * The no-progress streak a just-finished iteration leaves behind: how many consecutive failing
 * iterations have now run against an unchanged work-branch HEAD.
 *
 * FAILS OPEN by design. A verdict with no `headSha` — a self-hosted runner pool on an older
 * harness image, or a pass whose head could not be read — resets the streak rather than
 * extending it: the cost of a missed stall is a few wasted iterations the budget still bounds,
 * while the cost of a false stall is killing a loop that was making progress the whole time.
 */
export function nextNoProgressStreak(
  ralph: RalphStepState,
  verdict: RalphVerdict | null,
  previousHeadSha: string | null | undefined,
): number {
  if (verdict?.validationPassed) return 0
  const head = verdict?.headSha?.trim()
  if (!head || !previousHeadSha || head !== previousHeadSha) return 0
  return (ralph.noProgressStreak ?? 0) + 1
}

/** The work-branch HEAD the most recent RECORDED iteration ran against, if it reported one. */
export function lastRecordedHeadSha(ralph: RalphStepState): string | null {
  return ralph.attemptLog?.at(-1)?.headSha?.trim() || null
}

/** The engine's decision after one ralph iteration's verdict is recorded. */
export type RalphDecision = 'done' | 'retry' | 'exhausted' | 'stalled'

/**
 * Decide the loop's next move from the step state (AFTER the just-finished iteration has been
 * counted into `attempts` and its no-progress streak folded in) and its verdict: the criterion
 * passed ⇒ `done`; the loop has stopped making progress ⇒ `stalled`; else another iteration
 * remains within the budget ⇒ `retry`; else the budget is spent ⇒ `exhausted`.
 *
 * `stalled` is checked BEFORE the budget so a stuck loop reports why it actually stopped. The
 * two outcomes are terminal in the same way but mean different things to the human reading the
 * notification: "the budget was not enough" invites raising it, "nothing changed for two
 * iterations" says raising it will not help.
 */
export function decideRalphNext(
  ralph: RalphStepState,
  verdict: RalphVerdict | null,
): RalphDecision {
  if (verdict?.validationPassed) return 'done'
  if ((ralph.noProgressStreak ?? 0) >= RALPH_NO_PROGRESS_LIMIT) return 'stalled'
  return ralph.attempts < ralph.maxIterations ? 'retry' : 'exhausted'
}

/**
 * Append a finished iteration to the step's capped history, returning the new log plus how many
 * entries have now been dropped in total. Pure so the cap (and its accounting) is asserted
 * without the controller's ports.
 */
export function appendRalphAttempt(
  ralph: RalphStepState,
  entry: RalphAttempt,
): { attemptLog: RalphAttempt[]; droppedAttempts: number } {
  const appended = [...(ralph.attemptLog ?? []), entry]
  const overflow = Math.max(appended.length - MAX_RALPH_ATTEMPT_LOG, 0)
  return {
    attemptLog: overflow > 0 ? appended.slice(overflow) : appended,
    droppedAttempts: (ralph.droppedAttempts ?? 0) + overflow,
  }
}

/** One-line, human-readable summary of a verdict for notifications / failure messages. */
export function describeRalphVerdict(verdict: RalphVerdict | null): string {
  if (!verdict) return 'the validation run produced no verdict'
  if (verdict.validationPassed) return 'the validation command passed'
  const tail = verdict.validationOutputTail?.trim()
  const head = `the validation command failed (exit ${verdict.exitCode})`
  return tail ? `${head}:\n${tail}` : head
}
