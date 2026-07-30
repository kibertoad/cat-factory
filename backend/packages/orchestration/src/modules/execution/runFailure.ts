import {
  DomainError,
  getErrorMessage,
  getErrorReason,
  type AgentFailureKind,
} from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'

/**
 * Everything a driver records for ONE terminal run failure.
 *
 * This exists as a value — rather than four positional arguments each driver assembles itself —
 * because the two durable drivers (the runtime-neutral `driveExecution` and the Cloudflare
 * `ExecutionWorkflow`) diverged exactly here: the Worker's local `failRun` helper simply had no
 * `reason` parameter, so on the DEPLOYED runtime every failure recorded `reason: null` and the
 * SPA's `AgentFailureCard` remedies (the "Connect GitHub" jump, the deploy-runner hint) could
 * never fire. Threading the missing parameter closed that hole; a shared shape closes the CLASS
 * of hole, by making an omitted field a typecheck failure rather than a silent one-runtime gap
 * (observability-logging-gaps.md, B3).
 *
 * The positional form's specific hazard was that every parameter carried a default, so a call
 * site that stopped short simply got `null` — which is indistinguishable from a genuine "no
 * reason to report" and is why the original divergence survived review.
 */
export interface RunFailure {
  message: string
  kind: AgentFailureKind
  /** Extended diagnostic (a container post-mortem, a companion's raw reply), when there is one. */
  detail: string | null
  /**
   * Machine-readable cause code the SPA maps to precise guidance, instead of string-matching
   * the prose. Read off a thrown `DomainError`'s `details.reason`, or carried on the settled
   * result by an inline gate that already knows it.
   */
  reason: string | null
}

/**
 * The failure to record when `advanceInstance` THREW (its retries are spent).
 *
 * A `DomainError` raised deep in the engine — a `ConflictError` naming
 * `agent_backend_unconfigured`, a `ValidationError` naming `deploy_runner_unwired` — already
 * carries the cause code; without lifting it here the run's failure keeps only the prose and
 * the client is left to pattern-match it.
 *
 * It also fixes the KIND, and for the same reason `classifyDispatchFailure` does: a `DomainError`
 * out of the engine is a PRECONDITION the run never satisfied (no connected repo, an attached
 * document the platform could not open), so nothing ever reached an agent. Recording it as
 * `agent` reads as "the agent failed" and sends a reader looking for a transcript that does not
 * exist. The two seams classify throws from the same engine at different depths — inside
 * `startJob` vs. out of `advanceInstance` — so they have to agree on the taxonomy, or which one
 * happens to catch a refusal decides how the board describes it.
 */
export function failureFromAdvanceError(error: unknown): RunFailure {
  return {
    message: getErrorMessage(error),
    kind: error instanceof DomainError ? 'preflight' : 'agent',
    detail: null,
    reason: getErrorReason(error) ?? null,
  }
}

/**
 * The failure to record for a settled terminal result. An inline gate that already knows the
 * precise classification carries it on the result (`failureKind`/`detail`/`reason`) — e.g. an
 * unparseable companion verdict as `companion_rejected` with its raw reply as detail — so the
 * run records that instead of the generic container-failure framing.
 *
 * An eviction is always `evicted`, and its `detail` is the transport's container post-mortem:
 * the container is already reclaimed, so that is the only surviving account of why it died.
 */
export function failureFromResult(
  result: Extract<AdvanceResult, { kind: 'job_failed' | 'job_evicted' }>,
): RunFailure {
  if (result.kind === 'job_evicted') {
    return { message: result.error, kind: 'evicted', detail: result.detail ?? null, reason: null }
  }
  return {
    message: result.error,
    kind: result.failureKind ?? 'job_failed',
    detail: result.detail ?? null,
    reason: result.reason ?? null,
  }
}

/** A driver-minted failure (a spent poll budget, an unreadable status) with no error to read. */
export function failureFromDriver(message: string, kind: AgentFailureKind): RunFailure {
  return { message, kind, detail: null, reason: null }
}
