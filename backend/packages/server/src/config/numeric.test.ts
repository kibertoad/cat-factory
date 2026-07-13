import { describe, expect, it } from 'vitest'
import { describeRejectedNumericEnv, parseNumericEnv } from './numeric.js'

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
