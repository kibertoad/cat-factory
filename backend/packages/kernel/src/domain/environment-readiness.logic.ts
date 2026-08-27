import type { EnvironmentStatus } from './types.js'

// ---------------------------------------------------------------------------
// Does a provisioned environment exist YET — the one judgement the `deployer` step re-asks
// between driver sleeps while a provider finishes standing an environment up.
//
// It lives here, pure and provider-neutral, because the alternative is the bug it was written
// for: an asynchronous `provision()` answers `provisioning` with no URL (which is what every
// real per-PR environment backend does), and the engine recorded that frame as `ready`. The run
// then handed its tester `URL: (pending)` beside an instruction to test that URL, and nothing
// ever read the provider again. The environment came online while the tester was still running
// and the run never noticed.
//
// The rule this states, once: only the provider saying `ready` is ready. Everything else is
// either still coming (keep waiting, until the deadline) or a state the environment will never
// leave on its own (give up now and say which state it was).
// ---------------------------------------------------------------------------

/**
 * How long a `deployer` step waits for one frame's environment to become `ready` before it
 * records that frame as failed.
 *
 * Sized against real per-PR backends rather than the platform's own round-trips: the run this
 * bound was written for took 5m36s from create to online (a Kargo PREnv whose deploy job alone
 * ran 127s), and a cold cluster pulling images is slower still. It is deliberately generous
 * because the cost of being too short is a failed run on a healthy environment, while the cost
 * of being too long is bounded twice over — by the durable driver's own poll budget, and by the
 * environment's TTL.
 *
 * An engine-side ceiling in the shape of `MAX_EVICTION_RECOVERIES`: one number, stated where the
 * decision is made, rather than a knob every deployment has to discover it needs.
 */
export const ENVIRONMENT_READY_TIMEOUT_MS = 20 * 60 * 1000

/**
 * What a readiness poll decided. `waiting` is the only non-terminal answer; the other three each
 * name a different fix, so they are never collapsed into one "not ready" (see the degrade-loudly
 * rule): `failed` is the provider's own verdict, `timed_out` is ours, and `ready` is the only
 * state a consuming step may be dispatched against.
 */
export type EnvironmentReadiness =
  | { kind: 'ready' }
  | { kind: 'waiting'; elapsedMs: number }
  | { kind: 'failed'; error: string }
  | { kind: 'timed_out'; error: string }

/** The environment facts a readiness verdict is derived from. */
export interface EnvironmentReadinessInput {
  status: EnvironmentStatus
  /** The provider's own last error, when it recorded one; used verbatim in a `failed` verdict. */
  lastError?: string | null
}

/**
 * Human-readable elapsed time for a readiness verdict's message, in the coarsest unit that
 * still states it truthfully — the same reasoning as the driver's `describeCeiling`, so an
 * operator is quoted a duration rather than a millisecond count.
 */
export function describeWaitedFor(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

/**
 * Judge one readiness poll: the environment as the provider just reported it, against how long
 * the step has been waiting.
 *
 * A URL is NOT part of the test. A `ready` environment with no URL is a legitimate outcome — a
 * service that declares no ingress has nothing to publish — and treating it as unready here
 * would fail runs that are fine. What must not happen is a step being told to test an address
 * it was not given, and that is the dispatch guard's job (`assertEnvironmentReachable`), not
 * this one's: readiness is about the environment, reachability about the step consuming it.
 */
export function judgeEnvironmentReadiness(
  env: EnvironmentReadinessInput,
  waitedMs: number,
  timeoutMs: number = ENVIRONMENT_READY_TIMEOUT_MS,
): EnvironmentReadiness {
  if (env.status === 'ready') return { kind: 'ready' }
  if (env.status !== 'provisioning') {
    // `failed` / `expired` / `tearing_down` / `torn_down`: none of these becomes `ready` on its
    // own, so waiting out the deadline would only delay the same answer. Name the state, because
    // "the provider refused it" and "something tore it down under the run" send an operator to
    // different places.
    return {
      kind: 'failed',
      error:
        env.lastError?.trim() ||
        `Environment provisioning did not complete (status: ${env.status}).`,
    }
  }
  if (waitedMs >= timeoutMs) {
    return {
      kind: 'timed_out',
      error:
        `Environment was still provisioning after ${describeWaitedFor(waitedMs)}` +
        ` (readiness ceiling ${describeWaitedFor(timeoutMs)}).` +
        (env.lastError?.trim() ? ` Last provider error: ${env.lastError.trim()}` : ''),
    }
  }
  return { kind: 'waiting', elapsedMs: waitedMs }
}
