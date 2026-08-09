// Answering a card: the half of the pattern where the OS's workspace inbox becomes a real decision
// on a real run.
//
// The card is a POINTER, never the decision. Between the delivery that raised it and the answer,
// the run may have advanced, been stopped, or had the same park answered by a person in the
// cat-factory app; and the ids every action addresses (`approvalId`, `decisionId`, the brainstorm
// `stage`) are not on the card at all, because the notification does not carry them. So answering
// re-reads `/runs/:runId/decisions` first, every time. That is the platform's own instruction
// ("the webhook is a trigger; the API is the truth") and it is what makes a stale card a REPORT
// rather than a 404 someone has to interpret.
//
// What this module does NOT do is decide how any particular park is answered. It finds the entry
// holding the run and hands it to that kind's answerer in `decisions.ts`. The run can be parked on
// any of thirteen things and the card's notification type is at best a hint about which: a
// `decision_required` card can be an approval gate or an agent question, and a run that parked
// twice is answering the SECOND park by the time anyone reads the first card.
//
// Every upstream call goes through the caller's own granted bindings, so a tier that was not
// granted `decisions_approve_step` cannot approve through this route either. The answer flow gets
// no privilege of its own.

import {
  answererFor,
  type AnswerFields,
  type DecisionVerb,
  type LiveDecision,
} from './policy/decisions.js'
import { GatekeeperError } from './errors.js'
import type { ApprovalCard } from './state.js'

export interface AnswerInput extends AnswerFields {
  /** The verb, as the kind's answerer names it (`approve`, `reply`, `resolve`, …). */
  action: string
  /**
   * Which park to answer, when the run holds more than one.
   *
   * Optional because the common case is a run parked on exactly one thing. Where two are pending
   * (a follow-up triage accrues while a later step's gate is open), answering without naming the
   * kind is REFUSED rather than resolved by order: the platform lists them in a shape order, not a
   * priority order, so picking the first would settle whichever the projection happened to build
   * first.
   */
  kind?: string
}

/**
 * What answering did.
 *
 * `stale` and `recorded` are the two outcomes an integration gets wrong when they are collapsed
 * into "it worked": the first means the run no longer holds a park this surface can answer, and
 * the second means the answer was taken but the park is still holding the run (an approval short
 * of quorum, a reply recorded before the incorporation that folds it in). Reporting either as
 * "answered" leaves a person believing a run is moving when it is not.
 */
export type AnswerOutcome =
  | { status: 'answered'; runId: string; kind: string; action: string; decisions: unknown }
  | {
      status: 'recorded'
      runId: string
      kind: string
      action: string
      /** Why the park still holds, in the run's own numbers where it has them. */
      detail: string
      decisions: unknown
    }
  | { status: 'stale'; runId: string; detail: string; decisions: unknown }

/** The minimal shape this module reads off a decision list. */
export interface DecisionListShape {
  parked?: boolean
  status?: string
  decisions?: unknown[]
  unanswerable?: { reason?: string; detail?: string }[]
}

/** Invoke a granted binding. Supplied by the capability, so policy is enforced on every hop. */
export type BindingInvoker = (name: string, args: Record<string, unknown>) => Promise<unknown>

/** One park holding a run, paired with the answerer that knows how to settle it. */
export interface PendingPark {
  kind: string
  decision: LiveDecision
  verbs: readonly DecisionVerb[]
  summary: string
}

function asDecision(entry: unknown): LiveDecision | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
  const kind = (entry as { kind?: unknown }).kind
  return typeof kind === 'string' ? (entry as LiveDecision) : null
}

/**
 * Every park in the list this Gatekeeper could answer, in the platform's own order.
 *
 * A settled entry is skipped by its kind's own `pending` predicate, and a kind this package does
 * not model is skipped entirely: both are cases where posting an answer would be a guess.
 */
export function pendingParks(list: DecisionListShape): PendingPark[] {
  const parks: PendingPark[] = []
  for (const entry of list.decisions ?? []) {
    const decision = asDecision(entry)
    if (decision === null) continue
    const answerer = answererFor(decision.kind)
    if (answerer === undefined || !answerer.pending(decision)) continue
    parks.push({
      kind: decision.kind,
      decision,
      verbs: answerer.verbs,
      summary: answerer.summary,
    })
  }
  return parks
}

/**
 * Why nothing here is answerable, in the run's own words where it has them.
 *
 * Four different facts, and an integration acts on each differently: the run finished, a person on
 * the VCS host is the gate, the run is parked on a kind this package does not model (a deployment
 * newer than this Gatekeeper), or it is parked on one that is modelled but already settled.
 * Flattening those into "not parked" would send an operator looking in the wrong place for each.
 */
export function describeStale(list: DecisionListShape): string {
  const waits = list.unanswerable ?? []
  if (waits.length > 0) {
    return waits
      .map((wait) => `${wait.reason ?? 'unknown'}: ${wait.detail ?? 'no detail supplied'}`)
      .join('; ')
  }
  const kinds = (list.decisions ?? [])
    .map(asDecision)
    .filter((decision): decision is LiveDecision => decision !== null)
    .map((decision) => decision.kind)
  if (kinds.length > 0) {
    const unmodelled = kinds.filter((kind) => answererFor(kind) === undefined)
    if (unmodelled.length > 0) {
      return (
        `The run is parked on '${[...new Set(unmodelled)].join("', '")}', which this Gatekeeper ` +
        'does not know how to answer. Upgrade it if the deployment is newer, or answer in the ' +
        'cat-factory app.'
      )
    }
    return `The run carries '${[...new Set(kinds)].join("', '")}', all already settled.`
  }
  if (list.parked === false) {
    return `The run is '${list.status ?? 'unknown'}' and holds no parked decision; it was answered elsewhere, or it has moved on.`
  }
  return 'The run is parked, and the platform named no decision and no unanswerable wait for it.'
}

/**
 * Whether the run has left the park entirely.
 *
 * This is what decides a card's fate, and it is deliberately a question about the RUN rather than
 * about the answer: an approve that met its quorum settles the card, an approve short of it does
 * not, and neither is visible in the action's own status code. A `stale` answer settles nothing at
 * all: the run may be parked on a wait a person has to clear, and destroying its inbox entry
 * would hide the one pointer anybody had to it.
 */
function stillParked(after: DecisionListShape, kind: string): PendingPark | null {
  return pendingParks(after).find((park) => park.kind === kind) ?? null
}

function pickPark(parks: PendingPark[], requested: string | undefined): PendingPark {
  if (requested !== undefined) {
    const park = parks.find((candidate) => candidate.kind === requested)
    if (park === undefined) {
      throw new GatekeeperError(
        'no_such_park',
        `The run holds no pending '${requested}' decision. It is parked on ` +
          `'${parks.map((candidate) => candidate.kind).join("', '")}'.`,
      )
    }
    return park
  }
  if (parks.length > 1) {
    throw new GatekeeperError(
      'ambiguous_park',
      `The run is parked on ${parks.length} decisions at once ` +
        `('${parks.map((park) => park.kind).join("', '")}'). Name which one with \`kind\`: the ` +
        'platform lists them in a shape order, not a priority order, so answering the first would ' +
        'settle whichever the projection happened to build first.',
    )
  }
  return parks[0] as PendingPark
}

function pickVerb(park: PendingPark, action: string): DecisionVerb {
  const verb = park.verbs.find((candidate) => candidate.action === action)
  if (verb === undefined) {
    throw new GatekeeperError(
      'unsupported_action',
      `A '${park.kind}' decision does not take '${action}'. It takes ` +
        `'${park.verbs.map((candidate) => candidate.action).join("', '")}'.`,
    )
  }
  return verb
}

/**
 * Why a park that survived the answer is still holding the run.
 *
 * Derived from the platform's own numbers, never from prose: a quorum reports its tally, an
 * iterative review reports the pass it is on. Where the park states neither, the honest answer is
 * that it is still there, which is itself the fact the caller needs.
 */
function describeProgress(park: PendingPark): string {
  const { decision } = park
  if (
    typeof decision.recordedApprovals === 'number' &&
    typeof decision.requiredApprovals === 'number'
  ) {
    return `${decision.recordedApprovals} of ${decision.requiredApprovals} approvals recorded; the gate still needs the rest.`
  }
  if (typeof decision.iteration === 'number' && typeof decision.maxIterations === 'number') {
    return `The loop is on pass ${decision.iteration} of ${decision.maxIterations} and has not converged.`
  }
  return `The '${park.kind}' decision is still holding the run; there is more to answer on it.`
}

/**
 * Answer one card against the live run.
 *
 * `invoke` carries the policy check, so this function never consults the tier itself: a binding the
 * caller was not granted rejects on the way through, with the capability's own refusal.
 */
export async function answerCard(
  card: ApprovalCard,
  input: AnswerInput,
  invoke: BindingInvoker,
): Promise<AnswerOutcome> {
  const before = (await invoke('decisions_list', { runId: card.runId })) as DecisionListShape
  const parks = pendingParks(before)
  if (parks.length === 0) {
    return { status: 'stale', runId: card.runId, detail: describeStale(before), decisions: before }
  }

  const park = pickPark(parks, input.kind)
  const verb = pickVerb(park, input.action)
  const call = verb.call(park.decision, input)

  const after = (await invoke(call.binding, {
    runId: card.runId,
    ...call.args,
  })) as DecisionListShape

  // Every decision action returns the run's WHOLE list, re-read after the action. So whether the
  // answer moved the run is in hand already, with no second call.
  const survived = stillParked(after, park.kind)
  if (survived !== null) {
    return {
      status: 'recorded',
      runId: card.runId,
      kind: park.kind,
      action: verb.action,
      detail: describeProgress(survived),
      decisions: after,
    }
  }

  return {
    status: 'answered',
    runId: card.runId,
    kind: park.kind,
    action: verb.action,
    decisions: after,
  }
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
