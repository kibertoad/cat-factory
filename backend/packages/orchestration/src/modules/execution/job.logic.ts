import type { AgentFailureKind } from '@cat-factory/kernel'
import { DispatchError, DomainError, getErrorMessage } from '@cat-factory/kernel'

/**
 * Maximum number of times a step's *crash* eviction (OOM / a genuine crash) is
 * recovered automatically by re-dispatching a fresh container for the same step.
 * Set to 1: one blip is recovered silently; a second crash of the same step is
 * treated as deterministic and fails the run (`evicted`). Evictions a runtime flags
 * as transient infra churn get their own, larger budget — see
 * {@link MAX_TRANSIENT_EVICTION_RECOVERIES}.
 */
export const MAX_EVICTION_RECOVERIES = 1

/**
 * Recovery budget for evictions a runtime flags as *transient infrastructure churn*
 * (see {@link isTransientEviction}) rather than a crash. Larger than
 * {@link MAX_EVICTION_RECOVERIES} because such churn can recur several times in a
 * short window (e.g. a deploy that drains the sandbox repeatedly). Each recovery
 * re-dispatches a fresh container, naturally spaced by the job poll interval, so a
 * bounded handful rides out the window instead of deterministically failing a
 * healthy run. The engine stays runtime-neutral: which infra events count as
 * transient is the facade's call — it opts in by tagging the eviction with
 * {@link TRANSIENT_EVICTION_MARKER} (Cloudflare maps a new-version rollout / exit
 * 143 to it; another runtime might map a node drain or a placement move).
 */
export const MAX_TRANSIENT_EVICTION_RECOVERIES = 5

/**
 * Neutral marker a runtime facade appends to an eviction error to declare it
 * transient infrastructure churn (recover leniently), not a crash. Kept generic on
 * purpose: the engine knows only "transient vs crash"; the facade owns the mapping
 * from its own signal (a Cloudflare rollout, a node drain, …) to this marker. The
 * tagged string still contains "evicted or crashed" so {@link isContainerEvictionError}
 * also matches and the shared recovery machinery engages.
 */
export const TRANSIENT_EVICTION_MARKER = 'transient infrastructure eviction'

/**
 * Whether a failed job poll is a *container eviction/crash* (the per-run container
 * vanished and its in-memory job registry is gone) rather than a genuine agent
 * failure. The Cloudflare transport maps a 404 job poll to a failed view whose
 * message ends `(container evicted or crashed)`; the worker bootstrap flow
 * classifies the identical string. Matching it here lets the execution engine
 * recover a transient eviction by spinning a fresh container instead of failing
 * the whole run on the first blip. Covers transient-tagged evictions too (their
 * message also contains this phrase) — {@link isTransientEviction} sub-classifies them.
 */
export function isContainerEvictionError(error: string | undefined): boolean {
  return error !== undefined && /evicted or crashed/i.test(error)
}

/** How a throw from an async agent dispatch (`startJob`) is framed as a terminal run failure. */
export interface DispatchFailureClassification {
  /** Human-readable top-line message for the run failure. */
  error: string
  /** Coarse failure classification the board renders + hints from. */
  failureKind: AgentFailureKind
  /** Extended detail (the verbatim thrown message). */
  detail: string
  /** Machine-readable cause code, when the throw carried one (a {@link DomainError}'s `reason`). */
  reason?: string
}

/**
 * Classify a throw from an async agent dispatch (`startJob`) into a terminal failure. The
 * dispatch catch used to assume EVERY throw was the container failing to accept the job, but a
 * job is also built (auth, repo target, context) BEFORE any container is contacted — so a
 * precondition can reject it up front. Three cases, most-specific first:
 *
 *  - A domain PRECONDITION error (any {@link DomainError}, e.g. the `github_not_connected`
 *    `ConflictError` raised while building the job because the workspace has no connected repo)
 *    was rejected before dispatch. That is a `preflight` failure, not a container `dispatch`
 *    blip: surface its own actionable message and propagate its machine-readable `reason` so
 *    the SPA renders precise guidance ("GitHub not connected") instead of the misleading
 *    "container failed to start".
 *  - A container eviction/crash routes to `evicted` (a fresh-container retry may help).
 *  - A structured {@link DispatchError} from a transport `dispatch()` routes to `dispatch` and
 *    surfaces its already-elaborated message verbatim (the raw status line + any 404 stale-image
 *    remedy), rather than the generic "failed to start" framing.
 *  - Anything else is a genuine container accept failure (`dispatch`): the container/runner
 *    never accepted the job (an HTTP/network error, a capacity blip).
 */
export function classifyDispatchFailure(error: unknown): DispatchFailureClassification {
  const message = getErrorMessage(error)
  if (error instanceof DomainError) {
    const reason = error.details?.reason
    return {
      error: message,
      failureKind: 'preflight',
      detail: message,
      reason: typeof reason === 'string' ? reason : undefined,
    }
  }
  if (isContainerEvictionError(message)) {
    return { error: message, failureKind: 'evicted', detail: message }
  }
  if (error instanceof DispatchError) {
    return { error: message, failureKind: 'dispatch', detail: message }
  }
  return { error: 'The container failed to start.', failureKind: 'dispatch', detail: message }
}

/**
 * Whether a container eviction was flagged by the runtime facade as *transient
 * infrastructure churn* (the facade tagged it with {@link TRANSIENT_EVICTION_MARKER})
 * rather than a crash/OOM. Transient evictions recover on the larger
 * {@link MAX_TRANSIENT_EVICTION_RECOVERIES} budget. This is intentionally agnostic to
 * what the underlying event was: the facade decides (Cloudflare, for instance, maps a
 * new-version rollout to it after asking the container Durable Object).
 */
export function isTransientEviction(error: string | undefined): boolean {
  return error !== undefined && error.includes(TRANSIENT_EVICTION_MARKER)
}

/**
 * Map the harness's STRUCTURED failure cause (the `failureCause` it now reports on a failed
 * job view) onto the engine's {@link AgentFailureKind}, so a non-eviction agent failure is
 * classified WITHOUT regex-matching the free-text error. The watchdog timeouts become
 * `timeout` (matching what the old `/inactivity|no agent activity|max duration/` regex
 * produced); every other harness cause (a genuine agent error, a no-usable-output / no-changes
 * result, a git/api failure) is an `agent` failure. Returns undefined for an unknown/absent
 * cause so the caller falls back to its error-string regex (older harness image). Container
 * eviction is intentionally NOT a harness cause — it is detected from the error string by
 * {@link isContainerEvictionError} (the runtime facade emits it), so it never routes here.
 */
export function agentFailureKindFromCause(cause: string | undefined): AgentFailureKind | undefined {
  switch (cause) {
    case 'inactivity-timeout':
    case 'max-duration':
      return 'timeout'
    case 'agent':
    case 'git':
    case 'api':
    case 'no-usable-output':
    case 'no-changes':
      return 'agent'
    default:
      return undefined
  }
}

/**
 * The error-string fallback for an agent/execution job failure when the harness reported no
 * structured `failureCause` (an older image, or a pool transport that doesn't forward it). Mirrors
 * the bootstrap path's `classifyBootstrapFailure`: the watchdog phrases map to `timeout`, anything
 * else to `agent` — so the SAME watchdog text classifies identically on both the execution and
 * bootstrap paths. Container eviction is handled separately (by {@link isContainerEvictionError}),
 * so it never reaches here. Used as `agentFailureKindFromCause(cause) ?? classifyAgentFailure(error)`.
 */
export function classifyAgentFailure(error: string | undefined): AgentFailureKind {
  if (error && /inactivity|no agent activity|max duration/i.test(error)) return 'timeout'
  return 'agent'
}
