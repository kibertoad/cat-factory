// A tester step's report and loop state, for the step detail, the step's test report card and the
// tester window.
import type { TestReport, TesterStepState } from '@cat-factory/contracts'

/**
 * A report that does not greenlight: two areas pass, one fails, one requirement is not met and one
 * was not covered, with a concern at each of three severities.
 */
export function testReport(overrides: Partial<TestReport> = {}): TestReport {
  return {
    greenlight: false,
    summary:
      'Sign-in and refresh work. Logging out on one device leaves the other device signed in, so ' +
      '**log out everywhere** does not do what it says.',
    tested: [
      'Sign in with a password, then refresh the session',
      'Log out everywhere from a second browser',
      'An expired refresh token',
    ],
    outcomes: [
      { name: 'Sign in and refresh', status: 'passed' },
      { name: 'Expired refresh token answers 401', status: 'passed' },
      {
        name: 'Log out everywhere',
        status: 'failed',
        detail: 'The second browser kept working for 15 minutes.',
      },
    ],
    concerns: [
      {
        title: 'Access tokens outlive a logout',
        detail:
          'Revocation reaches refresh tokens only; an access token stays valid until it expires.',
        severity: 'high',
      },
      {
        title: 'No rate limit on refresh',
        detail: 'A client can refresh in a tight loop.',
        severity: 'medium',
      },
      { title: 'Error copy names the token type', detail: '', severity: 'low' },
    ],
    requirementVerdicts: [
      { requirementId: 'req-login', status: 'met' },
      { requirementId: 'req-logout-all', status: 'not_met', detail: 'Other sessions survive.' },
      { requirementId: 'req-audit', status: 'not_covered' },
    ],
    ...overrides,
  }
}

/** The tester loop handing the failures to the fixer, on its first of three attempts. */
export function testerState(overrides: Partial<TesterStepState> = {}): TesterStepState {
  return { phase: 'fixing', attempts: 1, maxAttempts: 3, lastReport: testReport(), ...overrides }
}
