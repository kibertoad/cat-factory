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
        matchHints: ['how slow', 'quantif*', 'load time', 'response time', 'baseline', 'measured'],
      }),
      exp(
        'regression-window',
        '"Fine before" — when did it regress, and what changed (deploy, data growth) around then?',
        {
          impact: 4,
          // Raised to 4: this fixture's own notes call it the higher-skill catch, and with nothing
          // rated tricky the whole fixture scored a flat wowBonus of 1 for every answer, so it
          // ranked a thorough triage exactly level with one that only asked for repro steps.
          trickiness: 4,
          detail:
            'Pinning the regression window is the highest-leverage triage question and is easy to skip past.',
          matchHints: ['when did', 'regress*', 'started', 'deploy', 'recently'],
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
            'separat*',
            'distinct',
            'conflat*',
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
    // A money bug, which is the case where containment outranks diagnosis: the triage that only asks
    // for reproduction steps leaves customers overcharged while the repro is gathered.
    id: 'clarity-double-charge-moderate',
    agentKind: 'clarity-review',
    kind: 'clarity',
    name: 'Customers charged twice (moderate)',
    difficulty: 'moderate',
    summary: 'A billing report whose stated symptom may not be the actual symptom.',
    payload: {
      block: {
        title: 'Some customers were charged twice',
        type: 'service',
        description: [
          'Support has had four tickets this week from customers saying they were charged twice for',
          'their subscription. One of them sent a screenshot of two identical lines on their card',
          'statement. It seems to have started around the beginning of the month. Please look into it',
          'urgently, people are asking for refunds.',
        ].join(' '),
      },
      service: {
        stated: true,
        frameId: 'frame-billing',
        title: 'Billing',
        description: 'Subscriptions, invoicing, payment capture and credits.',
      },
    },
    expectations: [
      exp(
        'containment-first',
        'How many customers and how much money: is it four or four hundred, and have refunds been issued or is the charge still standing?',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'The must-find. Four tickets is a lower bound on a population nobody has queried, and a ' +
            'money bug needs its blast radius and its remediation decided before the root cause.',
          matchHints: [
            'how many',
            'how much',
            'affected',
            'blast radius',
            'refund',
            'query the',
            'total amount',
            'still charged',
          ],
        },
      ),
      exp(
        'identify-the-charges',
        'Which exact charges: ids, amounts, timestamps and the subscription they belong to.',
        {
          impact: 5,
          trickiness: 1,
          matchHints: [
            'charge id',
            'transaction id',
            'exact',
            'timestamps',
            'amounts',
            'which charges',
            'payment id',
          ],
        },
      ),
      exp(
        'symptom-may-be-wrong',
        'Two statement lines are not proof of two charges: an authorization hold beside a capture, or a card-network re-presentment, looks identical to a customer.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The standout catch, and the reason this report is dangerous rather than merely vague. ' +
            'A triage that accepts "charged twice" as the symptom sends an engineer hunting a ' +
            'duplicate-charge bug that may not exist, while the real question is whether our ledger ' +
            'shows one charge or two.',
          matchHints: [
            'authorization',
            'authoriz*',
            'hold',
            'pending',
            'pre-auth',
            'capture',
            'only one charge',
            'our records',
            'ledger',
            'actually charged twice',
          ],
        },
      ),
      exp(
        'retry-idempotency-hypothesis',
        'If our ledger does show two charges, the likely cause is a retried payment attempt with no idempotency key.',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'The right hypothesis to state, and one worth stating conditionally rather than as a ' +
            'conclusion, since it only applies if the previous question comes back "yes, two".',
          matchHints: [
            'idempoten*',
            'retry',
            'retried',
            'duplicate request',
            'timeout',
            'webhook',
            'processed twice',
          ],
        },
      ),
      exp(
        'regression-window',
        '"Around the beginning of the month" needs pinning: what changed then, and does it coincide with the billing run?',
        {
          impact: 4,
          trickiness: 3,
          matchHints: [
            'when exactly',
            'what changed',
            'deploy',
            'billing run',
            'renewal date',
            'first of the month',
            'regress*',
          ],
        },
      ),
    ],
    notes:
      'The fixture that rewards doubting the reported symptom. Containment is the must-find; ' +
      'questioning whether a double charge happened at all is the catch almost nobody makes.',
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
            'recover*',
            'restor*',
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
          matchHints: ['not every time', 'intermittent', 'only when', 'overlap*'],
        },
      ),
    ],
    notes:
      'With an investigation attached, the skill is synthesizing it (root cause) and adding the recovery/blast-radius question — not re-asking what is already known.',
  },
]
