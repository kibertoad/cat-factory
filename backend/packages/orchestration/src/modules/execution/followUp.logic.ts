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
 * (the answer steers the next pass). Filed / dismissed items are excluded.
 */
export function followUpsToSendBack(state: FollowUpsStepState): FollowUpItem[] {
  return state.items.filter(
    (item) => (item.status === 'queued' || item.status === 'answered') && !item.sentToCoder,
  )
}

/** Whether the gate should loop the Coder now: there are unsent send-back items and budget remains. */
export function shouldLoopCoder(state: FollowUpsStepState): boolean {
  if (hasPendingFollowUps(state)) return false
  return followUpsToSendBack(state).length > 0 && (state.loops ?? 0) < (state.maxLoops ?? 0)
}

/**
 * Render the queued follow-ups + answered questions into the rework feedback the Coder
 * receives on its next pass. Returns an empty string when there is nothing to send back.
 */
export function renderFollowUpRework(items: FollowUpItem[]): string {
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
  return lines.join('\n').trimEnd()
}
