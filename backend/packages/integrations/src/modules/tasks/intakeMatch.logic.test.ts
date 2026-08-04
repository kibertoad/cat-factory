import { describe, expect, it } from 'vitest'
import type { IssueIntakeConfig, TrackerIssueEvent } from '@cat-factory/kernel'
import { judgeIssueEventForIntake } from './intakeMatch.logic.js'

const config = (
  over: Partial<IssueIntakeConfig['predicates']> = {},
  board: IssueIntakeConfig['board'] = { jiraProjectKey: 'ENG' },
): IssueIntakeConfig =>
  ({
    source: 'jira',
    board,
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
  board: 'ENG',
  url: null,
  ...over,
})

/** The verdict's shape is the point; these read the outcome for the plain cases. */
const outcome = (c: IssueIntakeConfig, e: TrackerIssueEvent) =>
  judgeIssueEventForIntake(c, e).outcome

describe('judgeIssueEventForIntake', () => {
  it('matches an issue on the configured source and board with no predicates', () => {
    expect(outcome(config(), event())).toBe('match')
  })

  it('never matches another source', () => {
    expect(judgeIssueEventForIntake(config(), event({ source: 'linear' }))).toEqual({
      outcome: 'miss',
      predicate: 'source',
    })
  })

  it('never matches a CLOSED issue — intake picks up open work', () => {
    // Acting on a close would spend a whole run to discover the issue is gone.
    expect(outcome(config(), event({ action: 'closed' }))).toBe('miss')
    expect(outcome(config(), event({ action: 'updated' }))).toBe('match')
  })

  it('requires EVERY configured label, case-insensitively (the vendor queries are AND)', () => {
    expect(outcome(config({ labels: ['BUG'] }), event())).toBe('match')
    expect(outcome(config({ labels: ['bug', 'customer'] }), event())).toBe('match')
    expect(outcome(config({ labels: ['bug', 'p0'] }), event())).toBe('miss')
  })

  it('matches the title fragment case-insensitively', () => {
    expect(outcome(config({ titleFragment: 'CRASHES' }), event())).toBe('match')
    expect(outcome(config({ titleFragment: 'timeout' }), event())).toBe('miss')
  })

  it('matches the issue type case-insensitively', () => {
    expect(outcome(config({ issueType: 'bug' }), event())).toBe('match')
    expect(outcome(config({ issueType: 'story' }), event())).toBe('miss')
  })

  it('ignores a blank predicate rather than treating it as a filter', () => {
    expect(outcome(config({ titleFragment: '   ' }), event())).toBe('match')
    expect(outcome(config({ issueType: '' }), event())).toBe('match')
    expect(outcome(config({ labels: [] }), event())).toBe('match')
  })

  describe('board scope', () => {
    it('misses an issue on a DIFFERENT board than the schedule is scoped to', () => {
      // The schedule names one project; a delivery from another project on the same connection is
      // not this schedule's work. Left unevaluated, per-ticket dispatch would run it.
      expect(
        judgeIssueEventForIntake(config({}, { jiraProjectKey: 'ENG' }), event({ board: 'OPS' })),
      ).toEqual({ outcome: 'miss', predicate: 'board' })
    })

    it('compares case-insensitively, since both sides are typed by hand', () => {
      expect(outcome(config({}, { jiraProjectKey: 'eng' }), event({ board: 'ENG' }))).toBe('match')
    })

    it('reads whichever board leg the config carries, registered sources included', () => {
      const registered = { ...event({ source: 'acme:servicenow', board: 'QUEUE-7' }) }
      const cfg = {
        source: 'acme:servicenow',
        board: { boardId: 'QUEUE-7' },
        predicates: {},
      } as IssueIntakeConfig
      expect(outcome(cfg, registered)).toBe('match')
      expect(outcome(cfg, { ...registered, board: 'QUEUE-8' })).toBe('miss')
    })

    it('is UNCONFIRMED, never a match, when the delivery named no board', () => {
      // A schedule scoped to one project must not be assumed to cover a delivery that never said
      // which project it came from.
      expect(judgeIssueEventForIntake(config(), event({ board: null }))).toEqual({
        outcome: 'unconfirmed',
        predicates: ['board'],
      })
    })

    it('does not evaluate a board the config left unscoped', () => {
      expect(outcome(config({}, {}), event({ board: null }))).toBe('match')
    })
  })

  describe('a predicate the delivery cannot answer', () => {
    it('is UNCONFIRMED rather than silently a match', () => {
      // This is the distinction the verdict exists for. Reported as neither satisfied nor violated,
      // so `dispatchAdmits` can fire a queue schedule (whose vendor search re-checks everything)
      // while withholding a per-ticket dispatch (which has no such authority behind it).
      expect(judgeIssueEventForIntake(config({ labels: ['bug'] }), event({ labels: [] }))).toEqual({
        outcome: 'unconfirmed',
        predicates: ['labels'],
      })
      expect(
        judgeIssueEventForIntake(config({ issueType: 'Bug' }), event({ issueType: null })),
      ).toEqual({ outcome: 'unconfirmed', predicates: ['issueType'] })
      expect(
        judgeIssueEventForIntake(config({ titleFragment: 'x' }), event({ title: '' })),
      ).toEqual({ outcome: 'unconfirmed', predicates: ['titleFragment'] })
    })

    it('names every unanswered predicate, so the log says what to fix', () => {
      const verdict = judgeIssueEventForIntake(
        config({ labels: ['bug'], issueType: 'Bug' }),
        event({ board: null, labels: [], issueType: null }),
      )
      expect(verdict).toEqual({
        outcome: 'unconfirmed',
        predicates: ['board', 'labels', 'issueType'],
      })
    })

    it('still loses to a DEFINITE miss elsewhere', () => {
      // An unanswered predicate never upgrades a violated one into "we could not tell".
      expect(
        outcome(config({ labels: ['bug'], titleFragment: 'timeout' }), event({ labels: [] })),
      ).toBe('miss')
    })
  })
})
