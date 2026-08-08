import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from './numeric.js'
import { parseConfigDuration, resolveDurationEnv } from './duration.js'

// One reading of a duration knob, for both facades (see the module header). The Worker hands the
// string to Workflows and Node turns it into a `setTimeout` delay, and while those were two
// separate parsers `ADVANCE_TIMEOUT="1 week"` was a week on Cloudflare and five minutes on Node.

/** The ms/canonical pair, or the fault clause, whichever the parse produced. */
function parsed(value: string): unknown {
  const result = parseConfigDuration(value)
  return 'duration' in result ? result.duration : result.fault
}

describe('parseConfigDuration', () => {
  it('accepts every unit it advertises, singular or plural', () => {
    expect(parsed('30 seconds')).toEqual({ ms: 30_000, canonical: '30 seconds' })
    expect(parsed('5 minutes')).toEqual({ ms: 300_000, canonical: '5 minutes' })
    expect(parsed('1 hour')).toEqual({ ms: 3_600_000, canonical: '1 hour' })
    expect(parsed('2 days')).toEqual({ ms: 172_800_000, canonical: '2 days' })
    expect(parsed('1 week')).toEqual({ ms: 604_800_000, canonical: '1 week' })
  })

  it('canonicalises the spelling rather than echoing it', () => {
    // What reaches `step.do` has to be a form Workflows' own duration type admits, whatever the
    // operator wrote. Re-emitting it from the parsed number and unit is what guarantees that,
    // and it is why the plural has to follow the NUMBER rather than the input.
    const result = parseConfigDuration('1  minutes')
    expect(result).toEqual({ duration: { ms: 60_000, canonical: '1 minute' } })
  })

  it('refuses a calendar unit rather than picking a length for it', () => {
    // Workflows' own type admits `month`/`year`, and each side would have to invent how long one
    // is. Two inventions is the drift this parser exists to remove, so neither is made.
    expect(parsed('1 month')).toContain('not a duration this platform accepts')
    expect(parsed('1 year')).toContain('not a duration this platform accepts')
  })

  it('refuses a duration no timer can hold, instead of letting it expire immediately', () => {
    // Past `MAX_TIMER_DELAY_MS` Node substitutes a 1ms delay, so the value someone types to mean
    // "effectively no limit" is the one that fails every step at once (see `numeric.ts`).
    expect(parsed('30 days')).toContain('is longer than')
    expect(parseConfigDuration(`${Math.floor(MAX_TIMER_DELAY_MS / 1000)} seconds`)).toHaveProperty(
      'duration',
    )
  })

  it('refuses a zero-length bound', () => {
    expect(parsed('0 minutes')).toContain('must be greater than zero')
  })

  it('refuses what is not a duration at all', () => {
    expect(parsed('soon')).toContain('not a duration this platform accepts')
    expect(parsed('300000')).toContain('not a duration this platform accepts')
    expect(parsed('-5 minutes')).toContain('not a duration this platform accepts')
  })
})

describe('resolveDurationEnv', () => {
  it('falls back for an unset or blank variable, which is not a fault', () => {
    expect(resolveDurationEnv('ADVANCE_TIMEOUT', undefined, '30 minutes').ms).toBe(1_800_000)
    expect(resolveDurationEnv('ADVANCE_TIMEOUT', '   ', '30 minutes').ms).toBe(1_800_000)
  })

  it('falls back to the SAME default for a value neither runtime can honour', () => {
    // The point of the shared resolver: a rejected value lands on one default rather than each
    // facade's own, so the knob still means one thing when it is mistyped.
    expect(resolveDurationEnv('ADVANCE_TIMEOUT', '1 month', '30 minutes')).toEqual({
      ms: 1_800_000,
      canonical: '30 minutes',
    })
  })

  it('refuses a built-in default it cannot parse, rather than shipping an unparsed one', () => {
    // Never operator input: a fallback this module rejects is a bug in a config loader, and
    // accepting it would put a facade back on a duration nothing agreed how to read.
    expect(() => resolveDurationEnv('ADVANCE_TIMEOUT', undefined, '1 fortnight')).toThrow(
      /built-in default for ADVANCE_TIMEOUT/,
    )
  })
})
