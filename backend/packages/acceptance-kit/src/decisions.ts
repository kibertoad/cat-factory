// Answering what a run parks on, and REFUSING to answer what this suite did not design for.
//
// This module is the most dangerous thing in the suite, so it is the most conservative. An
// acceptance run is unattended, and the tempting shape is a loop that settles whatever it finds so
// the run keeps moving. That shape produces a green suite that proves nothing: a `pr-review` gate
// auto-resolved, a `judge` verdict auto-overridden and a `fork` auto-picked are three decisions a
// person was supposed to make, and a run driven past all of them still ends in `done`.
//
// So:
//   - Exactly TWO kinds are answered, each because the suite has a designed intent for it:
//     `follow-ups` (triage the Coder's companion raises, on by default on every coder step, which
//     would otherwise park every build) and `clarity-review` (the human gate `pl_bugfix` is built
//     around; answering it IS the point of scenario 03).
//   - Every other kind is a hard FAILURE naming the kind and step. A run that parks somewhere
//     unexpected is a finding, not an obstacle.
//   - Every answer is logged with what it answered and how. A decision settled silently is
//     indistinguishable from one that was never raised.
//
// **Being LISTED is not being ANSWERABLE**, and `isActionable` is the whole of that difference.
// The decision list deliberately keeps showing a review the driver is mid-cycle on
// (`incorporating` / `reviewing`) so a poller can see its answers are in flight, and it shows a
// follow-up set whose items are all settled. Reading "the list is non-empty" as "someone must
// answer something" is what turns this module into the auto-settler its header refuses to be: the
// suite would waive, one poll later, the very gate it had just answered. So what may be acted on
// is decided per kind from the STATUS the platform reports, never from a count of open items, and
// `publicApi.ts` waits on the same predicate rather than on a non-empty list.

import { reviewAwaitsHuman } from '@cat-factory/contracts'
import type { CatFactoryClient, PublicDecision, PublicDecisionList } from '@cat-factory/sdk'

/** What the suite did with one parked decision, for the run log and the scenario's own assertions. */
export type AnsweredDecision = {
  kind: string
  /** One line per action taken, e.g. `dismissed follow_up itm_4`. */
  actions: string[]
}

export type AnswerOptions = {
  client: CatFactoryClient
  runId: string
  /**
   * What to say when the platform asks a question the brief already answers. Kept as a caller
   * argument rather than a constant because scenario 03's answer is about the bug under
   * investigation, and a generic string there would be the suite feeding the investigator noise.
   *
   * It is a RULING, not information: see {@link answerFollowUps} for why a follow-up question is
   * closed with it rather than answered with it.
   */
  steer: string
}

/**
 * Whether a listed decision is one a caller may act on RIGHT NOW.
 *
 * Pure, and the single expression of the rule: `answerDecisions` filters on it, and the poll
 * wait treats "nothing actionable" as a run still working rather than as a park.
 *
 * A kind the suite REFUSES is actionable by design. Its refusal is the reaction it exists for, and
 * a suite that waited that out would burn the run's whole budget and then report a timeout instead
 * of the unexpected park that caused it.
 */
export function isActionable(decision: PublicDecision): boolean {
  switch (decision.kind) {
    case 'follow-ups':
      return decision.items.some((item) => item.status === 'pending')
    case 'clarity-review':
      // The contracts' own predicate, not a local restatement: exactly two statuses stop on a
      // human, and the three transients between them belong to the driver.
      return reviewAwaitsHuman(decision.status)
    default:
      return true
  }
}

/**
 * Answer every decision in the list this suite is designed for AND that is answerable now.
 *
 * Returns what it did, one entry per decision acted on. Throws on the first kind it is not
 * designed for, with the step named.
 */
export async function answerDecisions(
  options: AnswerOptions,
  decisions: PublicDecisionList,
): Promise<AnsweredDecision[]> {
  const answered: AnsweredDecision[] = []
  for (const decision of decisions.decisions.filter(isActionable)) {
    answered.push(await answerOne(options, decision))
  }
  return answered
}

async function answerOne(
  options: AnswerOptions,
  decision: PublicDecision,
): Promise<AnsweredDecision> {
  switch (decision.kind) {
    case 'follow-ups':
      return { kind: decision.kind, actions: await answerFollowUps(options, decision) }
    case 'clarity-review':
      return { kind: decision.kind, actions: await answerClarity(options, decision) }
    default:
      throw new Error(unexpectedDecision(decision))
  }
}

/**
 * The message for a decision the suite will not answer.
 *
 * Split out and exported so `test/decisions.test.ts` can pin that it names the kind: this is the
 * message an operator gets when a pipeline changes shape under the suite, and "the run parked and
 * we stopped" without the kind would send them to the SPA to find out what everyone already knew.
 */
export function unexpectedDecision(decision: PublicDecision): string {
  const where =
    'stepKind' in decision && typeof decision.stepKind === 'string'
      ? ` raised by step '${decision.stepKind}'`
      : ''
  return (
    `The run parked on a '${decision.kind}' decision${where}, which this suite deliberately does ` +
    `not answer.\n` +
    `Only 'follow-ups' and 'clarity-review' are answered here, because those are the two a suite ` +
    `can have a designed intent for unattended. ` +
    `A run stopping anywhere else is a finding: answer it in the SPA to see what the pipeline ` +
    `does next, or change the pipeline the scenario starts.`
  )
}

/**
 * Triage the Coder companion's follow-ups.
 *
 * A `follow_up` is work the agent noticed and deliberately did NOT do; dismissing it is the right
 * unattended answer, because filing it would create board tasks the suite never cleans up and
 * sending it back would loop the coder on scope the brief did not ask for.
 *
 * A `question` is CLOSED with the steer as the reason, never `answered` with it. The distinction is
 * the whole of what this function got wrong before, and it cost three coder passes per run.
 * `resolution: 'answered'` promises the reply carries something the next pass can apply, and the
 * steer never does: it is the brief restated, which is what the agent already built from. Handed it
 * as an answer, an agent that asked an unanswerable question ("which IngressClass does the target
 * cluster mark as default?") finds nothing to apply, rewords the surrounding comment so its
 * uncertainty is at least written down, re-raises the same question under a new title, and gets the
 * same steer back. The loop ended on `maxLoops`, not on agreement.
 *
 * `closed` says what is true: nobody here is going to answer this, the brief stands, stop asking.
 * It clears the gate exactly as an answer does, so the suite still drives the run to completion,
 * and it spends no model call doing it.
 *
 * The consequence for coverage is deliberate and worth stating: this suite no longer exercises the
 * send-back loop, because it no longer has an honest reason to. That loop is engine behaviour with
 * no assembled-product component, so it is pinned in `followUp.logic.test.ts` and in the gate
 * controller's own tests, where the budget can be driven to exhaustion on purpose rather than
 * whenever a model happens to ask a question.
 *
 * Items that are already settled are skipped: the list carries the whole set, and re-answering a
 * `dismissed` item is a 4xx that would read as a broken suite.
 */
async function answerFollowUps(
  options: AnswerOptions,
  decision: Extract<PublicDecision, { kind: 'follow-ups' }>,
): Promise<string[]> {
  const actions: string[] = []
  for (const item of decision.items) {
    if (item.status !== 'pending') continue
    if (item.kind === 'question') {
      await options.client.decisions.answerFollowUp(options.runId, item.itemId, {
        answer: options.steer,
        resolution: 'closed',
      })
      actions.push(`closed question ${item.itemId}`)
    } else {
      await options.client.decisions.dismissFollowUp(options.runId, item.itemId)
      actions.push(`dismissed follow_up ${item.itemId}`)
    }
  }
  return actions
}

type ClarityDecision = Extract<PublicDecision, { kind: 'clarity-review' }>

/**
 * Answer the `clarity-review` triage gate, the way a reporter would.
 *
 * Dispatched on the review's STATUS, which is the fact that says whose turn it is. Reading the
 * open-finding count instead is the trap this replaced: a review the suite had just answered comes
 * back one poll later as `incorporating` with nothing open, and "nothing open" read as "nothing
 * outstanding" waives the gate mid-incorporation, racing the driver folding in the very answers it
 * was given. That failure is silent in both directions, since the run still reaches `done` and the
 * suite still records having answered a `clarity-review`.
 */
async function answerClarity(options: AnswerOptions, decision: ClarityDecision): Promise<string[]> {
  switch (decision.status) {
    case 'ready':
      return await settleClarityFindings(options, decision)
    case 'exceeded':
      throw new Error(clarityCapReached(decision))
    case 'incorporating':
    case 'reviewing':
    case 'merged':
    case 'incorporated':
      // Withheld by `isActionable`, so arriving here means the predicate and this dispatch have
      // drifted apart. Say which status got through rather than acting on it: every one of these
      // is the driver mid-cycle, and pushing a review nobody handed over is the race above.
      throw new Error(
        `A clarity review in '${decision.status}' reached the answering path, which only settles a ` +
          `review that has stopped on a human. That is a bug in this suite's isActionable(), not a ` +
          `problem with the deployment.`,
      )
    default:
      return unknownClarityStatus(decision.status)
  }
}

/**
 * The `ready` park: answer what the reviewer asked, then fold the answers in.
 *
 * Replying RECORDS answers and incorporating is what folds them into the clarified report the
 * downstream steps build from, so a suite that reached for `proceed` here would settle the phase
 * with nothing folded in and hand the `architect` the ORIGINAL report, having demonstrated nothing
 * about the gate.
 *
 * With nothing open there is nothing to fold and `proceed` is the honest call. Deliberately not
 * "incorporate anyway": a review whose answers are already folded returns from an incorporation
 * pass `ready` with nothing open again, which is a loop, and one that spends a model call per lap.
 */
async function settleClarityFindings(
  options: AnswerOptions,
  decision: ClarityDecision,
): Promise<string[]> {
  const actions: string[] = []
  const open = decision.findings.filter((finding) => finding.status === 'open')

  for (const finding of open) {
    await options.client.decisions.replyToClarityFinding(options.runId, finding.itemId, {
      reply: options.steer,
    })
    actions.push(`replied to finding ${finding.itemId}`)
  }

  if (open.length > 0) {
    await options.client.decisions.incorporateClarity(options.runId, {})
    actions.push(`incorporated ${open.length} answer(s)`)
  } else {
    await options.client.decisions.proceedClarity(options.runId)
    actions.push('proceeded with nothing outstanding')
  }
  return actions
}

/**
 * The message for a review that exhausted its reviewer-pass budget.
 *
 * `exceeded` parks on a human like `ready` does, and is the one park this suite will not settle:
 * the choice is another round, proceeding on the last clarified report, or stopping and resetting
 * the task, and picking one unattended is the auto-settling this module exists to refuse. It is
 * also a finding in its own right, since a report the suite answered as the reporter should
 * converge well inside the budget, and a suite that quietly pushed past the cap would hide exactly
 * the case worth looking at.
 */
export function clarityCapReached(decision: ClarityDecision): string {
  return (
    `The clarity review on task ${decision.taskId} exhausted its budget of ` +
    `${decision.maxIterations} reviewer pass(es) without converging, so it is parked at its cap ` +
    `and this suite will not choose how it proceeds.\n` +
    `Pick one in the SPA, or over the API with POST /api/v1/runs/<runId>/decisions/clarity/` +
    `resolve-exceeded: another round, proceed on the last clarified report, or stop and reset.\n` +
    `Worth reading before you do: a suite answers as the person who filed the report, so a review ` +
    `that never converges usually means the report and the reviewer are talking past each other, ` +
    `which is a fact about the STEER the scenario supplied rather than about the platform.`
  )
}

/**
 * A review status the compiled SDK does not carry.
 *
 * `never` keeps the switch above exhaustive at COMPILE time, so a new status cannot be added
 * without deciding what this suite does with it. The throw is the RUNTIME half: the SDK tolerates
 * unknown enum values by design, so a deployment ahead of this checkout genuinely can serve one,
 * and naming it beats a silent fall-through onto a branch that was written for another status.
 */
function unknownClarityStatus(status: never): never {
  throw new Error(
    `The deployment reported the clarity review as '${String(status)}', a status this checkout's ` +
      `@cat-factory/sdk does not know. Update the SDK to the deployment's version.`,
  )
}
