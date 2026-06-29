import type { AgentFailureKind } from '@cat-factory/kernel'

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
