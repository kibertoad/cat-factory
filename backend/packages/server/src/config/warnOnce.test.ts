import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ConfigWarningLog } from './warnOnce.js'

// The Worker re-derives the whole config on every invocation, so an unconditional warn in a
// config parser is one line per request for as long as a var stays mistyped. These pin that a
// standing problem is stated once per process and that two different problems still both land.

describe('ConfigWarningLog', () => {
  it('emits a message the first time and suppresses the repeat', () => {
    const logger = createRecordingLogger()
    const { lines } = logger
    const warnings = new ConfigWarningLog(logger)

    expect(warnings.warnOnce('SOME_VAR is set to "abc"', { var: 'SOME_VAR' })).toBe(true)
    expect(warnings.warnOnce('SOME_VAR is set to "abc"', { var: 'SOME_VAR' })).toBe(false)
    expect(warnings.warnOnce('SOME_VAR is set to "abc"', { var: 'SOME_VAR' })).toBe(false)

    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.msg).toContain('SOME_VAR')
    expect(lines[0]?.fields).toMatchObject({ var: 'SOME_VAR' })
  })

  it('still reports a DIFFERENT problem, so the dedup never hides a second fault', () => {
    const logger = createRecordingLogger()
    const { lines } = logger
    const warnings = new ConfigWarningLog(logger)

    warnings.warnOnce('SOME_VAR is set to "abc"', {})
    warnings.warnOnce('OTHER_VAR is set to "xyz"', {})
    // Same var, different rejected value: a distinct message, so a distinct line.
    warnings.warnOnce('SOME_VAR is set to "def"', {})

    expect(lines.map((line) => line.msg)).toEqual([
      'SOME_VAR is set to "abc"',
      'OTHER_VAR is set to "xyz"',
      'SOME_VAR is set to "def"',
    ])
  })

  it('keeps its record per instance, so one process’s history is not another’s', () => {
    const first = createRecordingLogger()
    const second = createRecordingLogger()
    new ConfigWarningLog(first).warnOnce('SOME_VAR is set to "abc"', {})
    // A fresh isolate re-states a standing problem rather than inheriting the silence.
    expect(new ConfigWarningLog(second).warnOnce('SOME_VAR is set to "abc"', {})).toBe(true)
    expect(second.lines).toHaveLength(1)
  })
})
