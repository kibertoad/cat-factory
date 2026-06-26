import type { Block, BrainstormStage, RequirementReviewItem } from '@cat-factory/kernel'

// Pure logic for the brainstorm (structured-dialogue) agent: assembling the subject the
// agent reasons over (the rough description for `requirements`, the refined requirements
// for `architecture`), and building the option-generation + rework prompts. The item
// parsing / disposition helpers are subject-agnostic and REUSED from the requirements
// logic — this file only supplies the brainstorm-specific subject + prompts.
//
// Re-export the shared helpers so the brainstorm service imports its whole logic surface
// from here (one import site), mirroring how `requirements.logic` / `clarity.logic` are
// their services' surfaces.
export {
  coerceReviewItems,
  disposeReview,
  extractJson,
  hasNotesToIncorporate,
  type ReviewDisposition,
} from '../requirements/requirements.logic.js'

/** Everything a brainstorm agent reasons over for one stage. */
export interface BrainstormContext {
  block: Pick<Block, 'title' | 'type' | 'description'>
  /** Which dialogue this is — selects the seed subject + the option framing. */
  stage: BrainstormStage
  /**
   * The requirements refined in prior stages (a requirements review's incorporated doc, or a
   * requirements-brainstorm's converged direction). Present only for the `architecture` stage;
   * when present it is the primary seed and the raw description becomes background.
   */
  refinedRequirements?: string
  /**
   * The converged direction produced by a prior incorporation. When present (a re-run or a
   * redo), it is the authoritative direction the agent reasons over. Absent on the first pass.
   */
  convergedDoc?: string
  /** The human's freeform "do it differently" comment when redoing a merge. Absent otherwise. */
  reworkFeedback?: string
}

const stageNoun = (stage: BrainstormStage): string =>
  stage === 'architecture' ? 'technical approach' : 'requirements direction'

/**
 * Render the subject under brainstorm as a single Markdown document — the converged
 * direction when one exists (a later cycle), else the refined requirements (architecture)
 * or the rough description (requirements). Used both as the agent's input and as the base
 * the incorporate step rewrites.
 */
export function renderBrainstormSubject(ctx: BrainstormContext): string {
  if (ctx.convergedDoc?.trim()) {
    return [
      `# ${ctx.block.title} (${ctx.block.type})`,
      '',
      `## Current ${stageNoun(ctx.stage)} (under discussion)`,
      ctx.convergedDoc.trim(),
    ].join('\n')
  }
  const lines = [`# ${ctx.block.title} (${ctx.block.type})`, '']
  if (ctx.stage === 'architecture' && ctx.refinedRequirements?.trim()) {
    lines.push(
      '## Refined requirements (the basis for the approach)',
      ctx.refinedRequirements.trim(),
    )
  } else {
    // For the architecture stage with no refined requirements threaded in, the raw description
    // is the seed — the same fallback as the requirements stage.
    lines.push('## Rough idea', ctx.block.description?.trim() || '(no description provided)')
  }
  return lines.join('\n')
}

export function buildBrainstormPrompt(ctx: BrainstormContext): string {
  const optionSubject =
    ctx.stage === 'architecture'
      ? 'open architectural / technical decisions'
      : 'open product / requirements decisions'
  return [
    `Here is the ${ctx.stage === 'architecture' ? 'work to find an approach for' : 'rough idea to shape into requirements'}:`,
    '',
    renderBrainstormSubject(ctx),
    '',
    `Surface the ${optionSubject} and, for EACH, PROPOSE the realistic options with their ` +
      'trade-offs laid out plainly. Produce a JSON object of this exact shape:',
    '{',
    '  "items": [',
    '    {',
    '      "category": "gap|clarification|assumption|risk|question",',
    '      "severity": "low|medium|high",',
    '      "title": "the decision to make, as a short headline",',
    '      "detail": "the realistic options and their trade-offs (benefit vs cost/risk), ending with a specific question the human can answer to choose"',
    '    }',
    '  ]',
    '}',
    '',
    'Assign a severity to EVERY item — no item may omit it. Use `high` for a decision that ' +
      'shapes everything downstream, `medium` for an important-but-contained choice, and ' +
      '`low` for a minor preference. Raise between 1 and 12 items, ordered by severity (high ' +
      'first). Do NOT pick for the human — your job is to lay out the options and trade-offs ' +
      'clearly. If the direction is already crisp and there is nothing left to decide, return ' +
      'an empty items array. Output JSON only.',
  ].join('\n')
}

/**
 * Build the user prompt for the brainstorm-rework step: the gathered subject plus the
 * options the human picked (folded in) and dismissed (kept out). Works with an empty item
 * list (the "nothing to decide" path simply restates the direction in the standard
 * structure). The stage's rework system prompt (in `@cat-factory/agents`) defines the
 * output shape.
 */
export function buildBrainstormReworkPrompt(
  ctx: BrainstormContext,
  items: RequirementReviewItem[],
): string {
  const lines: string[] = ['Current basis:', '', renderBrainstormSubject(ctx), '']
  const answered = items.filter(
    (i) => (i.status === 'answered' || i.status === 'resolved') && i.reply?.trim(),
  )
  const dismissed = items.filter((i) => i.status === 'dismissed')
  if (answered.length) {
    lines.push('Decisions the human made (commit to these):', '')
    for (const i of answered) {
      lines.push(`- Decision (${i.category}): ${i.title} — ${i.detail}`)
      lines.push(`  Chosen: ${i.reply?.trim() || '(no choice recorded)'}`)
    }
    lines.push('')
  }
  if (dismissed.length) {
    lines.push('Options the human ruled out (do NOT include these):', '')
    for (const i of dismissed) lines.push(`- ${i.title}`)
    lines.push('')
  }
  if (!answered.length && !dismissed.length) {
    lines.push(
      'The human made no specific choices — restate the direction cleanly in the standard ' +
        'structure without inventing new commitments.',
      '',
    )
  }
  if (ctx.reworkFeedback?.trim()) {
    lines.push(
      '',
      'The human was UNHAPPY with your previous direction and asked you to redo it with this ' +
        'specific steering — follow it closely:',
      '',
      ctx.reworkFeedback.trim(),
      '',
    )
  }
  lines.push(
    `Write the ${stageNoun(ctx.stage)} as a single self-contained Markdown document in the ` +
      'standard structure described in your instructions, committing to every decision above. ' +
      'Output the document only.',
  )
  return lines.join('\n')
}
