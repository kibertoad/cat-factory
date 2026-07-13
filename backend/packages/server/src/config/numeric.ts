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
// this only reports the rejection — it never changes the resolved value.
//
// Both facades share the same footgun (Node `config.ts` `num()` + the Worker's
// `infrastructure/config/utils.ts` `num()`), so the message lives here in the shared
// server layer and each facade's `num` delegates to it — the warning reads identically
// across runtimes, per "keep the runtimes symmetric".
// ---------------------------------------------------------------------------

import { logger } from '../observability/logger.js'
import { DOCS } from './docs.js'

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
  logger.warn(
    { var: name, value, docsUrl: DOCS.envVars() },
    describeRejectedNumericEnv(name, value),
  )
  return undefined
}
