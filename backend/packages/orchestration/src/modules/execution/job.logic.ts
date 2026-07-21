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
 * (the transport mints `RunnerJobView.evicted = 'transient'`) rather than a crash. Larger
 * than {@link MAX_EVICTION_RECOVERIES} because such churn can recur several times in a
 * short window (e.g. a deploy that drains the sandbox repeatedly). Each recovery
 * re-dispatches a fresh container, naturally spaced by the job poll interval, so a
 * bounded handful rides out the window instead of deterministically failing a
 * healthy run. The engine stays runtime-neutral: which infra events count as
 * transient is the facade's call — it opts in by minting `evicted: 'transient'`
 * (Cloudflare maps a new-version rollout / exit 143 to it; another runtime might map a
 * node drain or a placement move).
 */
export const MAX_TRANSIENT_EVICTION_RECOVERIES = 5

/**
 * Whether a thrown DISPATCH-time error is a *container eviction/crash* (the container
 * vanished before it accepted the job) rather than a genuine dispatch fault. Some transports
 * have no job view at dispatch time (the Kubernetes `waitForPodReady` wait, the inline-job
 * path), so a dispatch-time eviction can only surface as a thrown Error whose message ends
 * `(container evicted or crashed)`; matching it here routes such a throw to a fresh-container
 * retry rather than failing the run on the first blip.
 *
 * POLL-time eviction is NOT string-matched — it rides the structured
 * {@link import('@cat-factory/kernel').ContainerEvictionKind | RunnerJobView.evicted} field
 * (set by every transport), which the recovery paths read directly. This check is the only
 * remaining eviction string test, kept because the dispatch-time throw carries no view (the
 * typed dispatch-eviction error is a separate follow-up).
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
 * What the step had already accomplished when the dispatch threw — the "run history" the
 * classifier needs to tell a fresh-start failure apart from a container lost AFTER work had
 * begun (ADR 0026 D1). Populated from the step at the throw site; every field is optional so
 * the first-dispatch path (no history) passes nothing and gets the classic framing.
 */
export interface DispatchFailureContext {
  /**
   * Automatic crash-eviction recoveries already spent on this step. `> 0` means the step
   * reached the agent phase, lost its container to an eviction, and this throw is the FAILED
   * recovery re-dispatch — not a container that never started. This is the primary "work had
   * begun" signal (the recovery path increments it before re-dispatching).
   */
  evictionRecoveries?: number
  /** Transient-churn recoveries already spent — same "work had begun" signal as above. */
  transientEvictionRecoveries?: number
  /** Epoch ms the step first began executing, to render "after N minutes of work". */
  startedAt?: number | null
  /** Slices the reviewer had already grouped the diff into (partial progress), if any. */
  sliceCount?: number
  /** Injected `now` (epoch ms) for deterministic tests; defaults to `Date.now()`. */
  now?: number
}

/** Whole minutes of work between `startedAt` and now, or null when it can't be computed / is <1. */
function elapsedWorkMinutes(context: DispatchFailureContext): number | null {
  if (context.startedAt == null) return null
  const now = context.now ?? Date.now()
  const minutes = Math.floor((now - context.startedAt) / 60_000)
  return minutes >= 1 ? minutes : null
}

/**
 * The honest terminal message for a container lost to an eviction AFTER the step had done work
 * (see {@link classifyDispatchFailure}'s catch-all). Reads as "evicted mid-work, unrecoverable"
 * rather than "never started", and folds in the elapsed minutes + any partial slice count so the
 * board and PR-review window can render "work was in progress".
 */
function evictionAfterWorkMessage(context: DispatchFailureContext): string {
  const minutes = elapsedWorkMinutes(context)
  const when =
    minutes != null
      ? `after ${minutes} minute${minutes === 1 ? '' : 's'} of work`
      : 'after work had begun'
  const slices =
    context.sliceCount && context.sliceCount > 0
      ? ` (${context.sliceCount} slice${context.sliceCount === 1 ? '' : 's'} reviewed)`
      : ''
  return `The container was evicted ${when}${slices} and could not be recovered.`
}

/**
 * Classify a throw from an async agent dispatch (`startJob`) into a terminal failure. The
 * dispatch catch used to assume EVERY throw was the container failing to accept the job, but a
 * job is also built (auth, repo target, context) BEFORE any container is contacted — so a
 * precondition can reject it up front. Cases, most-specific first:
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
 *  - A generic throw on a step that had ALREADY begun work (`context.evictionRecoveries > 0` —
 *    the failed recovery re-dispatch of a container that reached the agent phase and was then
 *    evicted) is framed as `evicted` with an eviction-after-work message, NOT the misleading
 *    "container failed to start" (which reads as "never started"). See ADR 0026 D1.
 *  - Anything else is a genuine container accept failure (`dispatch`): the container/runner
 *    never accepted the job (an HTTP/network error, a capacity blip) before any work happened.
 */
export function classifyDispatchFailure(
  error: unknown,
  context: DispatchFailureContext = {},
): DispatchFailureClassification {
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
  // The step had already reached the agent phase and lost a container to an eviction (the
  // recovery path bumped the recovery count before this re-dispatch): the run DID work, so
  // report an unrecoverable eviction rather than a fresh-start failure. The verbatim throw
  // stays on `detail` for the post-mortem.
  const recoveries = (context.evictionRecoveries ?? 0) + (context.transientEvictionRecoveries ?? 0)
  if (recoveries > 0) {
    return { error: evictionAfterWorkMessage(context), failureKind: 'evicted', detail: message }
  }
  return { error: 'The container failed to start.', failureKind: 'dispatch', detail: message }
}
