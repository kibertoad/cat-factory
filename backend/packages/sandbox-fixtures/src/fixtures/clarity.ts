import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// clarity-review (bug-report triage) fixtures. The payload is a `ClarityContext`:
// `{ block: { title, type, description }, investigation? }`. Each is a vague/ambiguous
// bug report; the expectations are the missing facts or conflations a good triage should
// surface so the bug becomes actionable.

export const CLARITY_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'clarity-slow-page-simple',
    agentKind: 'clarity-review',
    kind: 'clarity',
    name: 'Page is slow (simple)',
    difficulty: 'simple',
    summary: 'A one-line "the dashboard is slow" report with no repro, scope, or baseline.',
    payload: {
      block: {
        title: 'Dashboard is slow',
        type: 'service',
        description: 'The dashboard is really slow now. Please fix it, it was fine before.',
      },
    },
    expectations: [
      exp(
        'repro',
        'No reproduction steps: which dashboard/view, what actions, signed in as whom?',
        {
          impact: 5,
          trickiness: 1,
          matchHints: ['reproduction', 'reproduce', 'repro', 'steps'],
        },
      ),
      exp('quantify', '"Slow" is not quantified — how slow, vs what baseline, and measured how?', {
        impact: 4,
        trickiness: 1,
        matchHints: ['how slow', 'quantif', 'seconds', 'baseline', 'measure'],
      }),
      exp(
        'regression-window',
        '"Fine before" — when did it regress, and what changed (deploy, data growth) around then?',
        {
          impact: 4,
          trickiness: 3,
          detail:
            'Pinning the regression window is the highest-leverage triage question and is easy to skip past.',
          matchHints: ['when did', 'regress', 'started', 'deploy', 'recently'],
        },
      ),
      exp(
        'scope',
        'Is it all users or one account — could it be data-volume-dependent for a specific tenant?',
        {
          impact: 3,
          trickiness: 3,
          matchHints: ['all users', 'one user', 'specific account', 'tenant', 'data volume'],
        },
      ),
    ],
    notes:
      'Missing repro is the must-find; the regression-window question is the higher-skill catch.',
  },
  {
    id: 'clarity-login-loop-moderate',
    agentKind: 'clarity-review',
    kind: 'clarity',
    name: 'Login keeps failing (moderate)',
    difficulty: 'moderate',
    summary: 'A login bug report that conflates several distinct failure modes.',
    payload: {
      block: {
        title: 'Login keeps failing',
        type: 'service',
        description: [
          'Users say login keeps failing. Sometimes it says the password is wrong even though it is right,',
          'and sometimes it just loops back to the login page. A couple of people mentioned the code from',
          'the app did not work. Happens on and off.',
        ].join(' '),
      },
    },
    expectations: [
      exp(
        'conflation',
        'Three distinct failures are conflated: wrong-password, redirect loop, and 2FA code rejection.',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'Separating the symptoms is the key triage move — each likely has a different root cause.',
          matchHints: [
            'separate',
            'distinct',
            'conflate',
            'three different',
            'different issues',
            '2fa',
          ],
        },
      ),
      exp(
        'repro',
        'No reproduction: which accounts, after what action, and is "wrong even though right" verified?',
        {
          impact: 5,
          trickiness: 1,
          matchHints: ['reproduction', 'reproduce', 'repro', 'steps'],
        },
      ),
      exp(
        'environment',
        'Missing environment: browser/app version, platform, and whether it correlates with any of them.',
        {
          impact: 3,
          trickiness: 1,
          matchHints: ['browser', 'app version', 'platform', 'device', 'os'],
        },
      ),
      exp(
        'intermittent',
        '"On and off" — is the redirect loop tied to expired sessions/cookies or a specific server?',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'The loop smells like a session/cookie or load-balancer-affinity issue; a sharp triager probes that.',
          matchHints: [
            'session',
            'cookie',
            'expired',
            'load balancer',
            'sticky',
            'server instance',
          ],
        },
      ),
    ],
    notes: 'The symptom-conflation and the session/cookie hypothesis are the high-skill catches.',
  },
  {
    id: 'clarity-data-loss-complex',
    agentKind: 'clarity-review',
    kind: 'clarity',
    name: 'Edits sometimes disappear (complex)',
    difficulty: 'complex',
    summary: 'An intermittent data-loss report with a partial investigation already attached.',
    payload: {
      block: {
        title: 'Saved edits sometimes disappear',
        type: 'service',
        description: [
          'Customers report that edits they make to a document sometimes disappear after a while. They save,',
          'see the change, then later it is back to an old version. It does not happen every time. This is',
          'causing churn — please prioritize.',
        ].join(' '),
      },
      investigation: [
        'Investigator notes: the document service has a "last write wins" update path. Two browser tabs (or the',
        'mobile app and web open at once) each hold a copy loaded at different times. There is no version check',
        'on save. Logs show overlapping saves to the same document id within a few seconds for affected users.',
      ].join(' '),
    },
    expectations: [
      exp(
        'root-cause',
        'The investigation points at a lost-update / concurrent-write race (last-write-wins, no version check) — confirm and frame it as the likely root cause.',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'Restate the investigator’s finding as the working hypothesis instead of asking generic questions.',
          matchHints: [
            'last write wins',
            'lost update',
            'concurrent',
            'race',
            'version check',
            'optimistic',
          ],
        },
      ),
      exp(
        'repro-multitab',
        'Targeted repro: two tabs / web + mobile editing the same document, confirming the overlap window.',
        {
          impact: 4,
          trickiness: 3,
          matchHints: [
            'two tabs',
            'multiple tabs',
            'web and mobile',
            'same document',
            'concurrent edit',
          ],
        },
      ),
      exp(
        'data-recovery',
        'Is the overwritten version recoverable (history/audit), and how many customers/documents are affected so far?',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'Data-loss bugs need a recovery/containment question, not just a fix — frequently missed under time pressure.',
          matchHints: [
            'recover',
            'restore',
            'version history',
            'audit',
            'how many affected',
            'blast radius',
          ],
        },
      ),
      exp(
        'not-every-time',
        'Explain "not every time": it only manifests on overlapping concurrent saves, not on a single editor.',
        {
          impact: 3,
          trickiness: 2,
          matchHints: ['not every time', 'intermittent', 'only when', 'overlap'],
        },
      ),
    ],
    notes:
      'With an investigation attached, the skill is synthesizing it (root cause) and adding the recovery/blast-radius question — not re-asking what is already known.',
  },
]
