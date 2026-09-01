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
  /**
   * The provider's own account of a state it has not left yet, when it gave one. It is the only
   * channel that survives a `provisioning` poll, because `lastError` is persisted on `failed`
   * alone (see `ProvisionedEnvironment.statusNote`). It is what lets a `timed_out` verdict name
   * the state the environment was stuck in rather than only how long it was stuck.
   */
  statusNote?: string | null
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
 * How an environment that has stopped at a status it will never leave for `ready` is explained to
 * a person: `failed` / `expired` / `tearing_down` / `torn_down`. Shared, because every reader that
 * has to give up on such an environment owes the same account, and the two that stated it
 * separately disagreed about it.
 *
 * The provider's own error is the whole message where it recorded one, because on these statuses
 * that error IS the verdict. With none, the state is NAMED and the last note is APPENDED rather
 * than substituted, and both halves of that matter. Naming the state is what separates "the
 * provider refused it" from "something tore it down under the run", which send an operator to
 * different places. Appending rather than substituting is because a bare note reads as the reason
 * the environment ended up here, which nothing here knows: a `torn_down` row's note describes the
 * spin-up it was in the middle of, not who tore it down.
 */
export function describeTerminalEnvironment(env: EnvironmentReadinessInput): string {
  const failure = env.lastError?.trim()
  if (failure) return failure
  const note = env.statusNote?.trim()
  return (
    `Environment provisioning did not complete (status: ${env.status}).` +
    (note ? ` Last provider note: ${note}` : '')
  )
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
  const failure = env.lastError?.trim()
  const note = env.statusNote?.trim()
  // `failed` / `expired` / `tearing_down` / `torn_down`: none of these becomes `ready` on its own,
  // so waiting out the deadline would only delay the same answer.
  if (env.status !== 'provisioning') {
    return { kind: 'failed', error: describeTerminalEnvironment(env) }
  }
  if (waitedMs >= timeoutMs) {
    return {
      kind: 'timed_out',
      error:
        `Environment was still provisioning after ${describeWaitedFor(waitedMs)}` +
        ` (readiness ceiling ${describeWaitedFor(timeoutMs)}).` +
        // BOTH, where a caller carries both, each under its own label and the fault FIRST. A
        // recorded fault outranks a note on every reader (it is the more specific claim, and the
        // only one of the two that is a fault), and dropping either would be the misattribution
        // this pair exists to avoid: the note is the one channel a `provisioning` provider had,
        // since that is exactly the status `lastError` is nulled on, so a caller reaching here
        // with a fault as well carries it from an earlier poll and it is not superseded.
        (failure ? ` Last provider error: ${failure}` : '') +
        (note ? ` Last provider note: ${note}` : ''),
    }
  }
  return { kind: 'waiting', elapsedMs: waitedMs }
}
