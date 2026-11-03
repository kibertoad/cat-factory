// An agent dry run's report, shared by the report itself and the self-test panel that shows it.
import type { EnvironmentProbeReport } from '@cat-factory/contracts'

/** Partly operable: public calls work, the signed-in ones were never given a credential. */
export const partialProbeReport: EnvironmentProbeReport = {
  surface: 'api',
  verdict: 'partially_operable',
  summary: 'Public endpoints answer; nothing behind sign-in could be reached.',
  operations: [
    { name: 'GET /health', target: '/health', authenticated: false, outcome: 'succeeded' },
    {
      name: 'List sessions',
      target: '/sessions',
      authenticated: true,
      outcome: 'failed',
      failure: 'auth_missing',
      detail: 'No credential named for this service.',
    },
    { name: 'Revoke a session', authenticated: true, outcome: 'not_attempted' },
  ],
  missingContext: ['Which test account to sign in as.', 'Whether staging data may be deleted.'],
  blockers: [{ kind: 'auth_missing', detail: 'No sign-in credential was provided.' }],
  attempted: 2,
  succeeded: 1,
  authenticatedSucceeded: 0,
  model: 'claude-opus-5',
}
