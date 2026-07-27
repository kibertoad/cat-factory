import { describe, it, expect } from 'vitest'
import { resolveVerdictMeta, UNKNOWN_VERDICT_COLOR, VERDICT_COLORS } from './StepTestReport.logic'
import type { RequirementVerdictStatus } from '~/types/domain'

/**
 * The tester panel's requirement → evidence dots. The verdict is three-valued precisely so that
 * "we didn't check" and "it's broken" never render the same; these pin that a FOURTH, unknown
 * value cannot quietly join either camp.
 */
const LABELS: Record<RequirementVerdictStatus, string> = {
  met: 'Met',
  not_met: 'Not met',
  not_covered: 'Not checked',
}

describe('resolveVerdictMeta', () => {
  it('resolves each known status to its own label and colour', () => {
    expect(resolveVerdictMeta('met', LABELS)).toEqual({ label: 'Met', color: '#22c55e' })
    expect(resolveVerdictMeta('not_met', LABELS)).toEqual({ label: 'Not met', color: '#ef4444' })
    expect(resolveVerdictMeta('not_covered', LABELS)).toEqual({
      label: 'Not checked',
      color: '#64748b',
    })
  })

  it('gives the three known statuses three distinct colours', () => {
    const colors = Object.values(VERDICT_COLORS)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('falls back to the raw code for an unrecognised status', () => {
    const meta = resolveVerdictMeta('inconclusive' as RequirementVerdictStatus, LABELS)
    expect(meta).toEqual({ label: 'inconclusive', color: UNKNOWN_VERDICT_COLOR })
  })

  it('never lets an unrecognised status borrow a known colour', () => {
    // The regression this guards: reusing `not_covered`'s grey made a contract violation read
    // as "not checked", which is the one confusion the three-valued design forbids.
    expect(Object.values(VERDICT_COLORS)).not.toContain(UNKNOWN_VERDICT_COLOR)
  })

  it('falls back when the status is known but its label is missing', () => {
    const sparse = { met: 'Met' } as Record<RequirementVerdictStatus, string>
    expect(resolveVerdictMeta('not_met', sparse)).toEqual({
      label: 'not_met',
      color: UNKNOWN_VERDICT_COLOR,
    })
  })
})
