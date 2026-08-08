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

    it("defers to the SOURCE's own equality rule where it declares one", () => {
      // GitLab project paths are case-SENSITIVE at the vendor, so the default fold above would
      // admit a delivery from `Acme/web` to a schedule scoped to `acme/web`: two different
      // projects, and under per-ticket dispatch a real run on a stranger's issue.
      const cfg = {
        source: 'gitlab',
        board: { gitlabProject: 'acme/web' },
        predicates: {},
      } as IssueIntakeConfig
      const delivery = event({ source: 'gitlab', board: 'Acme/web' })
      expect(judgeIssueEventForIntake(cfg, delivery).outcome).toBe('match')
      expect(
        judgeIssueEventForIntake(cfg, delivery, { sameBoard: (a, b) => a === b }).outcome,
      ).toBe('miss')
    })

    it("calls the source's rule as a METHOD, so an implementation reading `this` works", () => {
      // The port declares `sameBoard` as a method signature, so a deployment is entitled to
      // implement it as a class method carrying its own configured case rules. Lifting it off the
      // provider to call it (`(provider?.sameBoard ?? fallback)(…)`) throws a TypeError on the
      // first pushed delivery and takes the whole push-intake loop down. The built-in providers
      // assign standalone functions, so nothing else here would ever have shown it.
      class ExactBoardSource {
        readonly separator = '/'
        sameBoard(a: string, b: string): boolean {
          // Reads `this`: undefined receiver ⇒ TypeError, which is the regression.
          return a.split(this.separator).join('/') === b.split(this.separator).join('/')
        }
      }
      const cfg = {
        source: 'gitlab',
        board: { gitlabProject: 'acme/web' },
        predicates: {},
      } as IssueIntakeConfig
      const provider = new ExactBoardSource()
      expect(
        judgeIssueEventForIntake(cfg, event({ source: 'gitlab', board: 'acme/web' }), provider)
          .outcome,
      ).toBe('match')
      expect(
        judgeIssueEventForIntake(cfg, event({ source: 'gitlab', board: 'Acme/web' }), provider)
          .outcome,
      ).toBe('miss')
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
