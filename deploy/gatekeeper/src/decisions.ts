// Every park the public surface can answer, as data.
//
// A run can stop on THIRTEEN different decision kinds, not one. The first cut of this Gatekeeper
// understood only `approval-gate`, so a card raised for a requirements review, a fork, a judge
// verdict or a follow-up triage arrived in the inbox and could never be answered from it: the
// answer path looked for a pending approval gate, found none, and reported the card stale while
// the run stayed blocked. The gap was invisible because a card that reports `stale` looks like a
// card whose run moved on.
//
// So the answer path does not know any kind. It reads the run's live decision list, finds the
// entry that is actually holding the run, and looks up the ANSWERER for its `kind` here. Adding a
// park to the platform means adding an entry below; there is no `switch` anywhere else, and
// the table is a `Record` the SDK's own kind union keys, so a kind the platform gains and this
// table lacks fails the build rather than shipping as a card nobody can answer.
//
// Two rules bind every entry:
//
//   - A VERB FORWARDS THROUGH A BINDING, never through a client of its own. `binding` names the
//     operation, the capability's `invoke` resolves it against what policy granted, and a tier
//     that was not granted it is refused there. The answer flow has no privilege.
//   - A MISSING INPUT IS A REFUSAL, never a default. `request-changes` with no feedback used to
//     forward an empty string, which the API rejects with a 422 the caller cannot read; a gate at
//     its rework cap used to default to `proceed`, silently picking the one settlement nobody
//     asked for. Every required field is declared and named back at the caller.

import type { PublicApiScope } from '@cat-factory/gatekeeper-bindings'
import type { PublicDecision } from '@cat-factory/sdk'
import { GatekeeperError } from './errors'

/**
 * Every kind of park the surface can list, taken from the SDK's own union.
 *
 * Typed rather than enumerated here so the table below is EXHAUSTIVE by construction: a kind the
 * platform gains fails this package's build until it has an answerer, instead of arriving in
 * production as a card whose first answer attempt reports it stale. That is the whole reason the
 * table is a `Record` keyed on the kind rather than an array of entries carrying one.
 */
export type ParkedDecisionKind = PublicDecision['kind']

/**
 * One entry in a run's decision list, read structurally.
 *
 * Deliberately NOT typed against the published `PublicDecision` union: this package reads a live
 * deployment's JSON, and a deployment one release ahead sends a kind (or a field) the union has
 * never heard of. Narrowing here would turn that into a decode failure at the one place whose job
 * is to say "the platform is holding this run on something I do not know how to answer".
 */
export interface LiveDecision {
  kind: string
  [field: string]: unknown
}

/** What one verb, applied to one live decision, asks the platform to do. */
export interface DecisionCall {
  binding: string
  args: Record<string, unknown>
}

/** One way of answering a kind of park. */
export interface DecisionVerb {
  /** What a caller passes as `action`. */
  action: string
  /** The binding this verb forwards through. Policy is enforced there, and only there. */
  binding: string
  /** One line an OS Gadget renders beside the verb. */
  summary: string
  /**
   * The caller-supplied fields this verb reads, with `required` naming the ones it refuses
   * without. Published on `approvals_inspect` so a caller composes a valid answer from the
   * capability itself rather than from a doc that can drift.
   */
  fields: readonly DecisionField[]
  /** Build the call. Throws {@link GatekeeperError} `invalid_answer` on a field it cannot read. */
  call: (decision: LiveDecision, input: AnswerFields) => DecisionCall
}

/** One caller-supplied field a verb reads. */
export interface DecisionField {
  name: string
  required: boolean
  /** The closed set of values, when there is one. */
  choices?: readonly string[]
  detail: string
}

/** What a caller sends beside `action`, by the platform's own field names. */
export type AnswerFields = Readonly<Record<string, unknown>>

/** How one kind of park is answered. Keyed by kind in {@link ANSWERERS}. */
export interface DecisionAnswerer {
  /** Prose an OS Gadget shows above the verbs. */
  summary: string
  /**
   * Whether this entry is CURRENTLY holding the run.
   *
   * A decision list carries settled entries too (a resolved gate keeps its record), so answering
   * the first entry of a kind would post against a park that is over. Every predicate reads the
   * entry's own lifecycle field, and an entry whose field is missing or unrecognised reads as NOT
   * pending: a park this package cannot confirm is one it must not answer blind.
   */
  pending: (decision: LiveDecision) => boolean
  verbs: readonly DecisionVerb[]
}

// ---- Reading the caller's fields ------------------------------------------------------------

function refuse(field: string, expected: string): never {
  throw new GatekeeperError(
    'invalid_answer',
    `This answer needs '${field}': ${expected}. Read the verb's own \`fields\` from ` +
      'approvals_inspect() rather than guessing; the platform refuses a blank one with a 422 ' +
      'that says less than this does.',
  )
}

/** A required non-blank string. */
function text(input: AnswerFields, field: string, expected: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) refuse(field, expected)
  return value
}

/** An optional string. Absent stays absent: an empty one is a value the API would reject. */
function optionalText(input: AnswerFields, field: string): Record<string, unknown> {
  const value = input[field]
  return typeof value === 'string' && value.length > 0 ? { [field]: value } : {}
}

/** A required member of a closed set. */
function choice(input: AnswerFields, field: string, allowed: readonly string[]): string {
  const value = input[field]
  if (typeof value !== 'string' || !allowed.includes(value)) {
    refuse(field, `one of ${allowed.map((option) => `'${option}'`).join(', ')}`)
  }
  return value
}

/** A required id the caller picks out of the decision (an item, a finding, a question). */
function pick(input: AnswerFields, field: string, from: string): string {
  return text(input, field, `the id of the ${from} this answer addresses`)
}

/** A string field of the live decision, or a refusal naming what the platform did not send. */
function fromDecision(decision: LiveDecision, field: string): string {
  const value = decision[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatekeeperError(
      'malformed_decision',
      `The parked '${decision.kind}' decision carries no '${field}', which every answer to it has ` +
        'to address. This is a platform-side shape this Gatekeeper does not recognise; upgrade it ' +
        'if the deployment is newer, and report it if not.',
    )
  }
  return value
}

// ---- Field declarations, shared where the platform shares a body --------------------------

const ITERATION_CAP_CHOICES = ['extra-round', 'proceed', 'stop-reset'] as const

const CAP_FIELDS: readonly DecisionField[] = [
  {
    name: 'choice',
    required: true,
    choices: ITERATION_CAP_CHOICES,
    detail:
      'One more pass, proceed with what the last pass produced, or stop and reset the task. ' +
      'There is deliberately no default: a parked run waits indefinitely, so picking one for you ' +
      'would ship work nobody approved.',
  },
]

const FINDINGS_FIELDS: readonly DecisionField[] = [
  {
    name: 'findings',
    required: true,
    detail: 'What is wrong. This text IS the prompt the fixer works from, so it cannot be blank.',
  },
]

function capVerb(action: string, binding: string, summary: string): DecisionVerb {
  return {
    action,
    binding,
    summary,
    fields: CAP_FIELDS,
    call: (decision, input) => ({
      binding,
      args: {
        ...pathOf(decision),
        body: { choice: choice(input, 'choice', ITERATION_CAP_CHOICES) },
      },
    }),
  }
}

/**
 * The path arguments an entry contributes to every call against it.
 *
 * Only `brainstorm` has one, and it is why this exists rather than being inlined: the stage is
 * part of the ROUTE for all six brainstorm verbs, and a block can hold a `requirements` and an
 * `architecture` session at once, so answering without it would settle whichever the platform
 * reached first.
 */
function pathOf(decision: LiveDecision): Record<string, unknown> {
  return decision.kind === 'brainstorm' ? { stage: fromDecision(decision, 'stage') } : {}
}

/** The shared verb set of the three iterative review loops (requirements / clarity / brainstorm). */
function reviewVerbs(bindings: {
  reply: string
  setStatus: string
  incorporate: string
  reReview: string
  proceed: string
  resolveExceeded: string
  item: string
}): readonly DecisionVerb[] {
  return [
    {
      action: 'reply',
      binding: bindings.reply,
      summary: `Answer one ${bindings.item}. This is what an incorporation folds in.`,
      fields: [
        { name: 'itemId', required: true, detail: `The ${bindings.item}'s stable id.` },
        { name: 'reply', required: true, detail: 'The answer, in prose.' },
      ],
      call: (decision, input) => ({
        binding: bindings.reply,
        args: {
          ...pathOf(decision),
          itemId: pick(input, 'itemId', bindings.item),
          body: { reply: text(input, 'reply', 'the answer to fold in') },
        },
      }),
    },
    {
      action: 'set-status',
      binding: bindings.setStatus,
      summary: `Dismiss a ${bindings.item} as not applicable, or reopen one dismissed by mistake.`,
      fields: [
        { name: 'itemId', required: true, detail: `The ${bindings.item}'s stable id.` },
        {
          name: 'status',
          required: true,
          choices: ['dismissed', 'open'],
          detail: 'The new status.',
        },
      ],
      call: (decision, input) => ({
        binding: bindings.setStatus,
        args: {
          ...pathOf(decision),
          itemId: pick(input, 'itemId', bindings.item),
          body: { status: choice(input, 'status', ['dismissed', 'open']) },
        },
      }),
    },
    {
      action: 'incorporate',
      binding: bindings.incorporate,
      summary:
        'Fold the recorded answers into one standardized document and re-review it. Asynchronous: ' +
        'the run stays parked until the next pass lands.',
      fields: [
        { name: 'feedback', required: false, detail: 'Optional "do it differently" steer.' },
      ],
      call: (decision, input) => ({
        binding: bindings.incorporate,
        args: { ...pathOf(decision), body: optionalText(input, 'feedback') },
      }),
    },
    {
      action: 're-review',
      binding: bindings.reReview,
      summary: 'Run another reviewer pass over the subject as it now stands.',
      fields: [],
      call: (decision) => ({ binding: bindings.reReview, args: pathOf(decision) }),
    },
    {
      action: 'proceed',
      binding: bindings.proceed,
      summary: 'Accept the subject as it stands and let the run advance.',
      fields: [],
      call: (decision) => ({ binding: bindings.proceed, args: pathOf(decision) }),
    },
    capVerb(
      'resolve-exceeded',
      bindings.resolveExceeded,
      'Settle a loop that spent its reviewer-pass budget.',
    ),
  ]
}

/** Whether an iterative review has stopped on a person. */
function reviewPending(decision: LiveDecision): boolean {
  return decision.status === 'ready' || decision.status === 'exceeded'
}

// ---- The table ------------------------------------------------------------------------------

/**
 * Every park, keyed by the kind that names it.
 *
 * `satisfies Record<ParkedDecisionKind, DecisionAnswerer>` is what makes this exhaustive AND
 * closed: a kind the platform adds fails the build here, and a key this file invents that the
 * surface does not have fails it too. Both matter, because either one produces the same symptom
 * in production (a park nobody can answer) from opposite causes.
 */
const ANSWERERS = {
  'approval-gate': {
    summary: 'A pipeline step finished and the run is holding its output in front of a person.',
    pending: (decision) => decision.status === 'pending',
    verbs: [
      {
        action: 'approve',
        binding: 'decisions_approve_step',
        summary: 'Let the output through, optionally replacing it with an edited proposal.',
        fields: [
          {
            name: 'proposal',
            required: false,
            detail:
              'Replaces the agent’s text and is what flows downstream. Omit to accept as written.',
          },
        ],
        call: (decision, input) => ({
          binding: 'decisions_approve_step',
          args: {
            approvalId: fromDecision(decision, 'approvalId'),
            body: optionalText(input, 'proposal'),
          },
        }),
      },
      {
        action: 'request-changes',
        binding: 'decisions_request_step_changes',
        summary: 'Send the step back to re-run with this guidance folded in.',
        fields: [
          {
            name: 'feedback',
            required: true,
            detail: 'The guidance the re-run works from. The platform refuses a blank one.',
          },
        ],
        call: (decision, input) => ({
          binding: 'decisions_request_step_changes',
          args: {
            approvalId: fromDecision(decision, 'approvalId'),
            body: { feedback: text(input, 'feedback', 'the guidance the re-run works from') },
          },
        }),
      },
      {
        action: 'reject',
        binding: 'decisions_reject_step',
        summary: 'Stop the run entirely. Terminal, though the board can retry it.',
        fields: [{ name: 'reason', required: false, detail: 'Why the run is being stopped.' }],
        call: (decision, input) => ({
          binding: 'decisions_reject_step',
          args: {
            approvalId: fromDecision(decision, 'approvalId'),
            body: optionalText(input, 'reason'),
          },
        }),
      },
      {
        action: 'resolve-exceeded',
        binding: 'decisions_resolve_step_exceeded',
        summary: 'Settle a companion gate parked at its automatic-rework cap.',
        fields: CAP_FIELDS,
        call: (decision, input) => ({
          binding: 'decisions_resolve_step_exceeded',
          args: {
            approvalId: fromDecision(decision, 'approvalId'),
            body: { choice: choice(input, 'choice', ITERATION_CAP_CHOICES) },
          },
        }),
      },
    ],
  },
  'agent-decision': {
    summary: 'Mid-work the agent hit a fork it would not choose unilaterally and asked.',
    // The projection carries no lifecycle field: an answered decision is not listed at all, so an
    // entry that is present is one that is waiting.
    pending: () => true,
    verbs: [
      {
        action: 'answer',
        binding: 'decisions_answer_agent_decision',
        summary: 'Answer the question. The asking step re-runs with the choice folded in.',
        fields: [
          {
            name: 'choice',
            required: true,
            detail:
              'Taken verbatim, so it need not be one of the offered `options` — but answering ' +
              'off-list hands the agent an approach it did not propose.',
          },
        ],
        call: (decision, input) => ({
          binding: 'decisions_answer_agent_decision',
          args: {
            decisionId: fromDecision(decision, 'decisionId'),
            body: { choice: text(input, 'choice', 'the answer the step re-runs with') },
          },
        }),
      },
    ],
  },
  fork: {
    summary: 'Materially different implementations were proposed before any code was written.',
    pending: (decision) => decision.status === 'awaiting_choice',
    verbs: [
      {
        action: 'choose',
        binding: 'decisions_choose_fork',
        summary: 'Pick a proposed approach, or supply your own.',
        fields: [
          {
            name: 'forkId',
            required: false,
            detail: 'One of the proposed forks. Exclusive with `custom`.',
          },
          {
            name: 'custom',
            required: false,
            detail: 'Your own approach, in prose. Exclusive with `forkId`.',
          },
          { name: 'note', required: false, detail: 'A steering note on a picked fork.' },
        ],
        call: (_decision, input) => {
          const forkId = optionalText(input, 'forkId')
          const custom = optionalText(input, 'custom')
          if ('forkId' in forkId === 'custom' in custom) {
            refuse(
              'forkId',
              'exactly one of `forkId` or `custom` (the platform enforces the same xor)',
            )
          }
          return {
            binding: 'decisions_choose_fork',
            args: { body: { ...forkId, ...custom, ...optionalText(input, 'note') } },
          }
        },
      },
    ],
  },
  judge: {
    summary: 'A rubric scored the work below the task’s threshold and the run stopped.',
    pending: (decision) => decision.status === 'awaiting_decision',
    verbs: [
      {
        action: 'resolve',
        binding: 'decisions_resolve_judge',
        summary: 'Proceed anyway, bounce the work back for rework, or stop the run.',
        fields: [
          {
            name: 'choice',
            required: true,
            choices: ['proceed', 'bounce', 'stop'],
            detail: 'What to do with the verdict.',
          },
          { name: 'feedback', required: false, detail: 'Guidance a `bounce` re-runs with.' },
        ],
        call: (_decision, input) => ({
          binding: 'decisions_resolve_judge',
          args: {
            body: {
              choice: choice(input, 'choice', ['proceed', 'bounce', 'stop']),
              ...optionalText(input, 'feedback'),
            },
          },
        }),
      },
    ],
  },
  'input-gate': {
    summary:
      'The task states nothing an agent could act on; the run stopped before its first dispatch.',
    pending: (decision) => decision.status === 'blocked',
    verbs: [
      {
        action: 'resolve',
        binding: 'decisions_resolve_input_gate',
        summary:
          'Re-check the task as it now stands (fix it over tasks_update first), or waive the findings.',
        fields: [
          {
            name: 'choice',
            required: true,
            choices: ['recheck', 'proceed'],
            detail: '`recheck` re-evaluates; `proceed` waives the findings and records who did it.',
          },
        ],
        call: (_decision, input) => ({
          binding: 'decisions_resolve_input_gate',
          args: { body: { choice: choice(input, 'choice', ['recheck', 'proceed']) } },
        }),
      },
    ],
  },
  'requirements-review': {
    summary: 'The reviewer raised questions about the requirements and the run is waiting on them.',
    pending: reviewPending,
    verbs: reviewVerbs({
      reply: 'decisions_reply_to_finding',
      setStatus: 'decisions_set_finding_status',
      incorporate: 'decisions_incorporate',
      reReview: 'decisions_re_review',
      proceed: 'decisions_proceed',
      resolveExceeded: 'decisions_resolve_exceeded',
      item: 'finding',
    }),
  },
  'clarity-review': {
    summary: 'The reviewer asked whether the bug report is actually fixable.',
    pending: reviewPending,
    verbs: reviewVerbs({
      reply: 'decisions_reply_to_clarity_finding',
      setStatus: 'decisions_set_clarity_finding_status',
      incorporate: 'decisions_incorporate_clarity',
      reReview: 'decisions_re_review_clarity',
      proceed: 'decisions_proceed_clarity',
      resolveExceeded: 'decisions_resolve_clarity_exceeded',
      item: 'finding',
    }),
  },
  brainstorm: {
    summary: 'The agent proposed directions and the run is waiting for someone to pick and steer.',
    pending: reviewPending,
    verbs: reviewVerbs({
      reply: 'decisions_reply_to_brainstorm_option',
      setStatus: 'decisions_set_brainstorm_option_status',
      incorporate: 'decisions_incorporate_brainstorm',
      reReview: 'decisions_re_review_brainstorm',
      proceed: 'decisions_proceed_brainstorm',
      resolveExceeded: 'decisions_resolve_brainstorm_exceeded',
      item: 'option',
    }),
  },
  'pr-review': {
    summary:
      'A deep review sliced an open pull request and is waiting for its findings to be curated.',
    pending: (decision) => decision.status === 'awaiting_selection',
    verbs: [
      {
        action: 'resolve',
        binding: 'decisions_resolve_pr_review',
        summary:
          'Say what to do with the curated findings: record, hand to a fixer, or post on the PR.',
        fields: [
          {
            name: 'action',
            required: false,
            detail: 'Omitted reads as `finish`. See the surface’s `prReviewResolution` vocabulary.',
          },
          {
            name: 'findingIds',
            required: false,
            detail:
              'The findings to act on. Omitted reads as an empty selection, which only `finish` accepts.',
          },
        ],
        call: (_decision, input) => {
          const ids = input.findingIds
          return {
            binding: 'decisions_resolve_pr_review',
            args: {
              body: {
                ...optionalText(input, 'action'),
                ...(Array.isArray(ids) ? { findingIds: ids } : {}),
              },
            },
          }
        },
      },
      {
        action: 'dismiss-finding',
        binding: 'decisions_dismiss_pr_review_finding',
        summary: 'Drop one finding from consideration.',
        fields: [{ name: 'findingId', required: true, detail: 'The finding’s stable id.' }],
        call: (_decision, input) => ({
          binding: 'decisions_dismiss_pr_review_finding',
          args: { findingId: pick(input, 'findingId', 'finding') },
        }),
      },
      {
        action: 'challenge-finding',
        binding: 'decisions_challenge_pr_review_finding',
        summary: 'Send one finding back to a read-only investigator to uphold, amend or retract.',
        fields: [
          { name: 'findingId', required: true, detail: 'The finding’s stable id.' },
          {
            name: 'question',
            required: false,
            detail: 'What to check. Omitted uses the generic prompt.',
          },
        ],
        call: (_decision, input) => ({
          binding: 'decisions_challenge_pr_review_finding',
          args: {
            findingId: pick(input, 'findingId', 'finding'),
            body: optionalText(input, 'question'),
          },
        }),
      },
    ],
  },
  'human-test': {
    summary:
      'A live ephemeral environment is up and the run is waiting for someone to exercise it.',
    pending: (decision) => decision.phase === 'awaiting_human',
    verbs: [
      {
        action: 'confirm',
        binding: 'decisions_confirm_human_test',
        summary: 'The change works. The run advances.',
        fields: [],
        call: () => ({ binding: 'decisions_confirm_human_test', args: {} }),
      },
      {
        action: 'request-fix',
        binding: 'decisions_request_human_test_fix',
        summary: 'It does not work. A fixer runs with these findings.',
        fields: FINDINGS_FIELDS,
        call: (_decision, input) => ({
          binding: 'decisions_request_human_test_fix',
          args: { body: { findings: text(input, 'findings', 'what the fixer has to fix') } },
        }),
      },
    ],
  },
  'visual-confirmation': {
    summary: 'Screenshots are waiting to be compared against the uploaded reference designs.',
    pending: (decision) => decision.phase === 'awaiting_human',
    verbs: [
      {
        action: 'approve',
        binding: 'decisions_approve_visual_confirmation',
        summary: 'The screenshots match. The run advances.',
        fields: [],
        call: () => ({ binding: 'decisions_approve_visual_confirmation', args: {} }),
      },
      {
        action: 'request-fix',
        binding: 'decisions_request_visual_confirmation_fix',
        summary: 'They do not match. A fixer runs with these findings.',
        fields: FINDINGS_FIELDS,
        call: (_decision, input) => ({
          binding: 'decisions_request_visual_confirmation_fix',
          args: { body: { findings: text(input, 'findings', 'what the fixer has to fix') } },
        }),
      },
    ],
  },
  'follow-ups': {
    summary: 'The Coder surfaced forward-looking items and the run stops until each is decided.',
    // This park accrues LIVE: items appear while the step still runs, so the run need not be
    // blocked for them to be answerable. What holds it is a `pending` item, not the run's status.
    pending: (decision) =>
      Array.isArray(decision.items) &&
      decision.items.some((item) => (item as { status?: unknown }).status === 'pending'),
    verbs: [
      {
        action: 'file',
        binding: 'decisions_file_follow_up',
        summary: 'File a follow-up as a ticket.',
        fields: [{ name: 'itemId', required: true, detail: 'The item’s stable id.' }],
        call: (_decision, input) => ({
          binding: 'decisions_file_follow_up',
          args: { itemId: pick(input, 'itemId', 'item') },
        }),
      },
      {
        action: 'send-back',
        binding: 'decisions_send_back_follow_up',
        summary: 'Fold a follow-up into another Coder pass, if the send-back budget allows.',
        fields: [{ name: 'itemId', required: true, detail: 'The item’s stable id.' }],
        call: (_decision, input) => ({
          binding: 'decisions_send_back_follow_up',
          args: { itemId: pick(input, 'itemId', 'item') },
        }),
      },
      {
        action: 'answer',
        binding: 'decisions_answer_follow_up',
        summary: 'Answer a `question` item.',
        fields: [
          { name: 'itemId', required: true, detail: 'The item’s stable id.' },
          { name: 'answer', required: true, detail: 'The answer the next pass works from.' },
        ],
        call: (_decision, input) => ({
          binding: 'decisions_answer_follow_up',
          args: {
            itemId: pick(input, 'itemId', 'item'),
            body: { answer: text(input, 'answer', 'the answer the next pass works from') },
          },
        }),
      },
      {
        action: 'dismiss',
        binding: 'decisions_dismiss_follow_up',
        summary: 'Decide an item needs nothing.',
        fields: [{ name: 'itemId', required: true, detail: 'The item’s stable id.' }],
        call: (_decision, input) => ({
          binding: 'decisions_dismiss_follow_up',
          args: { itemId: pick(input, 'itemId', 'item') },
        }),
      },
    ],
  },
  interview: {
    summary:
      'An inline interviewer asked clarifying questions and the run waits while they are answered.',
    // An entry whose questions are all answered means the interviewer pass is IN FLIGHT, and
    // `continue` / `proceed` still act on it, so presence is what makes it answerable.
    pending: () => true,
    verbs: [
      {
        action: 'answer',
        binding: 'decisions_answer_interview_question',
        summary: 'Record one answer. An empty string clears one recorded by mistake.',
        fields: [
          {
            name: 'questionId',
            required: true,
            detail:
              'The question’s id. A question whose id is null cannot be answered individually.',
          },
          { name: 'answer', required: false, detail: 'The answer; an empty string clears it.' },
        ],
        call: (_decision, input) => ({
          binding: 'decisions_answer_interview_question',
          args: {
            body: {
              questionId: pick(input, 'questionId', 'question'),
              answer: typeof input.answer === 'string' ? input.answer : '',
            },
          },
        }),
      },
      {
        action: 'continue',
        binding: 'decisions_continue_interview',
        summary: 'Submit the answers and let the interviewer ask follow-ups.',
        fields: [],
        call: () => ({ binding: 'decisions_continue_interview', args: {} }),
      },
      {
        action: 'proceed',
        binding: 'decisions_proceed_interview',
        summary: 'Force the interview to converge on what it has.',
        fields: [],
        call: () => ({ binding: 'decisions_proceed_interview', args: {} }),
      },
    ],
  },
} satisfies Record<ParkedDecisionKind, DecisionAnswerer>

/** How a kind of park is answered, or `undefined` for one this package does not model. */
export function answererFor(kind: string): DecisionAnswerer | undefined {
  return (ANSWERERS as Record<string, DecisionAnswerer | undefined>)[kind]
}

/** Every kind this package can answer. */
export const ANSWERABLE_DECISION_KINDS: readonly ParkedDecisionKind[] = Object.keys(
  ANSWERERS,
) as ParkedDecisionKind[]

/**
 * The binding names every answerer forwards through, plus the read that finds the park.
 *
 * Published so a policy author can grant "answer parked decisions" without transcribing forty
 * operation names, and so `approvals_inspect` can say which verbs a tier actually holds. It is
 * DERIVED from the table rather than restated, because a hand-kept copy is exactly the drift the
 * generated binding table exists to prevent one layer down.
 */
export const DECISION_BINDINGS: readonly string[] = [
  'decisions_list',
  ...new Set(
    Object.values(ANSWERERS as Record<string, DecisionAnswerer>).flatMap((answerer) =>
      answerer.verbs.map((verb) => verb.binding),
    ),
  ),
]

/**
 * The key scope every decision binding needs.
 *
 * Stated as a constant rather than read off the table because it is a POLICY fact a tier author
 * needs before compiling: a tier granting these must mint `decide` keys. `policy.test.ts` pins it
 * against the live table, so a surface that ever lowered a floor would fail there rather than
 * leaving this comment quietly wrong.
 */
export const DECISION_KEY_SCOPE: PublicApiScope = 'decide'
