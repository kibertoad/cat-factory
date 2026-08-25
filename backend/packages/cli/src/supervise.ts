/**
 * Decision core for `cat-factory supervise` — the self-healing local-dev supervisor.
 *
 * WHY THIS EXISTS. Every local deployment runs its server under `node --watch`, and
 * `node --watch` PARKS on crash: it restarts the entry only on a FILE CHANGE, never on a process
 * exit. A sleeping laptop is the common trigger — on resume the Postgres/Docker connection is
 * gone, the server dies in `migrate`, and the watcher settles at "Waiting for file changes before
 * restarting". The result is the worst kind of failure: the wrapper PID is still alive and the
 * ready banner has already scrolled past, so the stack LOOKS running while nothing is bound to
 * the port, and the SPA reports only a generic "can't reach backend". It never self-heals, and it
 * stays that way until someone notices and restarts by hand.
 *
 * This module is the JUDGEMENT half of the fix, kept pure — no sockets, no processes, no ambient
 * clock — so every transition is unit-testable from a table of observations (`supervise.test.ts`).
 * `supervise-runtime.ts` owns the effects and feeds observations in. That split is the same one
 * `scripts/silent-catch.mjs` documents for itself: a guard whose judgement nothing tests is a
 * guard that is trusted without evidence.
 */

/** Tuning for the supervisor loop. Resolve partial input with {@link resolveSuperviseConfig}. */
export interface SuperviseConfig {
  /** How often the health probe runs. */
  pollMs: number
  /**
   * Grace window after a (re)start during which a failed probe does NOT count against the child.
   * A cold boot builds the workspace dependency and runs migrations first, so the port legitimately
   * stays unbound for a while.
   */
  bootGraceMs: number
  /** Grace window after a detected resume, so a still-waking Docker/Postgres isn't blamed. */
  resumeGraceMs: number
  /**
   * A tick arriving this much later than `pollMs` means time jumped — the host slept (or stalled
   * hard). Timers do not fire while suspended, so lateness is the signal.
   *
   * The measurement is deliberately taken tick-START to tick-START (see {@link step}): sampling it
   * after the probe would fold the probe's own duration into the drift, and a probe that times out
   * on a filtered port takes seconds — enough to read as a suspend on a short `--poll` and so to
   * bypass `failureThreshold` entirely.
   */
  clockJumpMs: number
  /** Consecutive failed probes required before a repair (outside any grace window). */
  failureThreshold: number
  /**
   * How many restarts in a row may fail to produce a SERVING stack before the supervisor reports
   * and gives up. A command that is simply broken (a syntax error, a missing binary, a port already
   * owned by something else) can never be fixed by restarting it, and looping forever on it is the
   * exact pathology this supervisor exists to end — the motivating incident was a container that
   * restarted 518 times, exiting 0 each time, while `docker ps` showed healthy motion.
   */
  maxFailedStarts: number
}

/** Defaults chosen for a laptop-dev loop: notice within ~30s, never fight a cold boot. */
export const SUPERVISE_DEFAULTS = {
  pollMs: 10_000,
  bootGraceMs: 60_000,
  resumeGraceMs: 25_000,
  failureThreshold: 3,
  maxFailedStarts: 5,
} as const

/**
 * Fill in defaults and derive `clockJumpMs` from the poll interval. A tick 3 intervals late is
 * well outside normal scheduler jitter but still catches a short suspend.
 */
export function resolveSuperviseConfig(partial: Partial<SuperviseConfig> = {}): SuperviseConfig {
  const pollMs = partial.pollMs ?? SUPERVISE_DEFAULTS.pollMs
  return {
    pollMs,
    bootGraceMs: partial.bootGraceMs ?? SUPERVISE_DEFAULTS.bootGraceMs,
    resumeGraceMs: partial.resumeGraceMs ?? SUPERVISE_DEFAULTS.resumeGraceMs,
    clockJumpMs: partial.clockJumpMs ?? pollMs * 3,
    failureThreshold: partial.failureThreshold ?? SUPERVISE_DEFAULTS.failureThreshold,
    maxFailedStarts: partial.maxFailedStarts ?? SUPERVISE_DEFAULTS.maxFailedStarts,
  }
}

/** Loop state carried between ticks. Treated as immutable: {@link step} returns the next one. */
export interface SuperviseState {
  /** Consecutive failed probes so far, reset by any success or repair. */
  failures: number
  /** No failed probe counts against the child until this timestamp (boot/resume grace). */
  quietUntil: number
  /** When the previous tick ran — the basis for clock-jump (sleep) detection. */
  lastTickAt: number
  /**
   * When the FIRST failed probe of the current outage was counted; `undefined` whenever the stack
   * is serving. This is what lets a recovery report how long the stack was actually unreachable
   * ({@link SuperviseAction} `recovered.downMs`) instead of only how many probes missed.
   *
   * Deliberately set when a failure is COUNTED, not on any non-serving observation, so a cold boot
   * inside the grace window is not reported as an outage — the port is legitimately unbound while
   * the workspace builds and migrations run. The consequence is that the measured window starts at
   * the first failed probe rather than at the instant the stack went down, so it UNDER-reports by
   * up to one `pollMs`; the log says "since the first failed probe" rather than claiming precision
   * the probe interval cannot deliver.
   */
  notServingSince?: number
}

/** What the runtime should do about this tick. Every branch of {@link step} names one. */
export type SuperviseAction =
  /** Serving, and it was serving before too — nothing to say. */
  | { kind: 'serving' }
  /**
   * Serving again after one or more failed probes, without needing a repair.
   *
   * This is the SELF-HEALED outage, and it is worth saying loudly rather than logging as a plain
   * success: reaching it means the stack stopped answering and came back with no repair of ours in
   * between, so something restarted it underneath the supervisor. On a `node --watch` deployment
   * that is usually a file-change storm — the watcher cycles the server several times in a row, the
   * port is unbound for a few seconds, and any client mid-request fails with `ECONNREFUSED` while
   * every process involved stays alive and the server log shows no crash. Without the duration and
   * the "we did not cause this" framing, the only trace left is two probe-failure lines that read
   * like noise.
   */
  | { kind: 'recovered'; afterFailures: number; downMs: number }
  /** Not serving, but inside a boot/resume grace window — wait it out. */
  | { kind: 'grace'; msLeft: number }
  /** Not serving; failure counted but still below the threshold. */
  | { kind: 'counting'; failures: number; threshold: number }
  /** Run the recovery ladder: re-check dependencies, then restart the child. */
  | { kind: 'repair'; reason: string }
  /** The host resumed from sleep and the stack is still serving. */
  | { kind: 'resumed'; driftMs: number }

/** State for a freshly started child: clean counters and a full boot grace window. */
export function initialState(now: number, config: SuperviseConfig): SuperviseState {
  return { failures: 0, quietUntil: now + config.bootGraceMs, lastTickAt: now }
}

/**
 * State to adopt right after (re)spawning a child mid-run — a fresh boot grace, counters clear.
 *
 * `lastTickAt` is re-based on `now` (the moment the new child started), NOT carried over from the
 * previous tick, because a repair is not instantaneous: it runs the whole dependency ladder first,
 * and those budgets are 90s (compose readiness) and 120s (apiserver readiness) against a default
 * `clockJumpMs` of 30s. Carrying the old timestamp forward makes the very next tick measure the
 * repair's own duration as drift, read a slow-but-successful recovery as a host suspend, and — since
 * resume detection deliberately outranks the boot-grace window — immediately kill the child it just
 * started. Re-basing means the clock-jump signal only ever measures time we were genuinely idle.
 */
export function stateAfterStart(now: number, config: SuperviseConfig): SuperviseState {
  return { failures: 0, quietUntil: now + config.bootGraceMs, lastTickAt: now }
}

/**
 * One tick of the supervisor: current state + what we just observed -> next state + the action to
 * take. Pure; the caller supplies `now` and the probe result.
 *
 * `now` must be sampled at the START of the tick, before the probe runs — see `clockJumpMs`.
 *
 * Order matters:
 *  1. The clock-jump check runs FIRST and outranks the grace windows, because a resume is precisely
 *     when the stack is most likely already dead — deferring it to the normal threshold path would
 *     idle for another `failureThreshold * pollMs` before repairing something we can already tell
 *     is broken.
 *  2. A confirmed-serving stack short-circuits everything below it.
 *  3. A child that has EXITED then repairs immediately, ahead of the grace window and the failure
 *     counter, because neither can tell us anything a dead process handle hasn't already: counting
 *     three more probes against a process that does not exist just adds `failureThreshold * pollMs`
 *     of downtime. This is checked only once the stack is known not to be serving, so a wrapper that
 *     exits while its grandchild keeps serving (a shell that `exec`s away, say) is left alone
 *     rather than having a healthy server restarted out from under it.
 */
export function step(
  state: SuperviseState,
  observation: { now: number; serving: boolean; childExited?: boolean },
  config: SuperviseConfig,
): { state: SuperviseState; action: SuperviseAction } {
  const { now, serving } = observation
  const driftMs = now - state.lastTickAt - config.pollMs

  if (driftMs > config.clockJumpMs) {
    // Timers stalled, so wall-clock time passed without us running: the host suspended. Extend the
    // quiet window either way — a resume needs a moment for Docker's VM and the DB to come back.
    const quietUntil = Math.max(state.quietUntil, now + config.resumeGraceMs)
    if (serving) {
      return {
        state: { failures: 0, quietUntil, lastTickAt: now },
        action: { kind: 'resumed', driftMs },
      }
    }
    return {
      state: {
        failures: 0,
        quietUntil,
        lastTickAt: now,
        notServingSince: state.notServingSince ?? now,
      },
      action: {
        kind: 'repair',
        reason: `not serving after a ${Math.round(driftMs / 1000)}s stall (host slept?)`,
      },
    }
  }

  if (serving) {
    const action: SuperviseAction =
      state.failures > 0
        ? {
            kind: 'recovered',
            afterFailures: state.failures,
            // `notServingSince` is always set by the time a failure has been counted, so the
            // fallback only guards against a hand-built state in a test: report 0 rather than a
            // duration measured from an unrelated clock origin.
            downMs: now - (state.notServingSince ?? now),
          }
        : { kind: 'serving' }
    return { state: { failures: 0, quietUntil: state.quietUntil, lastTickAt: now }, action }
  }

  if (observation.childExited === true) {
    return {
      state: {
        failures: 0,
        quietUntil: state.quietUntil,
        lastTickAt: now,
        notServingSince: state.notServingSince ?? now,
      },
      action: { kind: 'repair', reason: 'the supervised command exited' },
    }
  }

  if (now < state.quietUntil) {
    return {
      state: { ...state, lastTickAt: now },
      action: { kind: 'grace', msLeft: state.quietUntil - now },
    }
  }

  const notServingSince = state.notServingSince ?? now
  const failures = state.failures + 1
  if (failures >= config.failureThreshold) {
    return {
      state: { failures: 0, quietUntil: state.quietUntil, lastTickAt: now, notServingSince },
      action: { kind: 'repair', reason: `${failures} consecutive failed health probes` },
    }
  }
  return {
    state: { failures, quietUntil: state.quietUntil, lastTickAt: now, notServingSince },
    action: { kind: 'counting', failures, threshold: config.failureThreshold },
  }
}
