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
const SUPERVISE_DEFAULTS = {
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
   * the workspace builds and migrations run.
   *
   * BOTH ends of the resulting window are quantized to the poll interval, and the errors point in
   * OPPOSITE directions: the start is the first probe that missed, which is up to one `pollMs`
   * AFTER the stack actually went down, while the end is the probe that saw it again, up to one
   * `pollMs` after it actually came back. So the measurement is the true duration ± one `pollMs`,
   * not a floor — at the default 10s poll a 100ms blip straddling a tick boundary measures a full
   * 10s. A reader must be told the resolution alongside the number, which is why every rendering
   * of it names the poll interval it was measured against.
   */
  notServingSince?: number
  /**
   * Whether the stack has been observed SERVING since the child now running was started.
   *
   * This is what separates the two ways a recovery can be reached, which need opposite reactions
   * (see {@link RecoveryCause}). Required rather than optional: a state literal that forgets it
   * must fail to typecheck, because either default silently misattributes one of the two cases —
   * defaulting to `true` reports our own overrunning boot as an outage nothing explains, and
   * defaulting to `false` suppresses the loud warning a genuine outage exists to raise.
   */
  servedSinceStart: boolean
}

/**
 * Why a stack that was failing probes is answering again. Both reach {@link step}'s `recovered`
 * action, and reporting them the same way is what made the original diagnosis wrong: they are
 * opposite facts about who caused the gap, and they have different remedies.
 */
export type RecoveryCause =
  /**
   * The stack had SERVED since it was started, then stopped, then came back with no repair of ours
   * in between — so something restarted it underneath the supervisor. This is the outage worth
   * shouting about; nothing else records it.
   */
  | 'unexplained'
  /**
   * The stack had NEVER served since the supervisor started it, so nothing cycled underneath us:
   * our own boot simply outlasted `bootGraceMs` and the probes that missed were watching a stack
   * that had not finished coming up. Reported (the grace window is mistuned, and a few more missed
   * probes would have restarted a boot that was about to succeed) but never as an outage.
   */
  | 'slow-start'

/** What the runtime should do about this tick. Every branch of {@link step} names one. */
export type SuperviseAction =
  /** Serving, and it was serving before too — nothing to say. */
  | { kind: 'serving' }
  /**
   * Serving again after one or more failed probes, without needing a repair.
   *
   * `cause` says which of the two very different things just happened, and the caller MUST branch
   * on it rather than treating every recovery as an outage. A `'unexplained'` recovery is the
   * self-healed outage worth saying loudly: the stack stopped answering and came back with nothing
   * of ours in between, so something restarted it underneath the supervisor — on a `node --watch`
   * deployment usually a file-change storm, which cycles the server several times in a row, leaves
   * the port unbound for a few seconds, and kills any client mid-request with `ECONNREFUSED` while
   * every process involved stays alive and the server log shows no crash. Without the duration and
   * the "we did not cause this" framing, the only trace left is two probe-failure lines reading
   * like noise. A `'slow-start'` recovery is the supervisor watching its OWN child finish booting
   * past the grace window, which is a mistuned window rather than an outage.
   */
  | { kind: 'recovered'; afterFailures: number; downMs: number; cause: RecoveryCause }
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
  return {
    failures: 0,
    quietUntil: now + config.bootGraceMs,
    lastTickAt: now,
    servedSinceStart: false,
  }
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
 *
 * `servedSinceStart` restarts at `false` for the same reason it starts there on a cold boot: the
 * child now running has never answered, so probes that miss while it comes up are watching OUR
 * restart finish, not something cycling the stack underneath us.
 */
export function stateAfterStart(now: number, config: SuperviseConfig): SuperviseState {
  return {
    failures: 0,
    quietUntil: now + config.bootGraceMs,
    lastTickAt: now,
    servedSinceStart: false,
  }
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
        state: { failures: 0, quietUntil, lastTickAt: now, servedSinceStart: true },
        action: { kind: 'resumed', driftMs },
      }
    }
    // No outage stamp here, nor on either repair branch below: a `repair` is always followed by a
    // respawn, and `stateAfterStart` replaces this state wholesale the moment the new child exists.
    // Carrying a window forward into it would be state no reader can ever reach.
    return {
      state: { failures: 0, quietUntil, lastTickAt: now, servedSinceStart: state.servedSinceStart },
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
            // The whole distinction: only a stack that had ALREADY answered under this child can
            // have been taken down by something other than us. One that never answered was still
            // booting, and blaming an invisible third party for our own slow start is exactly the
            // misdiagnosis this reporting exists to prevent.
            cause: state.servedSinceStart ? 'unexplained' : 'slow-start',
          }
        : { kind: 'serving' }
    return {
      state: { failures: 0, quietUntil: state.quietUntil, lastTickAt: now, servedSinceStart: true },
      action,
    }
  }

  if (observation.childExited === true) {
    return {
      state: {
        failures: 0,
        quietUntil: state.quietUntil,
        lastTickAt: now,
        servedSinceStart: state.servedSinceStart,
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

  const { quietUntil, servedSinceStart } = state
  const failures = state.failures + 1
  if (failures >= config.failureThreshold) {
    return {
      state: { failures: 0, quietUntil, lastTickAt: now, servedSinceStart },
      action: { kind: 'repair', reason: `${failures} consecutive failed health probes` },
    }
  }
  return {
    state: {
      failures,
      quietUntil,
      lastTickAt: now,
      notServingSince: state.notServingSince ?? now,
      servedSinceStart,
    },
    action: { kind: 'counting', failures, threshold: config.failureThreshold },
  }
}
