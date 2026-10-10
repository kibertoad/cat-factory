// ---------------------------------------------------------------------------
// ONE parser for the duration-STRING knobs both facades read.
//
// `ExecutionConfig` carries four of them (`decisionTimeout`, `jobPollInterval`, `ciPollInterval`,
// `advanceTimeout`), and each is consumed differently per runtime: the Worker hands the string
// straight to Workflows (`step.sleep`, `step.do`'s `timeout`), while Node has to turn it into
// milliseconds for a `setTimeout`. Two consumers meant two readings, and the readings did not
// agree: Node's parser knew `second|minute|hour|day` and silently fell back to its built-in
// default for anything else, so `ADVANCE_TIMEOUT="1 week"` was a week on Cloudflare and five
// minutes on Node — the exact facade drift a single knob exists to prevent.
//
// So the value is parsed HERE, once, at config load, and the CANONICAL spelling is what
// `ExecutionConfig` carries onward. A value this module accepted is therefore a value both
// runtimes can honour identically, and a value it rejected falls back to the same default on
// both with one warning naming the variable (see `warnOnce.ts` for why once per process).
//
// Two deliberate narrowings against what Workflows' own `WorkflowSleepDuration` type admits:
//
//   - `month` and `year` are refused. They are CALENDAR units with no fixed length, so Node and
//     Workflows would each pick their own and the knob would mean two different things again.
//     Nothing here is configured in months, so refusing costs a deployment nothing.
//   - A duration Node cannot hold in a timer is refused rather than clamped, for the reason
//     {@link MAX_TIMER_DELAY_MS} documents: past that limit `setTimeout` substitutes 1ms, so the
//     value someone types to mean "effectively no limit" is the one that fails every run at once.
// ---------------------------------------------------------------------------

import { DOCS } from './docs.js'
import { MAX_TIMER_DELAY_MS } from './numeric.js'
import { configWarnings } from './warnOnce.js'

/**
 * The units a duration knob may be written in, and what each is worth.
 *
 * Mirrors Cloudflare's `WorkflowDurationLabel` minus its two calendar units (see the header).
 * Restated rather than imported because this layer is runtime-neutral: `@cat-factory/server` is
 * the code BOTH facades build on, so it cannot depend on either one's types.
 */
const DURATION_SCALE_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
} as const

type DurationLabel = keyof typeof DURATION_SCALE_MS

const DURATION_LABELS = Object.keys(DURATION_SCALE_MS) as DurationLabel[]

/**
 * `<whole number> <unit>`, the unit optionally plural — the subset of Workflows' duration
 * grammar this platform accepts. Derived from {@link DURATION_SCALE_MS}'s own keys so adding a
 * unit is one edit, and a unit that is not in the table cannot slip through the pattern.
 */
const DURATION_PATTERN = new RegExp(`^(\\d+)\\s*(${DURATION_LABELS.join('|')})s?$`)

/** A resolved duration knob: what Node waits, and what the Worker hands to Workflows. */
export interface ConfigDuration {
  /** Milliseconds, for a `setTimeout`/`Promise.race` on Node. */
  readonly ms: number
  /**
   * The `<n> <unit>s` spelling, for Workflows. Canonical (re-emitted from the parsed number and
   * unit rather than echoed) so what reaches `step.do` is always a form Workflows' own type
   * admits, whatever spacing or plural the operator wrote.
   */
  readonly canonical: string
}

/** A parsed duration, or WHY the value is unusable — the fault clause of the operator message. */
export type DurationParse = { readonly duration: ConfigDuration } | { readonly fault: string }

/**
 * Parse one duration string. Rejects rather than repairs: a knob is a bound on real work, so a
 * value that cannot be honoured as written must fall back to a default the operator can read in
 * the docs, not to a silently reshaped version of what they typed.
 */
export function parseConfigDuration(value: string): DurationParse {
  const match = DURATION_PATTERN.exec(value.trim())
  if (!match) {
    return {
      fault:
        `is not a duration this platform accepts — write it as a whole number and one of ` +
        `${DURATION_LABELS.join(', ')} (e.g. "30 minutes")`,
    }
  }
  const amount = Number(match[1])
  const label = match[2] as DurationLabel
  const ms = amount * DURATION_SCALE_MS[label]
  if (ms <= 0) {
    return { fault: 'must be greater than zero (a zero-length bound expires immediately)' }
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    return {
      fault:
        `is longer than the ${MAX_TIMER_DELAY_MS}ms a timer can hold, which would truncate it ` +
        `to 1ms and expire immediately`,
    }
  }
  return { duration: { ms, canonical: `${amount} ${label}${amount === 1 ? '' : 's'}` } }
}

/**
 * Resolve a duration env var against a built-in default.
 *
 * Unset or blank means "inherit the default" and is not a fault, so it warns about nothing. A
 * PRESENT value that cannot be parsed emits one warning naming the variable, quoting what was
 * rejected and stating the default that stands instead, then falls back — the same shape (and
 * the same reasoning) as `parseNumericEnv`.
 *
 * `fallback` is a literal in the calling config loader, never operator input, so a fallback this
 * module cannot parse is a programming error and throws: silently accepting it would put a
 * facade back on an unparsed duration, which is what this module exists to stop.
 */
export function resolveDurationEnv(
  name: string,
  value: string | undefined,
  fallback: string,
): ConfigDuration {
  const parsedFallback = parseConfigDuration(fallback)
  if ('fault' in parsedFallback) {
    throw new Error(`built-in default for ${name} ("${fallback}") ${parsedFallback.fault}`)
  }
  const raw = value?.trim()
  if (!raw) return parsedFallback.duration
  const parsed = parseConfigDuration(raw)
  if ('duration' in parsed) return parsed.duration
  configWarnings.warnOnce(
    `${name}="${raw}" ${parsed.fault} — using the default "${parsedFallback.duration.canonical}". ` +
      `See ${DOCS.envVars()}.`,
    { var: name, value: raw, docsUrl: DOCS.envVars() },
  )
  return parsedFallback.duration
}
