import type { Block, RequirementReviewItem } from '@cat-factory/kernel'

// Pure logic for the clarity-review (bug-report triage) agent: assembling the bug
// report under review (the block description, optionally enriched by an upstream
// `bug-investigator` step's prose report), and building the triage + rework prompts.
// The item parsing / disposition helpers are subject-agnostic and REUSED from the
// requirements logic — this file only supplies the clarity-specific subject + prompts.
//
// Re-export the shared helpers so the clarity service imports its whole logic surface
// from here (one import site), mirroring how `requirements.logic` is the requirements
// service's surface.
export {
  coerceReviewItems,
  disposeReview,
  extractJson,
  hasNotesToIncorporate,
  type ReviewDisposition,
} from '../requirements/requirements.logic.js'

/** Everything the clarity reviewer reasons over: the bug report plus any investigation. */
export interface ClarityContext {
  block: Pick<Block, 'title' | 'type' | 'description'>
  /**
   * The prose report an upstream `bug-investigator` step produced (enriched bug report +
   * optional working hypothesis). When present it is the primary triage subject — the raw
   * description becomes background. Absent when no investigator ran.
   */
  investigation?: string
  /**
   * The clarified bug report produced by a prior incorporation. When present (a re-review
   * or a redo), it is the authoritative report the reviewer/rework reasons over. Absent on
   * the first pass.
   */
  clarifiedDoc?: string
  /** The human's freeform "do it differently" comment when redoing a merge. Absent otherwise. */
  reworkFeedback?: string
}

/**
 * Render the bug report under review as a single Markdown document — the clarified report
 * when one exists (a later cycle), else the block description plus the investigator's
 * enriched report when present. Used both as the reviewer's input and as the base the
 * incorporate step rewrites.
 */
export function renderBugReport(ctx: ClarityContext): string {
  const lines: string[] = ctx.clarifiedDoc?.trim()
    ? [
        `# ${ctx.block.title} (${ctx.block.type})`,
        '',
        '## Current standardized bug report (under review)',
        ctx.clarifiedDoc.trim(),
      ]
    : [
        `# ${ctx.block.title} (${ctx.block.type})`,
        '',
        '## Reported bug',
        ctx.block.description?.trim() || '(no description provided)',
      ]
  if (!ctx.clarifiedDoc?.trim() && ctx.investigation?.trim()) {
    lines.push('', '## Investigation (read-only findings from the codebase)', ctx.investigation.trim())
  }
  return lines.join('\n')
}

export function buildClarityPrompt(ctx: ClarityContext): string {
  return [
    'Here is the bug report to triage for fixability:',
    '',
    renderBugReport(ctx),
    '',
    'Produce a JSON object of this exact shape:',
    '{',
    '  "items": [',
    '    {',
    '      "category": "gap|clarification|assumption|risk|question",',
    '      "severity": "low|medium|high",',
    '      "title": "short headline of the concern",',
    '      "detail": "the full question / gap / challenge, phrased for the bug reporter"',
    '    }',
    '  ]',
    '}',
    '',
    'Assign a severity to EVERY item — no item may omit it. Use `high` for a missing detail ' +
      'that would block a confident fix (e.g. no reproduction steps), `medium` for one that ' +
      'risks fixing the wrong thing, and `low` for a minor clarification. Raise between 0 and ' +
      '20 items, ordered by severity (high first). If the bug report is genuinely clear and ' +
      'fixable, return an empty items array. Output JSON only.',
  ].join('\n')
}

/**
 * Build the user prompt for the clarity-rework step: the gathered bug report plus the
 * human's answers (folded in) and dismissals (kept out). Works with an empty item list
 * (the "no challenges" path simply restates the report in the standard structure). The
 * {@link CLARITY_REWORK_SYSTEM_PROMPT} (in `@cat-factory/agents`) defines the output shape.
 */
export function buildClarityReworkPrompt(
  ctx: ClarityContext,
  items: RequirementReviewItem[],
): string {
  const lines: string[] = ['Current bug report:', '', renderBugReport(ctx), '']
  const answered = items.filter(
    (i) => (i.status === 'answered' || i.status === 'resolved') && i.reply?.trim(),
  )
  const dismissed = items.filter((i) => i.status === 'dismissed')
  if (answered.length) {
    lines.push('Clarifications the reporter provided (fold these in):', '')
    for (const i of answered) {
      lines.push(`- Q (${i.category}): ${i.title} — ${i.detail}`)
      lines.push(`  A: ${i.reply?.trim() || '(no answer recorded)'}`)
    }
    lines.push('')
  }
  if (dismissed.length) {
    lines.push('Items the reporter dismissed as out of scope (do NOT add these):', '')
    for (const i of dismissed) lines.push(`- ${i.title}`)
    lines.push('')
  }
  if (!answered.length && !dismissed.length) {
    lines.push(
      'The reviewer raised no open questions — restate the bug report cleanly in the ' +
        'standard structure without inventing new facts.',
      '',
    )
  }
  if (ctx.reworkFeedback?.trim()) {
    lines.push(
      '',
      'The reviewer was UNHAPPY with your previous reworked report and asked you to redo it ' +
        'with this specific direction — follow it closely:',
      '',
      ctx.reworkFeedback.trim(),
      '',
    )
  }
  lines.push(
    'Rewrite the bug report as a single self-contained Markdown document in the standard ' +
      'structure described in your instructions, folding in every answer above. Output the ' +
      'revised bug report only.',
  )
  return lines.join('\n')
}
