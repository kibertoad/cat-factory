import { getErrorMessage, getErrorReason, type AgentFailureKind } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'

/**
 * Everything `failRun` records for ONE terminal run failure.
 *
 * This exists as a value — rather than four positional arguments each driver assembles
 * itself — because the two drivers (the runtime-neutral `driveExecution` and the
 * Cloudflare `ExecutionWorkflow`) diverged exactly here: the Worker's local `failRun`
 * helper simply had no `reason` parameter, so on the DEPLOYED runtime every failure
 * recorded `reason: null` and the SPA's `AgentFailureCard` remedies (the "Connect GitHub"
 * jump, the deploy-runner hint) could never fire. A shared shape makes an omitted field a
 * typecheck failure instead of a silent one-runtime hole (observability-logging-gaps.md, B3).
 */
export interface RunFailure {
  message: string
  kind: AgentFailureKind
  /** Extended diagnostic (a container post-mortem, a companion's raw reply), when there is one. */
  detail: string | null
  /**
   * Machine-readable cause code the SPA maps to precise guidance, instead of string-matching
   * the prose. Read off a thrown {@link DomainError}'s `details.reason`, or carried on the
   * settled result by an inline gate that already knows it.
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
 */
export function failureFromAdvanceError(error: unknown): RunFailure {
  return {
    message: getErrorMessage(error),
    kind: 'agent',
    detail: null,
    reason: getErrorReason(error) ?? null,
  }
}

/**
 * The failure to record for a settled terminal result. An inline gate that already knows the
 * precise classification carries it on the result (`failureKind`/`detail`/`reason`) — e.g. an
 * unparseable companion verdict as `companion_rejected` with its raw reply as detail — so the
 * run records that instead of the generic container-failure framing.
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
