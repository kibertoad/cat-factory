// ---------------------------------------------------------------------------
// Numeric env-var parsing with a boot-time warning for un-parseable values.
//
// Numeric knobs are read as `num(env.SOME_VAR) ?? default`. The bare parse silently
// returns `undefined` for a garbage value (`JOB_MAX_POLLS=abc`, a stray unit like
// `30s`, a trailing comma), so the caller's `?? default` swallows the typo with NO
// signal — the operator sees the built-in default silently in effect and no clue their
// override was ignored (error-message coverage A8).
//
// `parseNumericEnv` closes that gap: an unset/blank var still returns `undefined` with
// no noise (falling back to the default is the intended behaviour there), but a PRESENT
// value that is not a finite number emits one structured warning naming the var and the
// rejected value before returning `undefined`. The caller keeps its own `?? default`, so
// this only reports the rejection — it never changes the resolved value. "One warning"
// is per PROCESS rather than per call (`warnOnce.ts`), because the Worker re-derives the
// config on every invocation and a standing typo would otherwise log on each one.
//
// Both facades share the same footgun (Node `config.ts` `num()` + the Worker's
// `infrastructure/config/utils.ts` `num()`), so the message lives here in the shared
// server layer and each facade's `num` delegates to it — the warning reads identically
// across runtimes, per "keep the runtimes symmetric".
// ---------------------------------------------------------------------------

import { DOCS } from './docs.js'
import { configWarnings } from './warnOnce.js'

/**
 * The single-line operator warning for a numeric env var set to a non-numeric value.
 * Pure (no logging) so it can be unit-tested and so the log fields + message stay in one
 * place. Greppable: names the var, quotes the rejected value, and states the consequence
 * (the built-in default is used instead).
 */
export function describeRejectedNumericEnv(name: string, value: string): string {
  return (
    `${name} is set to "${value}", which is not a number — ignoring it and using the ` +
    `built-in default. Set ${name} to a numeric value or unset it. See ${DOCS.envVars()}.`
  )
}

/**
 * Parse a numeric env var, warning when a value is PRESENT but not a finite number.
 * Returns `undefined` for an unset/blank var (no warning) or a rejected value (one
 * warning), so the caller's `?? default` still supplies the fallback.
 */
export function parseNumericEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  if (Number.isFinite(n)) return n
  // Once per process, not once per read: the Worker re-derives the whole config on every
  // invocation, so an unconditional warn here is one line per request (see `warnOnce.ts`).
  configWarnings.warnOnce(describeRejectedNumericEnv(name, value), {
    var: name,
    value,
    docsUrl: DOCS.envVars(),
  })
  return undefined
}

/**
 * The largest delay `setTimeout` can actually hold. Past this the delay does NOT saturate — Node
 * truncates it to a 32-bit signed int, warns `TimeoutOverflowWarning`, and substitutes **1ms**, so
 * the timer fires on the next tick. For a watchdog that inverts the operator's intent completely:
 * the value someone types to mean "effectively no limit" is the one that kills every run at once.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * A timer budget read from the environment: the milliseconds, or WHY the value is unusable.
 *
 * Rejection carries the finished operator message rather than a code, so the one classification
 * lives with the one wording — a caller reports it through whatever seam it has (a `logger`, an
 * injected `onWarn`) without re-deriving which rule the value broke.
 */
export type TimerEnvParse = { readonly ms: number } | { readonly rejected: string }

/**
 * Parse an env var that becomes a `setTimeout` delay, into a whole positive number of milliseconds
 * {@link MAX_TIMER_DELAY_MS} or below.
 *
 * Deliberately STRICTER than {@link parseNumericEnv}, which accepts any finite number and is right
 * to: as a count or a ratio, `0` / `-1` / `1.5` are ordinary values. As a timer delay every one of
 * them is worse than the typo it came from — a non-positive delay fires on the next tick, a
 * fractional one rounds, and an over-large one is truncated to 1ms (see {@link MAX_TIMER_DELAY_MS}).
 * All four spellings therefore share one outcome: report it and let the caller's default stand,
 * rather than arming a watchdog that fires immediately on a deployment-wide basis.
 *
 * An unset or blank value is the CALLER's to interpret (it means "inherit the default", which is
 * not a rejection), so this takes a value it can assume is present.
 */
export function parseTimerEnvMs(name: string, value: string, fallbackMs: number): TimerEnvParse {
  const trimmed = value.trim()
  const n = Number(trimmed)
  if (Number.isInteger(n) && n > 0 && n <= MAX_TIMER_DELAY_MS) return { ms: n }
  // `Number.isInteger` already excludes NaN and both infinities, so the only way past the first
  // clause with an integer in hand is a genuinely over-large one.
  const fault = Number.isInteger(n)
    ? n <= 0
      ? 'must be greater than zero (a zero or negative delay fires immediately)'
      : `exceeds the ${MAX_TIMER_DELAY_MS}ms a timer can hold, which would truncate it to 1ms ` +
        'and fire immediately'
    : 'is not a whole number of milliseconds'
  return {
    rejected:
      `${name}="${value}" ${fault} — using the default ${fallbackMs}ms. ` +
      `See ${DOCS.envVars()}.`,
  }
}
