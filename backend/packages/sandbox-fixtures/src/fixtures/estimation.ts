import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// task-estimator fixtures. The payload is a `task-estimator` `AgentRunContext`: the clarified
// requirements arrive as the block, and the earlier steps' output (the requirements-review
// incorporation, the spec-writer's increment) as `priorOutputs`, exactly as the engine hands them
// over. The estimator returns ONLY {"complexity","risk","impact","rationale"}, each axis 0..1.
//
// Grading a set of numbers needs the expectations to live in the RATIONALE, which is where the
// estimator's reasoning is observable: each expectation names a driver the rationale has to have
// noticed. That is also the honest scope of the objective scorer here, since a bare number carries
// no evidence at all. The `estimation` rubric's `calibration` dimension is what judges the values.
//
// The three fixtures are deliberately chosen to break the axes APART, because collapsing them is the
// characteristic failure: a trivial one-line change with a system-wide blast radius, an intricate
// build that is safe because nothing consumes it yet, and one that is genuinely high on all three.

/** Build a task-estimator context: the task to triage plus the upstream steps' output. */
function estimatorContext(
  block: { title: string; type: string; description: string },
  priorOutputs: { agentKind: string; output: string }[],
): Record<string, unknown> {
  return {
    agentKind: 'task-estimator',
    pipelineName: 'sandbox',
    stepIndex: 2,
    isFinalStep: false,
    block,
    priorOutputs,
    decisions: [],
    resolvedDecision: null,
  }
}

export const ESTIMATION_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'estimate-copy-tweak-simple',
    agentKind: 'task-estimator',
    kind: 'estimation',
    name: 'Marketing copy tweak (simple)',
    difficulty: 'simple',
    summary: 'A genuinely trivial, low-blast-radius change: the low anchor the scale needs.',
    payload: estimatorContext(
      {
        title: 'Reword the empty-state text on the reports page',
        type: 'frontend',
        description:
          'Change the empty-state message on the reports page from "No data" to "No reports yet. ' +
          'Create one to get started." Marketing has signed off on the wording. English only; the ' +
          'other locales are handled by the translation vendor on their own schedule.',
      },
      [
        {
          agentKind: 'requirements-review',
          output:
            'Requirements are settled: the exact string is given, the surface is one component, ' +
            'and non-English locales are explicitly out of scope.',
        },
      ],
    ),
    expectations: [
      exp('single-surface', 'One string in one component: nothing else reads or derives it.', {
        impact: 4,
        trickiness: 1,
        detail:
          'The whole point of the fixture. An estimator that cannot score this near zero has no ' +
          'usable scale, which makes every gate built on its thresholds meaningless.',
        matchHints: ['one string', 'single string', 'one component', 'copy change', 'trivial'],
      }),
      exp(
        'no-behaviour-change',
        'No behaviour, data or contract changes, so nothing can regress.',
        {
          impact: 3,
          trickiness: 2,
          matchHints: [
            'no behaviour change',
            'no behavior change',
            'no logic',
            'cosmetic',
            'presentational',
            'nothing can break',
          ],
        },
      ),
      exp('locale-scoped-out', 'Translations are explicitly out of scope, so no fan-out follows.', {
        impact: 2,
        trickiness: 3,
        detail: 'A tempting reason to inflate the scores; the description rules it out.',
        matchHints: ['out of scope', 'english only', 'translation', 'locale', 'i18n'],
      }),
      exp(
        'shared-key',
        'The one thing that could make this NOT local: if the string is a shared catalog key another surface reuses, the change reaches those surfaces too.',
        {
          impact: 3,
          trickiness: 4,
          detail:
            'The tricky catch in an otherwise trivial task, and the honest tension in it: "one ' +
            'string" is only true if the key has one caller, which the task does not say. An ' +
            'estimator that notices the assumption it is making is doing something better than ' +
            'pattern-matching "copy change".',
          matchHints: [
            'shared key',
            'same key',
            'reused',
            'other surfaces',
            'catalog key',
            'elsewhere',
            'more than one place',
          ],
        },
      ),
    ],
    notes:
      'The low anchor. An estimator that returns middling scores here is anchoring rather than ' +
      'judging, which the `calibration` dimension is written to catch.',
  },
  {
    id: 'estimate-currency-rounding-moderate',
    agentKind: 'task-estimator',
    kind: 'estimation',
    name: 'Money rounding helper (moderate)',
    difficulty: 'moderate',
    summary: 'A one-line change with a system-wide blast radius: low complexity, high impact.',
    payload: estimatorContext(
      {
        title: 'Round monetary totals half-up instead of half-even',
        type: 'service',
        description:
          'Finance has asked that monetary totals round half-up (0.005 becomes 0.01) rather than ' +
          'the half-even behaviour we have today. The change is in `roundMoney()`, the shared ' +
          'helper. Invoices, refunds, payouts, tax lines and the exported ledger all call it.',
      },
      [
        {
          agentKind: 'requirements-review',
          output:
            'Product decision confirmed with Finance: half-up applies to all currencies and takes ' +
            'effect for new documents only. Already-issued invoices are not restated.',
        },
        {
          agentKind: 'spec-writer',
          output:
            'The system SHALL round every monetary total half-up. Given a total of 1.005, When it ' +
            'is rounded, Then the result SHALL be 1.01. Applies to invoices, refunds, payouts, tax ' +
            'lines and the exported ledger.',
        },
      ],
    ),
    expectations: [
      exp(
        'low-complexity',
        'The edit itself is one function and a handful of tests: complexity is genuinely low.',
        {
          impact: 4,
          trickiness: 2,
          detail:
            'Sizing this as complex because it is scary is the mistake the axis split exists to ' +
            'prevent.',
          matchHints: [
            'one function',
            'single function',
            'small change',
            'low complexity',
            'one line',
            'localised',
          ],
        },
      ),
      exp(
        'wide-blast-radius',
        'Every money surface calls the helper, so impact is high: invoices, refunds, payouts, tax and the ledger.',
        {
          impact: 5,
          trickiness: 2,
          detail:
            'This is the axis that must be high, and for the caller list rather than the size.',
          matchHints: [
            'blast radius',
            'every',
            'all callers',
            'invoices',
            'payouts',
            'ledger',
            'system-wide',
          ],
        },
      ),
      exp(
        'financial-correctness-risk',
        'Risk is high despite the small diff: wrong money is not caught by users, it is caught by an auditor.',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'Risk here comes from the DOMAIN, not the diff size. An estimator that ties risk to ' +
            'lines changed scores this low and lets the run skip the checks it most needs.',
          matchHints: [
            'financial',
            'audit',
            'reconcil*',
            'money',
            'incorrect amount',
            'silent',
            'hard to detect',
          ],
        },
      ),
      exp(
        'rounding-direction-asymmetry',
        'Half-up is not symmetric for negative amounts, so refunds and credits need deciding explicitly.',
        {
          impact: 4,
          trickiness: 5,
          detail:
            'The standout catch: -0.005 rounds to -0.01 under "half away from zero" and to 0.00 ' +
            'under "half up toward positive infinity", and refunds are exactly where negatives live.',
          matchHints: [
            'negative',
            'refund',
            'away from zero',
            'half up',
            'sign',
            'credit note',
            'asymmetr*',
          ],
        },
      ),
    ],
    notes:
      'The axis-splitting fixture: complexity low, impact and risk high. An estimator that returns ' +
      'three similar numbers fails `axis_independence` even if the average looks reasonable.',
  },
  {
    id: 'estimate-auth-migration-complex',
    agentKind: 'task-estimator',
    kind: 'estimation',
    name: 'Session-store migration (complex)',
    difficulty: 'complex',
    summary: 'High on all three axes, with a live cutover and no clean rollback.',
    payload: estimatorContext(
      {
        title: 'Move sessions from signed cookies to a server-side session store',
        type: 'service',
        description:
          'Replace our signed-cookie sessions with a server-side session store so we can revoke a ' +
          'session immediately. Every request path reads the session. Existing users must not be ' +
          'logged out. Mobile clients hold long-lived sessions and update slowly. The rollout is a ' +
          'rolling deploy, so both implementations will be live at once for a while.',
      },
      [
        {
          agentKind: 'requirements-review',
          output:
            'Confirmed: no forced logout, immediate revocation is the goal, and admin-initiated ' +
            'revocation must take effect within one second. Session lifetime stays at 30 days.',
        },
        {
          agentKind: 'spec-writer',
          output:
            'The system SHALL revoke a session within 1s of an admin request. Given a user with an ' +
            'active session, When an admin revokes it, Then the next request SHALL be rejected. The ' +
            'system SHALL accept sessions issued before this change until they expire.',
        },
      ],
    ),
    expectations: [
      exp(
        'dual-read-window',
        'Both session formats must be accepted during the rolling deploy and until old sessions expire.',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'The complexity driver: "no forced logout" plus a 30-day lifetime means a month-long ' +
            'dual-read window, not a cutover.',
          matchHints: [
            'both',
            'dual',
            'coexist',
            'rolling deploy',
            'backwards compatible',
            'old sessions',
            'transition',
          ],
        },
      ),
      exp(
        'hot-path-dependency',
        'Every request reads the session, so the store is now on the hottest path and its availability is the site’s.',
        {
          impact: 5,
          trickiness: 3,
          matchHints: [
            'every request',
            'hot path',
            'latency',
            'availability',
            'single point of failure',
            'store is down',
          ],
        },
      ),
      exp(
        'no-clean-rollback',
        'Rolling back after sessions are issued in the new format logs those users out: the rollback is not free.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The standout catch, and the one that should push RISK to the top: the usual mitigation ' +
            '("revert if it goes wrong") is itself a user-visible incident here.',
          matchHints: [
            'roll back',
            'rollback',
            'revert',
            'cannot undo',
            'irreversible',
            'log everyone out',
            'forward only',
          ],
        },
      ),
      exp(
        'mobile-lag',
        'Slow-updating mobile clients extend the compatibility window well past the deploy.',
        {
          impact: 3,
          trickiness: 4,
          matchHints: ['mobile', 'old client', 'app version', 'slow to update', 'long tail'],
        },
      ),
      exp(
        'security-surface',
        'This is the authentication path: a mistake is an auth bypass or a mass logout, not a cosmetic bug.',
        {
          impact: 5,
          trickiness: 2,
          matchHints: [
            'authentication',
            'auth bypass',
            'security',
            'session fixation',
            'lock out',
            'unauthorized',
          ],
        },
      ),
    ],
    notes:
      'The high anchor, and the one where all three axes genuinely belong near the top. The ' +
      'no-clean-rollback point is what separates a considered estimate from a plausible one.',
  },
]
