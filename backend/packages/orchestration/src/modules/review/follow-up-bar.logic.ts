import type { RequirementReviewItem } from '@cat-factory/kernel'

// The bar a RE-REVIEW's findings must clear. A first pass may raise whatever clears the severity
// floor; a later pass reviews a document the human has just signed off on, so a finding there must
// either be `high` (it would block a correct implementation) or follow up on an answer the previous
// round gave (the answer introduced a behaviour, rule or scope whose own gap is now visible).
// Anything else re-litigates text nobody changed.
//
// The reviewer JUDGES which answer a finding follows up on, by citing its ref; the platform checks
// the citation against the refs it handed out and drops what clears neither half.

/** One answer the previous round recorded, under the ref the reviewer cites it by. */
export interface PriorRoundAnswer {
  ref: string
  title: string
  detail: string
  reply: string
}

/** What the previous round settled: the answers it folded in and the findings it waved off. */
export interface PriorRound {
  answered: PriorRoundAnswer[]
  dismissed: string[]
}

/**
 * The previous round, read off the items the re-review is about to replace. Only an answer with
 * text counts as new information: it is what the incorporation folded in, and the same filter the
 * rework prompt applies.
 */
export function priorRoundOf(items: RequirementReviewItem[]): PriorRound {
  const answered = items
    .filter((i) => (i.status === 'answered' || i.status === 'resolved') && i.reply?.trim())
    .map((i, index) => ({
      ref: `A${index + 1}`,
      title: i.title,
      detail: i.detail,
      reply: i.reply!.trim(),
    }))
  const dismissed = items.filter((i) => i.status === 'dismissed').map((i) => i.title)
  return { answered, dismissed }
}

/** The ref → answered-finding title map a reviewer's `followsUp` citation is resolved against. */
export function followUpRefs(round: PriorRound): ReadonlyMap<string, string> {
  return new Map(round.answered.map((a) => [a.ref, a.title]))
}

/**
 * Drop what a re-review raised that clears neither half of the bar, and count it. Null `round`
 * is a first pass: everything is kept and nothing is counted.
 */
export function applyFollowUpBar(
  items: RequirementReviewItem[],
  round: PriorRound | null,
): { items: RequirementReviewItem[]; suppressed: number | null } {
  if (!round) return { items, suppressed: null }
  const kept = items.filter((i) => i.severity === 'high' || !!i.followsUpOn)
  return { items: kept, suppressed: items.length - kept.length }
}

/** Keeps a multi-line answer inside its list entry, so its own lines cannot read as another ref. */
function indentContinuation(text: string): string {
  return text.replace(/\r?\n/g, '\n    ')
}

/** The re-review section of the reviewer's user prompt: what the last round settled, and the bar. */
export function renderPriorRoundLines(round: PriorRound): string[] {
  const lines = ['## What the previous review round settled', '']
  if (round.answered.length) {
    lines.push(
      'The product owner answered these findings. The requirements above already fold the ' +
        'answers in:',
      '',
    )
    for (const a of round.answered) {
      lines.push(
        `- [${a.ref}] ${a.title}: ${indentContinuation(a.detail)}`,
        `  Answer: ${indentContinuation(a.reply)}`,
      )
    }
    lines.push('')
  }
  if (round.dismissed.length) {
    lines.push('They dismissed these as out of scope. Do not raise them again in any form:', '')
    for (const title of round.dismissed) lines.push(`- ${title}`)
    lines.push('')
  }
  lines.push(
    'This is a RE-REVIEW of requirements the product owner has just worked through. Do not ' +
      're-raise anything listed above, and do not reopen parts of the requirements the last ' +
      'round did not change. Raise a finding only when at least one of these holds:',
    '- it is `high` severity: it would block a correct implementation;',
    '- it follows directly from one of the answers above: that answer introduced a behaviour, ' +
      'rule or scope whose own gap you are raising. Cite the answer in `followsUp` by its ref ' +
      '(for example "A1").',
    'Leave out everything else entirely. Do not raise a severity to keep a finding, and do not ' +
      'cite an answer the finding does not follow from. Set `followsUp` to null when a `high` ' +
      'finding follows from no answer.',
    '',
  )
  return lines
}
