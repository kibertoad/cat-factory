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
//     around; answering it IS the point of spec 03).
//   - Every other kind is a hard FAILURE naming the kind and step. A run that parks somewhere
//     unexpected is a finding, not an obstacle.
//   - Every answer is logged with what it answered and how. A decision settled silently is
//     indistinguishable from one that was never raised.

import type { CatFactoryClient, PublicDecision, PublicDecisionList } from '@cat-factory/sdk'

/** What the suite did with one parked decision, for the run log and the spec's own assertions. */
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
   * argument rather than a constant because spec 03's answer is about the bug under
   * investigation, and a generic string there would be the suite feeding the investigator noise.
   */
  steer: string
}

/**
 * Answer every decision in the list this suite is designed for.
 *
 * Returns what it did. Throws on the first kind it is not designed for, with the step named.
 */
export async function answerDecisions(
  options: AnswerOptions,
  decisions: PublicDecisionList,
): Promise<AnsweredDecision[]> {
  const answered: AnsweredDecision[] = []
  for (const decision of decisions.decisions) {
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
    `Only 'follow-ups' and 'clarity-review' are answered here (see src/decisions.ts for why). ` +
    `A run stopping anywhere else is a finding: answer it in the SPA to see what the pipeline ` +
    `does next, or change the pipeline the spec starts.`
  )
}

/**
 * Triage the Coder companion's follow-ups.
 *
 * A `follow_up` is work the agent noticed and deliberately did NOT do; dismissing it is the right
 * unattended answer, because filing it would create board tasks the suite never cleans up and
 * sending it back would loop the coder on scope the brief did not ask for. A `question` is the
 * agent asking for a steer, and gets the caller's, which is the brief restated.
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
      })
      actions.push(`answered question ${item.itemId}`)
    } else {
      await options.client.decisions.dismissFollowUp(options.runId, item.itemId)
      actions.push(`dismissed follow_up ${item.itemId}`)
    }
  }
  return actions
}

/**
 * Answer the `clarity-review` triage gate, the way a reporter would.
 *
 * The loop is reply-to-each-finding then INCORPORATE, not `proceed`. The difference matters and is
 * the reason this is not two lines: `proceed` settles the phase with nothing folded in, which is
 * right when there is nothing outstanding and is a way of skipping the conversation when there is.
 * Replying records answers, and incorporating is what folds them into the clarified report the
 * downstream steps actually build from, so a suite that used `proceed` would park, resume, and
 * hand the `architect` the ORIGINAL report, having demonstrated nothing about the gate.
 *
 * With no open findings there is nothing to fold, and `proceed` is then the honest call.
 */
async function answerClarity(
  options: AnswerOptions,
  decision: Extract<PublicDecision, { kind: 'clarity-review' }>,
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
