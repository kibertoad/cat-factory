import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// requirements-review fixtures. The payload is a `RequirementsContext`:
// `{ block: { title, type, description }, docs: [], tasks: [] }`. Each spec is a real,
// under-specified requirement; the expectations are the gaps/ambiguities/risks a strong
// reviewer should raise, graded by how bad they are to miss (impact) and how hard they
// are to spot (trickiness).

export const REQUIREMENTS_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'req-notify-prefs-simple',
    agentKind: 'requirements-review',
    kind: 'requirements',
    name: 'Notification preferences (simple)',
    difficulty: 'simple',
    summary: 'A thin "let users mute notifications" spec with obvious unanswered questions.',
    payload: {
      block: {
        title: 'Notification preferences',
        type: 'service',
        description:
          'Let users turn off notifications they do not want. Add a settings page where they can toggle notifications on or off.',
      },
      docs: [],
      tasks: [],
    },
    expectations: [
      exp('channels', 'Which channels are in scope (email, push, in-app, SMS)?', {
        impact: 4,
        trickiness: 1,
        detail: 'A single on/off toggle is meaningless without knowing what it governs.',
        matchHints: ['channel', 'email', 'push', 'in-app', 'sms'],
      }),
      exp(
        'default-state',
        'What is the default state for a new user / a newly added notification type?',
        {
          impact: 3,
          trickiness: 2,
          matchHints: ['default state', 'default value', 'opt-in', 'opt in', 'opt-out', 'opt out'],
        },
      ),
      exp('granularity', 'Global on/off vs per-category preferences — the spec conflates them.', {
        impact: 3,
        trickiness: 3,
        detail:
          '"notifications they do not want" implies per-type control, but the UI describes one toggle.',
        matchHints: ['per-category', 'per category', 'granularity', 'per-type', 'per type'],
      }),
      exp(
        'transactional',
        'Are critical/transactional messages (security alerts, password resets) exempt from muting?',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'Letting users mute security alerts is a real safety/compliance gap that is easy to overlook.',
          matchHints: ['transactional', 'security alert', 'critical', 'mandatory'],
        },
      ),
    ],
    notes:
      'The transactional-exemption item is the high-trickiness "wow" catch; the channel-scope item is the high-impact must-find.',
  },
  {
    id: 'req-csv-export-moderate',
    agentKind: 'requirements-review',
    kind: 'requirements',
    name: 'CSV export (moderate)',
    difficulty: 'moderate',
    summary: 'An "export my data to CSV" feature that omits scale, auth, and format details.',
    payload: {
      block: {
        title: 'Export report to CSV',
        type: 'api',
        description:
          'Add a button that lets a user export their transactions report as a CSV file so they can open it in Excel. The export should include all of their transactions.',
      },
      docs: [],
      tasks: [],
    },
    expectations: [
      exp(
        'volume',
        'How many rows can "all transactions" be — does it need streaming/pagination or a background job?',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'A synchronous in-memory export silently breaks for large accounts; this is the most impactful gap.',
          matchHints: [
            'how many rows',
            'large',
            'streaming',
            'background job',
            'pagination',
            'timeout',
          ],
        },
      ),
      exp(
        'authz',
        'What stops a user exporting another user’s transactions — how is ownership enforced?',
        {
          impact: 5,
          trickiness: 2,
          matchHints: ['authorization', 'ownership', 'access control', 'another user', 'tenant'],
        },
      ),
      exp(
        'encoding',
        'CSV specifics: delimiter, encoding (UTF-8 BOM for Excel), quoting, and date/number formatting.',
        {
          impact: 3,
          trickiness: 2,
          detail: 'Excel mangles UTF-8 without a BOM and misreads locale-formatted numbers/dates.',
          matchHints: ['encoding', 'utf-8', 'utf8', 'delimiter', 'bom', 'quoting', 'escaping'],
        },
      ),
      exp(
        'injection',
        'CSV/formula injection: a cell starting with =, +, -, @ executes when opened in Excel.',
        {
          impact: 4,
          trickiness: 5,
          detail:
            'A genuine security issue ("CSV injection") almost no one raises — the standout catch.',
          matchHints: [
            'csv injection',
            'formula injection',
            'starts with =',
            'spreadsheet injection',
          ],
        },
      ),
    ],
    notes:
      'CSV/formula injection is the trick item; the row-volume and authorization items are the must-finds.',
  },
  {
    // The one fixture that IDENTIFIES its product (a `service` context). `buildReviewPrompt` drops
    // its "do not pick a system" note when the product is stated, so this is the only fixture that
    // exercises the identified path, and a reviewer that still hedges about which system this is
    // has ignored what it was given.
    id: 'req-bulk-invite-moderate',
    agentKind: 'requirements-review',
    kind: 'requirements',
    name: 'Bulk teammate invites (moderate)',
    difficulty: 'moderate',
    summary:
      'An "invite the whole team at once" spec whose abuse and collision cases are unstated.',
    payload: {
      block: {
        title: 'Invite teammates in bulk',
        type: 'api',
        description:
          'Let an admin paste a list of email addresses and invite them all to the workspace at ' +
          'once. Each person gets an email with a link to join. Today they have to be invited one ' +
          'at a time, which is painful when onboarding a new team.',
      },
      docs: [],
      tasks: [],
      service: {
        stated: true,
        frameId: 'frame-workspaces',
        title: 'Workspaces',
        description: 'Workspace membership, roles and invitations.',
      },
    },
    expectations: [
      exp('who-and-what-role', 'Who may bulk-invite, and what role does an invitee land on?', {
        impact: 5,
        trickiness: 2,
        detail:
          'The spec says "an admin" without saying whether an invitee can be given a role, let ' +
          'alone an admin role, which is a privilege-escalation question dressed as onboarding.',
        matchHints: ['role', 'permission', 'who can', 'admin', 'privilege', 'member'],
      }),
      exp(
        'existing-and-pending',
        'What happens to an address that is already a member, already invited, or was previously removed?',
        {
          impact: 4,
          trickiness: 2,
          matchHints: [
            'already a member',
            'already invited',
            'duplicate',
            'pending',
            'previously removed',
            'existing',
          ],
        },
      ),
      exp(
        'partial-failure',
        'If some addresses are invalid, is the whole batch rejected or are the good ones invited?',
        {
          impact: 4,
          trickiness: 3,
          detail:
            'A bulk operation has to state its all-or-nothing rule, and the answer is a product ' +
            'decision (what the admin sees) before it is a technical one.',
          matchHints: [
            'partial',
            'all or nothing',
            'some fail',
            'invalid address',
            'reject the whole',
            'per-address',
          ],
        },
      ),
      exp(
        'spam-relay',
        'A bulk invite sends attacker-chosen email from our domain with attacker-chosen recipients: what caps the batch size and rate?',
        {
          impact: 4,
          trickiness: 5,
          detail:
            'The standout catch. Nobody reads "invite the whole team" as "a mail-sending endpoint ' +
            'aimed at arbitrary strangers", but that is what it is, and the reputational damage lands ' +
            'on our sending domain. It stays a PRODUCT question when phrased as a limit, not a ' +
            'throttling design.',
          matchHints: [
            'spam',
            'abuse',
            'how many',
            'batch size',
            'rate limit',
            'reputation',
            'arbitrary recipients',
            'unsolicited',
          ],
        },
      ),
      exp(
        'invite-expiry',
        'How long is an invite link valid, can it be re-sent or revoked, and is it single-use?',
        {
          impact: 3,
          trickiness: 2,
          matchHints: ['expir*', 'expiry', 'revoke', 'resend', 're-send', 'single use', 'reusable'],
        },
      ),
    ],
    notes:
      'The spam-relay framing is the trick item and the one most reviewers miss entirely; the ' +
      'role question is the high-impact must-find because it is a permissions decision in disguise.',
  },
  {
    id: 'req-billing-proration-complex',
    agentKind: 'requirements-review',
    kind: 'requirements',
    name: 'Mid-cycle plan change billing (complex)',
    difficulty: 'complex',
    summary:
      'A subscription plan-change spec dense with proration, timezone, and currency edge cases.',
    payload: {
      block: {
        title: 'Mid-cycle plan upgrades and downgrades',
        type: 'service',
        description: [
          'Let a customer change their subscription plan at any time. When they upgrade, charge them the',
          'difference for the rest of the billing cycle. When they downgrade, credit the difference toward',
          'their next invoice. The change takes effect immediately. Plans are billed monthly on the date the',
          'customer first subscribed.',
        ].join(' '),
      },
      docs: [],
      tasks: [],
    },
    expectations: [
      exp(
        'proration-basis',
        'How is the prorated amount computed — by remaining days, seconds, or a fixed fraction — and how are partial-cent results rounded?',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'Rounding/credit accumulation across repeated mid-cycle changes is where real billing bugs and revenue leakage hide; the standout catch.',
          matchHints: [
            'proration',
            'prorat*',
            'rounding',
            'round',
            'partial cent',
            'remaining days',
          ],
        },
      ),
      exp(
        'cycle-anchor',
        'Billing on "the date the customer subscribed" is undefined for the 29th–31st in short months.',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'Anniversary billing on Jan 31 has no Feb 31 — the cycle-anchor rule must be pinned down.',
          matchHints: [
            '29th',
            '30th',
            '31st',
            'short month',
            'anniversary',
            'last day of the month',
          ],
        },
      ),
      exp(
        'timezone',
        'In which timezone is "immediately" / the cycle boundary evaluated (customer, merchant, UTC)?',
        {
          impact: 4,
          trickiness: 4,
          matchHints: ['timezone', 'time zone', 'utc', 'midnight'],
        },
      ),
      exp(
        'downgrade-credit',
        'Credit vs refund: is a downgrade credit refundable, does it expire, and what if it exceeds the next invoice?',
        {
          impact: 4,
          trickiness: 2,
          matchHints: ['credit', 'refund', 'exceed*', 'expir*'],
        },
      ),
      exp(
        'currency',
        'No mention of currency, tax/VAT recomputation, or multi-currency accounts.',
        {
          impact: 3,
          trickiness: 2,
          matchHints: ['currency', 'tax', 'vat'],
        },
      ),
      exp(
        'payment-failure',
        'What happens if the immediate upgrade charge fails — is the plan change rolled back or left active unpaid?',
        {
          impact: 5,
          trickiness: 3,
          matchHints: ['payment fails', 'charge fails', 'declined', 'rolled back', 'rollback'],
        },
      ),
    ],
    notes:
      'A deliberately dense spec: proration rounding (trick + impact) is the headline; payment-failure handling and cycle-anchor are the high-impact must-finds.',
  },
]
