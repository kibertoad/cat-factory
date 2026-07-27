import { describe, expect, it } from 'vitest'
import type { IssueIntakeConfig, TrackerIssueEvent } from '@cat-factory/kernel'
import { issueEventMatchesIntake } from './intakeMatch.logic.js'

const config = (over: Partial<IssueIntakeConfig['predicates']> = {}): IssueIntakeConfig =>
  ({
    source: 'jira',
    board: { jiraProjectKey: 'ENG' },
    predicates: { ...over },
  }) as IssueIntakeConfig

const event = (over: Partial<TrackerIssueEvent> = {}): TrackerIssueEvent => ({
  kind: 'issue',
  source: 'jira',
  externalId: 'ENG-1',
  action: 'created',
  title: 'Checkout crashes on submit',
  labels: ['bug', 'customer'],
  issueType: 'Bug',
  url: null,
  ...over,
})

describe('issueEventMatchesIntake', () => {
  it('matches an issue on the configured source with no predicates', () => {
    expect(issueEventMatchesIntake(config(), event())).toBe(true)
  })

  it('never matches another source', () => {
    expect(issueEventMatchesIntake(config(), event({ source: 'linear' }))).toBe(false)
  })

  it('never matches a CLOSED issue — intake picks up open work', () => {
    // Firing on a close would spend a whole run to discover the issue is gone.
    expect(issueEventMatchesIntake(config(), event({ action: 'closed' }))).toBe(false)
    expect(issueEventMatchesIntake(config(), event({ action: 'updated' }))).toBe(true)
  })

  it('requires EVERY configured label, case-insensitively (the vendor queries are AND)', () => {
    expect(issueEventMatchesIntake(config({ labels: ['BUG'] }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ labels: ['bug', 'customer'] }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ labels: ['bug', 'p0'] }), event())).toBe(false)
  })

  it('matches the title fragment case-insensitively', () => {
    expect(issueEventMatchesIntake(config({ titleFragment: 'CRASHES' }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ titleFragment: 'timeout' }), event())).toBe(false)
  })

  it('matches the issue type case-insensitively', () => {
    expect(issueEventMatchesIntake(config({ issueType: 'bug' }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ issueType: 'story' }), event())).toBe(false)
  })

  it('FAILS OPEN on a field the payload does not carry', () => {
    // The asymmetry that governs this whole predicate: a false positive costs one run that
    // completes immediately with "no matching open issues" (indistinguishable from an idle cadence
    // fire), while a false negative costs intake LATENCY, silently, until the next sweep. The
    // vendor search inside the fired run is the authority either way — so a payload shape that
    // omits labels or has no type notion (Linear) must not suppress the fire.
    expect(issueEventMatchesIntake(config({ labels: ['bug'] }), event({ labels: [] }))).toBe(true)
    expect(issueEventMatchesIntake(config({ issueType: 'Bug' }), event({ issueType: null }))).toBe(
      true,
    )
    expect(issueEventMatchesIntake(config({ titleFragment: 'x' }), event({ title: '' }))).toBe(true)
  })

  it('ignores a blank predicate rather than treating it as a filter', () => {
    expect(issueEventMatchesIntake(config({ titleFragment: '   ' }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ issueType: '' }), event())).toBe(true)
    expect(issueEventMatchesIntake(config({ labels: [] }), event())).toBe(true)
  })
})
