import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// requirements-writer fixtures. The payload carries the three things
// `buildRecommendationPrompt` needs: the `RequirementsContext` under review, the `findings` to
// answer (one recommendation per id), and the `grounding` material in the Writer's own precedence
// order (team standards → in-repo spec excerpts → web results).
//
// What makes these fixtures different from the reviewer ones is that the Writer's output is judged
// as much on its SELF-REPORTS as on its answers. `groundedIn` is the provenance a human checks
// before trusting a suggestion, and `confidence` is what an unattended run compares against its
// auto-answer floor (ADR 0053) before adopting an answer with nobody reading it. So the grounding is
// varied deliberately across the three: one finding a standard settles outright, one the project's
// own spec settles, and several that rest on nothing but general practice. A Writer that cites a
// standard it was not given, or reports high confidence on a question about this business it was
// never told about, is the failure these fixtures exist to expose.

/** One finding for the Writer to answer, in the stored review-item shape. */
function finding(
  id: string,
  title: string,
  detail: string,
  over: {
    category?: string
    severity?: string
    autoAnswerable?: boolean
  } = {},
): Record<string, unknown> {
  return {
    id,
    category: over.category ?? 'gap',
    severity: over.severity ?? 'medium',
    title,
    detail,
    status: 'recommend_requested',
    reply: null,
    autoAnswerable: over.autoAnswerable ?? true,
    createdAt: 0,
    updatedAt: 0,
  }
}

export const ANSWER_RECOMMENDATION_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'writer-session-timeout-simple',
    agentKind: 'requirements-writer',
    kind: 'answer-recommendation',
    name: 'Session timeout defaults (simple)',
    difficulty: 'simple',
    summary: 'Two findings a team standard settles outright, plus one it does not.',
    payload: {
      block: {
        title: 'Sign users out after a period of inactivity',
        type: 'service',
        description:
          'Sign a user out when they have been inactive for a while, so an unattended browser does ' +
          'not stay signed in. Warn them shortly before it happens.',
      },
      docs: [],
      tasks: [],
      service: {
        stated: true,
        frameId: 'frame-console',
        title: 'Customer console',
        description: 'The signed-in web console customers manage their account from.',
      },
      findings: [
        finding(
          'timeout-length',
          'How long is "a while"?',
          'The spec asks for an inactivity sign-out but names no duration.',
          { severity: 'high' },
        ),
        finding(
          'warning-lead',
          'How long before the sign-out is the warning shown?',
          '"Shortly before" is not a duration a build can implement.',
        ),
        finding(
          'billing-exception',
          'Should a user mid-way through a checkout flow be signed out?',
          'Signing someone out during payment loses the transaction; keeping them in weakens the ' +
            'protection. This is a business trade-off.',
          { category: 'question', severity: 'high', autoAnswerable: false },
        ),
      ],
      grounding: {
        fragments: [
          {
            id: 'std-session-policy',
            title: 'Session and inactivity policy',
            body:
              'Signed-in sessions in customer-facing products expire after 30 minutes of ' +
              'inactivity. A warning dialog is shown 2 minutes before expiry and offers to extend ' +
              'the session. Sessions never expire while a request is in flight.',
          },
        ],
        specExcerpts: [],
        webResults: [],
      },
    },
    expectations: [
      exp('cites-standard', 'Answers the timeout from the standard and names it as the source.', {
        impact: 5,
        trickiness: 1,
        detail:
          'The standard states 30 minutes outright. Answering with a different number, or with the ' +
          'right number but `groundedIn: general-practice`, both fail: the first ignores the ' +
          'precedence rule, the second under-reports provenance a human would have trusted.',
        matchHints: ['30 minutes', 'thirty minutes', 'std-session-policy', 'standard'],
      }),
      exp('warning-lead-from-standard', 'Takes the 2-minute warning lead from the same standard.', {
        impact: 4,
        trickiness: 2,
        matchHints: ['2 minutes', 'two minutes', 'warning', 'before expiry'],
      }),
      exp(
        'checkout-needs-owner',
        'Flags the checkout exception as a business decision and rates its confidence low.',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'The calibration test. Nothing the Writer was given settles whether payment beats ' +
            'security here, so a high-confidence answer invites an unattended run to adopt it with ' +
            'nobody reading it. The honest move is a concrete default at LOW confidence.',
          matchHints: [
            'business decision',
            'product owner',
            'low confidence',
            'not confident',
            'cannot be sure',
            'depends on',
            'needs a decision',
          ],
        },
      ),
      exp(
        'in-flight-rule',
        'Notices the standard already answers part of the checkout case: a session never expires while a request is in flight.',
        {
          impact: 3,
          trickiness: 5,
          detail:
            'The standout catch: the standard is not silent on the trade-off, it partly settles it. ' +
            'Reading a constraint out of the grounding rather than only matching a number is the ' +
            'skill.',
          matchHints: [
            'in flight',
            'in-flight',
            'request is in flight',
            'active request',
            'while a request',
          ],
        },
      ),
    ],
    notes:
      'The standard-settles-it case. The trap is the third finding: it looks answerable and is not, ' +
      'and the standard supplies a partial constraint that a careless read misses entirely.',
  },
  {
    id: 'writer-retention-moderate',
    agentKind: 'requirements-writer',
    kind: 'answer-recommendation',
    name: 'Data retention window (moderate)',
    difficulty: 'moderate',
    summary:
      'The project spec settles one finding; the rest rest on general practice and must say so.',
    payload: {
      block: {
        title: 'Let a customer delete their account and data',
        type: 'service',
        description:
          'A customer should be able to delete their account from the settings page and have their ' +
          'data removed. We need to honour deletion requests.',
      },
      docs: [],
      tasks: [],
      service: {
        stated: true,
        frameId: 'frame-accounts',
        title: 'Accounts',
        description: 'Account lifecycle, authentication and profile data.',
      },
      findings: [
        finding(
          'grace-period',
          'Is deletion immediate, or is there a window to change their mind?',
          'The spec says "removed" without saying when, and an accidental deletion is unrecoverable ' +
            'if it is immediate.',
          { severity: 'high' },
        ),
        finding(
          'audit-conflict',
          'What happens to records we are required to keep, such as invoices and audit entries?',
          'Deleting everything conflicts with keeping financial records; keeping everything is not ' +
            'deletion. The boundary needs stating.',
          { category: 'risk', severity: 'high' },
        ),
        finding(
          'shared-content',
          'What happens to content the deleted user shared with colleagues?',
          'Removing it breaks their teammates’ work; leaving it means the user’s content ' +
            'outlives their account.',
          { category: 'clarification', autoAnswerable: false },
        ),
      ],
      grounding: {
        fragments: [],
        specExcerpts: [
          '# spec/accounts.md\n\nThe system SHALL retain issued invoices and their line items for ' +
            'seven years from the date of issue, independently of the account they belong to. An ' +
            'invoice SHALL remain retrievable after the account is closed.',
        ],
        webResults: [],
      },
    },
    expectations: [
      exp(
        'invoices-from-spec',
        'Answers the audit conflict from the project spec: invoices are retained seven years, independently of the account.',
        {
          impact: 5,
          trickiness: 2,
          detail:
            'The spec settles it outright, so the answer must come from there and report ' +
            '`project-spec`, not `general-practice`.',
          matchHints: ['seven years', '7 years', 'invoice', 'retain', 'project-spec', 'spec/'],
        },
      ),
      exp(
        'grace-period-default',
        'Gives a concrete grace-period default rather than "it depends", and labels it general practice.',
        {
          impact: 4,
          trickiness: 3,
          detail:
            'Nothing in the grounding names a window, so the honest report is `general-practice`. ' +
            'A concrete number (commonly 30 days) is still required: hedging is the failure the ' +
            '`answer_concreteness` dimension scores.',
          matchHints: [
            'grace period',
            '30 days',
            'thirty days',
            'general practice',
            'general-practice',
            'reversible',
            'soft delete',
          ],
        },
      ),
      exp(
        'no-invented-standard',
        'Does not attribute an answer to a standard or regulation it was not given.',
        {
          impact: 5,
          trickiness: 4,
          detail:
            'The provenance test, and the one that matters most: a suggestion that cites a named ' +
            'regulation looks far more authoritative in the answer box than the guess it actually ' +
            'is. There are no standards in this fixture’s grounding at all.',
          matchHints: [
            'general practice',
            'general-practice',
            'not from a standard',
            'no standard',
            'own knowledge',
            'no specific standard',
          ],
        },
      ),
      exp(
        'shared-content-owner',
        'Treats the shared-content question as one the business must own, at low confidence.',
        {
          impact: 4,
          trickiness: 3,
          matchHints: [
            'low confidence',
            'business decision',
            'product owner',
            'depends on',
            'needs a decision',
            'cannot decide',
          ],
        },
      ),
      exp(
        'no-technical-design',
        'Keeps every answer at the product level: no schema, no soft-delete column, no job scheduler.',
        {
          impact: 3,
          trickiness: 4,
          detail:
            'Deletion invites a design answer. The Writer is explicitly told the Architect owns ' +
            'that, so specifying HOW is a scope violation even when the design is sensible.',
          matchHints: [
            'product level',
            'architect',
            'not a technical',
            'business decision',
            'behaviour',
            'policy',
          ],
        },
      ),
    ],
    notes:
      'The provenance fixture. One finding the spec settles, one that needs a concrete default from ' +
      'general knowledge honestly labelled, and one that belongs to a person.',
  },
  {
    id: 'writer-sla-credits-complex',
    agentKind: 'requirements-writer',
    kind: 'answer-recommendation',
    name: 'Uptime credits policy (complex)',
    difficulty: 'complex',
    summary:
      'A standard and the project spec DISAGREE, and most findings turn on unstated commercials.',
    payload: {
      block: {
        title: 'Service-credit scheme for missed uptime commitments',
        type: 'service',
        description:
          'When we miss our uptime commitment in a month, affected customers should get service ' +
          'credits automatically instead of having to ask. Sales wants this in the next contract ' +
          'cycle.',
      },
      docs: [],
      tasks: [],
      service: {
        stated: true,
        frameId: 'frame-billing',
        title: 'Billing',
        description: 'Subscriptions, invoicing and credits.',
      },
      findings: [
        finding(
          'credit-scale',
          'What credit does each level of downtime earn?',
          'The spec says "credits" with no schedule tying downtime to a credit amount.',
          { severity: 'high' },
        ),
        finding(
          'measurement-window',
          'Over what window is uptime measured, and does planned maintenance count against it?',
          'A monthly figure and a rolling figure produce different results, and excluded ' +
            'maintenance changes the answer again.',
          { category: 'clarification', severity: 'high' },
        ),
        finding(
          'credit-cap',
          'Is there an upper bound on credits in a single month?',
          'An uncapped scheme can exceed the customer’s own monthly fee during a long outage.',
          { category: 'risk', severity: 'high' },
        ),
        finding(
          'eligibility',
          'Which customers are eligible: everyone, or only those on a contract with an uptime commitment?',
          'Applying it to self-serve customers who were never promised an SLA is a commercial ' +
            'decision.',
          { category: 'question', autoAnswerable: false },
        ),
      ],
      grounding: {
        fragments: [
          {
            id: 'std-sla-credits',
            title: 'Service-level commitments and credits',
            body:
              'Uptime is measured per calendar month. Below 99.9% earns a 10% credit; below 99.0% ' +
              'earns 25%; below 95.0% earns 50%. Credits are capped at 50% of the monthly fee for ' +
              'the affected service. Scheduled maintenance announced at least 5 days in advance is ' +
              'excluded from the calculation.',
          },
        ],
        specExcerpts: [
          '# spec/billing.md\n\nA credit SHALL be applied to the next invoice and SHALL NOT exceed ' +
            'the invoice total. Credits SHALL NOT be paid out in cash and SHALL expire 12 months ' +
            'after issue.',
          '# tech-spec/uptime.md\n\nAvailability is computed from the external probe results ' +
            'aggregated over a rolling 30-day window.',
        ],
        webResults: [],
      },
    },
    expectations: [
      exp(
        'credit-scale-from-standard',
        'Takes the credit schedule from the standard (10% / 25% / 50%) and names it as the source.',
        {
          impact: 5,
          trickiness: 1,
          matchHints: ['10%', '25%', '50%', 'std-sla-credits', 'standard', 'credit schedule'],
        },
      ),
      exp(
        'window-conflict',
        'Notices the standard says calendar month while the tech-spec computes a rolling 30-day window, and does not silently pick one.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The standout catch. Both grounding sources are authoritative and they disagree, so ' +
            'answering confidently from either one hides a contradiction that would surface as a ' +
            'billing dispute. The honest answer names the conflict and asks which governs.',
          matchHints: [
            'conflict',
            'disagree',
            'inconsistent',
            'calendar month',
            'rolling',
            'contradict',
            'differ',
          ],
        },
      ),
      exp(
        'cap-interaction',
        'Reconciles the two caps: the standard caps at 50% of the fee, the spec caps at the invoice total.',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'Both apply, and the binding one is whichever is lower. Quoting only the standard’s ' +
            'cap drops a constraint the project already committed to.',
          matchHints: ['50%', 'invoice total', 'whichever is lower', 'both', 'cap', 'exceed'],
        },
      ),
      exp(
        'maintenance-exclusion',
        'Carries over the 5-day maintenance-notice exclusion rather than leaving maintenance undefined.',
        {
          impact: 3,
          trickiness: 3,
          matchHints: ['maintenance', '5 days', 'five days', 'announced', 'excluded'],
        },
      ),
      exp(
        'eligibility-is-commercial',
        'Refuses to settle eligibility itself: it is a commercial decision, rated low confidence.',
        {
          impact: 4,
          trickiness: 2,
          matchHints: [
            'commercial',
            'sales',
            'low confidence',
            'business decision',
            'contract',
            'needs a decision',
          ],
        },
      ),
      exp(
        'no-cash-payout',
        'Honours the spec rule that credits are never paid in cash and expire after 12 months.',
        {
          impact: 3,
          trickiness: 3,
          matchHints: ['cash', 'not paid out', 'next invoice', '12 months', 'expir*'],
        },
      ),
    ],
    notes:
      'The hardest of the three: the grounding is rich AND self-contradictory, so a Writer that ' +
      'simply pattern-matches the standard produces a confident answer that is wrong on the one ' +
      'question a billing dispute would turn on.',
  },
]
