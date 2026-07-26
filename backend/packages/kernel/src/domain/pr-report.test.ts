import { describe, expect, it } from 'vitest'
import {
  PR_REPORT_MARKER_END,
  PR_REPORT_MARKER_START,
  readManagedSection,
  spliceManagedSection,
} from './pr-report.js'

describe('spliceManagedSection', () => {
  it('appends the section after the existing body when no markers are present', () => {
    const out = spliceManagedSection("The agent's own description.", 'REPORT')
    expect(out.startsWith("The agent's own description.")).toBe(true)
    expect(readManagedSection(out)).toBe('REPORT')
  })

  it('handles an absent/empty body without leading blank lines', () => {
    expect(spliceManagedSection(null, 'REPORT')).toBe(
      `${PR_REPORT_MARKER_START}\nREPORT\n${PR_REPORT_MARKER_END}\n`,
    )
    expect(spliceManagedSection('   \n', 'REPORT')).toBe(
      `${PR_REPORT_MARKER_START}\nREPORT\n${PR_REPORT_MARKER_END}\n`,
    )
  })

  it('replaces the managed region in place, preserving prose above AND below it', () => {
    const first = spliceManagedSection('Above.', 'ONE')
    const withTrailer = `${first}\nBelow.`
    const second = spliceManagedSection(withTrailer, 'TWO')

    expect(readManagedSection(second)).toBe('TWO')
    expect(second).toContain('Above.')
    expect(second).toContain('Below.')
    expect(second).not.toContain('ONE')
    // Exactly one managed region — the whole point: a re-run never appends a second report.
    expect(second.split(PR_REPORT_MARKER_START).length - 1).toBe(1)
  })

  it('is idempotent for an unchanged section (the caller can skip the remote write)', () => {
    const once = spliceManagedSection('Above.', 'SAME')
    expect(spliceManagedSection(once, 'SAME')).toBe(once)
  })

  it('appends rather than guessing when the markers are malformed', () => {
    // An end marker with no start (a human mangled the body): eating everything up to it
    // would destroy real prose, so a fresh region is appended and the stray marker is left.
    const mangled = `Keep me. ${PR_REPORT_MARKER_END}`
    const out = spliceManagedSection(mangled, 'REPORT')
    expect(out).toContain('Keep me.')
    expect(out).toContain(PR_REPORT_MARKER_START)
  })

  it('reads back no section from a body that has none', () => {
    expect(readManagedSection('just prose')).toBeNull()
    expect(readManagedSection(undefined)).toBeNull()
  })
})
