import { describe, expect, it } from 'vitest'
import {
  describeRejectedNumericEnv,
  MAX_TIMER_DELAY_MS,
  parseNumericEnv,
  parseTimerEnvMs,
} from './numeric.js'

// A8: a numeric knob set to garbage (`JOB_MAX_POLLS=abc`) used to coerce to the built-in
// default with no signal. These pin the parse behaviour + the operator warning message.

describe('parseNumericEnv', () => {
  it('returns undefined for an unset var (default applies, no warning)', () => {
    expect(parseNumericEnv('JOB_MAX_POLLS', undefined)).toBeUndefined()
  })

  it('returns undefined for a blank / whitespace-only value', () => {
    expect(parseNumericEnv('JOB_MAX_POLLS', '')).toBeUndefined()
    expect(parseNumericEnv('JOB_MAX_POLLS', '   ')).toBeUndefined()
  })

  it('parses a valid integer', () => {
    expect(parseNumericEnv('JOB_MAX_POLLS', '280')).toBe(280)
  })

  it('parses a valid float and a negative', () => {
    expect(parseNumericEnv('AGENT_DEFAULT_TEMPERATURE', '0.4')).toBe(0.4)
    expect(parseNumericEnv('BUDGET_MAX_MONTHLY_PER_USER', '-1')).toBe(-1)
  })

  it('returns undefined for a non-numeric value so the default applies', () => {
    expect(parseNumericEnv('JOB_MAX_POLLS', 'abc')).toBeUndefined()
    // A stray unit or trailing punctuation is not a finite number either.
    expect(parseNumericEnv('CONTAINER_MAX_AGE_MINUTES', '30s')).toBeUndefined()
    expect(parseNumericEnv('CI_MAX_POLLS', 'NaN')).toBeUndefined()
  })
})

describe('describeRejectedNumericEnv', () => {
  it('names the var, quotes the rejected value, and states the default is used', () => {
    const msg = describeRejectedNumericEnv('JOB_MAX_POLLS', 'abc')
    expect(msg).toContain('JOB_MAX_POLLS')
    expect(msg).toContain('"abc"')
    expect(msg).toContain('not a number')
    expect(msg).toContain('built-in default')
    expect(msg).toContain('environment-variables.md')
    expect(msg).not.toContain('undefined')
  })

  it('is a pure function of its inputs', () => {
    expect(describeRejectedNumericEnv('CI_MAX_POLLS', '30s')).toBe(
      describeRejectedNumericEnv('CI_MAX_POLLS', '30s'),
    )
  })
})

// A timer budget is stricter than a plain numeric knob because EVERY unusable spelling has the
// same catastrophic shape: `setTimeout` fires it immediately, so a typo in one env var kills every
// supervised run on the deployment at once rather than degrading one of them.
describe('parseTimerEnvMs', () => {
  const ms = (raw: string): number | undefined => {
    const parsed = parseTimerEnvMs('SOME_TIMEOUT_MS', raw, 300_000)
    return 'ms' in parsed ? parsed.ms : undefined
  }
  const rejection = (raw: string): string | undefined => {
    const parsed = parseTimerEnvMs('SOME_TIMEOUT_MS', raw, 300_000)
    return 'rejected' in parsed ? parsed.rejected : undefined
  }

  it('accepts a whole positive number of milliseconds, trimmed', () => {
    expect(ms('300000')).toBe(300_000)
    expect(ms('  60000  ')).toBe(60_000)
    expect(ms('1')).toBe(1)
  })

  it('accepts the largest delay a timer can actually hold', () => {
    expect(ms(String(MAX_TIMER_DELAY_MS))).toBe(MAX_TIMER_DELAY_MS)
  })

  // The value someone types meaning "effectively no ceiling" is exactly the one Node truncates to
  // 1ms — so left unguarded, the operator disabling the backstop disables every run instead.
  it('rejects a delay past the 32-bit timer ceiling, saying it would fire immediately', () => {
    const message = rejection(String(MAX_TIMER_DELAY_MS + 1))
    expect(message).toContain('exceeds')
    expect(message).toContain(String(MAX_TIMER_DELAY_MS))
    expect(message).toContain('fire immediately')
    expect(ms('999999999999')).toBeUndefined()
  })

  it('rejects zero and negatives, saying they fire immediately', () => {
    expect(rejection('0')).toContain('greater than zero')
    expect(rejection('-1')).toContain('greater than zero')
  })

  it.each(['5m', '1.5', 'soon', 'NaN', 'Infinity', '-Infinity'])(
    'rejects the unusable value %j as not a whole number',
    (raw) => {
      expect(rejection(raw)).toContain('not a whole number of milliseconds')
    },
  )

  it('names the var, quotes the value, and states which default takes over', () => {
    const message = rejection('5m')
    expect(message).toContain('SOME_TIMEOUT_MS')
    expect(message).toContain('"5m"')
    expect(message).toContain('using the default 300000ms')
    expect(message).toContain('environment-variables.md')
  })
})
