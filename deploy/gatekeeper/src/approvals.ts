// Answering an approval card: the half of the pattern where the OS's workspace inbox becomes a
// real decision on a real run.
//
// The card is a POINTER, never the decision. Between the delivery that raised it and the answer,
// the run may have advanced, been stopped, or had the same gate answered by a person in the
// cat-factory app; and the `approvalId` every action addresses is not on the card at all, because
// the notification does not carry it. So answering re-reads `/runs/:runId/decisions` first, every
// time. That is the platform's own instruction ("the webhook is a trigger; the API is the truth")
// and it is what makes a stale card a REPORT rather than a 404 someone has to interpret.
//
// Every upstream call goes through the caller's own granted bindings, so a tier that was not
// granted `decisions_approve_step` cannot approve through this route either. The approval flow
// gets no privilege of its own.

import { GatekeeperError } from './errors'
import type { ApprovalCard } from './state'

/** What an answer does to the gate. Mirrors the platform's four verbs, and nothing more. */
export type ApprovalAction = 'approve' | 'request-changes' | 'reject' | 'resolve-exceeded'

/** The exceeded-gate choices, as the platform spells them. */
export type ExceededChoice = 'extra-round' | 'proceed' | 'stop-reset'

export interface AnswerInput {
  action: ApprovalAction
  /** `approve`: replaces the agent's text and is what flows downstream. */
  proposal?: string
  /** `request-changes`: the guidance the step re-runs with. */
  feedback?: string
  /** `reject`: why the run is being stopped. */
  reason?: string
  /** `resolve-exceeded`: which way to settle a gate at its automatic-rework cap. */
  choice?: ExceededChoice
}

/**
 * What answering did.
 *
 * `stale` and `recorded` are the two outcomes an integration gets wrong when they are collapsed
 * into "it worked": the first means the run no longer holds the decision this card names, and the
 * second means the approval was counted but the gate needs more of them. Reporting either as
 * "answered" leaves a person believing a run is moving when it is not.
 */
export type AnswerOutcome =
  | { status: 'answered'; runId: string; decisions: unknown }
  | {
      status: 'recorded'
      runId: string
      recordedApprovals: number
      requiredApprovals: number
      decisions: unknown
    }
  | { status: 'stale'; runId: string; detail: string; decisions: unknown }

/** The minimal shape this module reads off a decision list. */
interface DecisionListShape {
  parked?: boolean
  status?: string
  decisions?: unknown[]
  unanswerable?: { reason?: string; detail?: string }[]
}

interface ApprovalGateShape {
  kind: 'approval-gate'
  approvalId: string
  exceeded: boolean
  status: string
  recordedApprovals: number
  requiredApprovals: number
}

/** Invoke a granted binding. Supplied by the capability, so policy is enforced on every hop. */
export type BindingInvoker = (name: string, args: Record<string, unknown>) => Promise<unknown>

function findPendingApprovalGate(list: DecisionListShape): ApprovalGateShape | null {
  for (const entry of list.decisions ?? []) {
    const decision = entry as Partial<ApprovalGateShape>
    if (decision.kind === 'approval-gate' && decision.status === 'pending') {
      return decision as ApprovalGateShape
    }
  }
  return null
}

/**
 * Why nothing is answerable, in the run's own words where it has them.
 *
 * `unanswerable` exists precisely so a caller can tell "the run finished" from "a person on the
 * VCS host is the gate" from "this deployment registered a gate nobody wired". Flattening those
 * into "not parked" would send an operator looking in the wrong place for each of them.
 */
function describeStale(list: DecisionListShape): string {
  const waits = list.unanswerable ?? []
  if (waits.length > 0) {
    return waits
      .map((wait) => `${wait.reason ?? 'unknown'}: ${wait.detail ?? 'no detail supplied'}`)
      .join('; ')
  }
  if (list.parked === false) {
    return `The run is '${list.status ?? 'unknown'}' and holds no parked decision; it was answered elsewhere, or it has moved on.`
  }
  return 'The run is parked, but on no decision this card names.'
}

function actionBinding(action: ApprovalAction): string {
  switch (action) {
    case 'approve':
      return 'decisions_approve_step'
    case 'request-changes':
      return 'decisions_request_step_changes'
    case 'reject':
      return 'decisions_reject_step'
    case 'resolve-exceeded':
      return 'decisions_resolve_step_exceeded'
  }
}

function actionBody(input: AnswerInput): Record<string, unknown> {
  switch (input.action) {
    case 'approve':
      return input.proposal === undefined ? {} : { proposal: input.proposal }
    case 'request-changes':
      return { feedback: input.feedback ?? '' }
    case 'reject':
      return input.reason === undefined ? {} : { reason: input.reason }
    case 'resolve-exceeded':
      return { choice: input.choice ?? 'proceed' }
  }
}

/**
 * Answer one card against the live run.
 *
 * `invoke` carries the policy check, so this function never consults the tier itself: a binding
 * the caller was not granted rejects on the way through, with the capability's own refusal.
 */
export async function answerCard(
  card: ApprovalCard,
  input: AnswerInput,
  invoke: BindingInvoker,
): Promise<AnswerOutcome> {
  const before = (await invoke('decisions_list', { runId: card.runId })) as DecisionListShape
  const gate = findPendingApprovalGate(before)
  if (gate === null) {
    return { status: 'stale', runId: card.runId, detail: describeStale(before), decisions: before }
  }

  // The platform refuses a plain approve on a gate at its rework cap (409), and the fix is a
  // different verb with an explicit choice. Naming that here means the caller is told which
  // choice to make, rather than handed a conflict whose remedy is in a doc.
  if (gate.exceeded && input.action !== 'resolve-exceeded') {
    throw new GatekeeperError(
      'unsupported_action',
      `Approval '${gate.approvalId}' is a companion gate at its automatic-rework cap, which the ` +
        `plain '${input.action}' cannot settle. Answer with 'resolve-exceeded' and a choice of ` +
        "'extra-round', 'proceed' or 'stop-reset'.",
    )
  }

  const after = (await invoke(actionBinding(input.action), {
    runId: card.runId,
    approvalId: gate.approvalId,
    body: actionBody(input),
  })) as DecisionListShape

  // Every action returns the run's WHOLE decision list, re-read after the action. So the tally
  // that decides whether this answer moved the run is in hand already, with no second call.
  const still = findPendingApprovalGate(after)
  if (input.action === 'approve' && still !== null && still.approvalId === gate.approvalId) {
    return {
      status: 'recorded',
      runId: card.runId,
      recordedApprovals: still.recordedApprovals,
      requiredApprovals: still.requiredApprovals,
      decisions: after,
    }
  }

  return { status: 'answered', runId: card.runId, decisions: after }
}

/** Refuse a card that cannot be answered, with the reason the OS maps to copy. */
export function assertAnswerable(card: ApprovalCard | null, cardId: string): ApprovalCard {
  if (card === null) {
    throw new GatekeeperError(
      'card_not_found',
      `No approval card '${cardId}'. It may have been raised against a different paired workspace, ` +
        'or predate this Gatekeeper.',
    )
  }
  if (card.resolvedAt !== null) {
    throw new GatekeeperError(
      'card_already_resolved',
      `Approval card '${cardId}' was settled as '${card.resolution}'. Read the run's decisions if ` +
        'it has parked again since.',
    )
  }
  return card
}
