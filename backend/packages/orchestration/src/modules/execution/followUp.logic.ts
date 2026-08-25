import type { FollowUpItem, FollowUpsStepState } from '@cat-factory/kernel'

// Pure logic + constants for the Follow-up companion (the future-looking Coder). The
// engine seeds `step.followUps` on an enabled `coder` step, lifts streamed items onto it
// as the harness surfaces them, parks the run at the Coder's completion while any item is
// undecided, and — once all are decided — loops the Coder for the items the human queued
// (follow-ups to act on) or answered (questions). Kept side-effect-free so it is unit- and
// conformance-testable without the engine's I/O.

/** The producer kind the Follow-up companion attaches to (the Coder). */
export const FOLLOW_UP_PRODUCER_KIND = 'coder'

/** Default send-back loop budget: how many times queued/answered items re-run the Coder. */
export const DEFAULT_FOLLOW_UP_MAX_LOOPS = 3

/** Whether the companion is enabled and has at least one item awaiting a human decision. */
export function hasPendingFollowUps(state: FollowUpsStepState | null | undefined): boolean {
  return !!state?.enabled && state.items.some((item) => item.status === 'pending')
}

/** The count of undecided items (used to drive the blinking companion + the gate). */
export function pendingFollowUpCount(state: FollowUpsStepState | null | undefined): number {
  if (!state?.enabled) return 0
  return state.items.filter((item) => item.status === 'pending').length
}

/**
 * Items that should be folded into the next Coder pass once every item is decided: the
 * follow-ups the human QUEUED (asked the Coder to do) and the questions the human ANSWERED
 * (the answer steers the next pass). Filed / closed / dismissed items are excluded.
 *
 * An item already stamped {@link FollowUpItem.sendBackDropped} is excluded too, which is what
 * makes the exhausted verdict fire EXACTLY ONCE. Dropping is a terminal disposition, so a second
 * evaluation of the same state (a re-driven advance, a lost CAS race re-applying on the winner's
 * snapshot) reads `settled` and re-reports nothing. Without it the drop is re-counted on every
 * pass over a step that already dropped, which is the "a periodic read fed to a delta counter
 * re-reports the same rows" mistake in CLAUDE.md, one layer up.
 */
export function followUpsToSendBack(state: FollowUpsStepState): FollowUpItem[] {
  return state.items.filter(
    (item) =>
      (item.status === 'queued' || item.status === 'answered') &&
      !item.sentToCoder &&
      !item.sendBackDropped,
  )
}

/**
 * The send-back budget as the engine READS it: passes spent, and the ceiling they stop at.
 *
 * Both fields are typed required (the wire schema defaults them: 0 and
 * {@link DEFAULT_FOLLOW_UP_MAX_LOOPS}), and both are nonetheless read defensively, because step
 * state is persisted as one JSON blob and read back with `JSON.parse` rather than a schema parse,
 * so a row written before a field existed reaches this code missing it, defaults and all. A missing
 * ceiling reads as 0, which stops the loop rather than running it unbounded: the safe direction for
 * a value that spends model calls.
 *
 * Stated once because two callers must agree on it. {@link followUpGateVerdict} decides with these
 * numbers and the public decision projection REPORTS them, so a projection that defaulted the
 * ceiling differently would tell a caller it had budget for a send-back the engine was never going
 * to spend, and the run would advance instead of looping with no error anywhere.
 */
export function followUpLoopBudget(state: FollowUpsStepState): {
  loops: number
  maxLoops: number
} {
  return { loops: state.loops ?? 0, maxLoops: state.maxLoops ?? 0 }
}

/**
 * What the gate should do with this step's follow-up state, right now.
 *
 * - `pending`: an item is still undecided; the run parks (or policy dismisses).
 * - `loop`: there are unsent send-back items and budget to pay for a pass.
 * - `exhausted`: there are unsent send-back items and the budget is SPENT. The run advances, and
 *   what it is advancing past has to be recorded.
 * - `settled`: nothing left to send; the run advances with nothing dropped.
 *
 * A discriminated verdict rather than the boolean this replaced, because three of those four
 * answers used to be the same `false`. The caller could not tell "nothing to send" from "a human's
 * decision is about to be thrown away", so the second one advanced the run silently: `loops` and
 * `maxLoops` sat equal on the step and reached nobody. Naming the case is what lets
 * {@link FollowUpItem.sendBackDropped}, the log line and the PR report all state it.
 */
export type FollowUpGateVerdict = 'pending' | 'loop' | 'exhausted' | 'settled'

export function followUpGateVerdict(state: FollowUpsStepState): FollowUpGateVerdict {
  if (hasPendingFollowUps(state)) return 'pending'
  if (followUpsToSendBack(state).length === 0) return 'settled'
  const budget = followUpLoopBudget(state)
  // A step with NO ceiling at all has the send-back loop unwired, which is not the same fact as a
  // ceiling that ran out, and it must not be reported as one. The engine seeds every follow-up
  // step with {@link DEFAULT_FOLLOW_UP_MAX_LOOPS}, so this is reachable only for step state
  // persisted before the field existed, which {@link followUpLoopBudget} deliberately reads as 0
  // to stop the loop rather than run it unbounded. Read as `exhausted` that same 0 manufactures
  // the alarm: every such item would be stamped as a discarded decision, warned about, counted
  // under `followup.send_back_dropped` and banner-ed onto the pull request as a budget that "was
  // spent", for a budget nobody ever configured. `settled` is the pass-through an unwired
  // capability owes: byte-for-byte what these rows did before any of this existed.
  if (budget.maxLoops <= 0) return 'settled'
  return budget.loops < budget.maxLoops ? 'loop' : 'exhausted'
}

/**
 * The questions RULED ON without a loop-back (`closed`), for the "already settled" half of the
 * rework prompt.
 *
 * Every closed item, not only the ones closed since the last pass: the Coder re-derives its
 * uncertainty from scratch on each pass and has no memory of what it asked before, so a ruling
 * dropped from the prompt after one pass is a ruling the next pass re-raises. Carrying the whole
 * set costs a few lines and is the difference between a settled topic and an open one.
 */
export function followUpsAlreadySettled(state: FollowUpsStepState): FollowUpItem[] {
  return state.items.filter((item) => item.status === 'closed')
}

/**
 * Render the queued follow-ups + answered questions into the rework feedback the Coder
 * receives on its next pass, followed by the questions already ruled on.
 *
 * Returns an empty string when there is nothing to send back, `settled` included: a pass exists
 * to carry work or an answer, and a prompt whose only content is "here is what you may not ask
 * again" is a model call bought to relitigate nothing.
 */
export function renderFollowUpRework(items: FollowUpItem[], settled: FollowUpItem[] = []): string {
  if (items.length === 0) return ''
  const lines: string[] = [
    'The previous implementation pass surfaced follow-up items. A human reviewed them and ' +
      'asked you to address the following now, on top of your prior work (do NOT redo the ' +
      'task from scratch — extend it):',
    '',
  ]
  const tasks = items.filter((i) => i.status === 'queued')
  const answers = items.filter((i) => i.status === 'answered')
  if (tasks.length > 0) {
    lines.push('Follow-up tasks to implement:')
    for (const t of tasks) {
      lines.push(`- ${t.title}${t.detail ? `: ${t.detail}` : ''}`)
      if (t.suggestedAction) lines.push(`  Suggested approach: ${t.suggestedAction}`)
    }
    lines.push('')
  }
  if (answers.length > 0) {
    lines.push('Answers to questions you raised (apply them):')
    for (const a of answers) {
      lines.push(`- Q: ${a.title}${a.detail ? ` — ${a.detail}` : ''}`)
      lines.push(`  A: ${a.answer ?? ''}`)
    }
    lines.push('')
  }
  if (settled.length > 0) {
    // The instruction is as load-bearing as the list. A model handed a ruling it cannot act on
    // will otherwise do the only thing left to it: restate the uncertainty in the code, the
    // README and the commit message, one wording per pass, and ask again.
    lines.push(
      'Already settled: do NOT raise these again, and do not rewrite the surrounding ' +
        'comments, docs or commit message to re-argue them. Each was ruled on rather than ' +
        'answered with new information, so there is nothing further to apply:',
    )
    for (const s of settled) {
      lines.push(`- Q: ${s.title}${s.detail ? `: ${s.detail}` : ''}`)
      lines.push(`  Ruling: ${s.answer ?? 'settled without further detail'}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
