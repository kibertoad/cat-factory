import type {
  Block,
  RequirementConcernLevel,
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
} from '@cat-factory/kernel'
import { REQUIREMENT_CONCERN_RANK } from '@cat-factory/contracts'

// Pure logic for the requirements-review agent: assembling the "collected
// requirements" text from a block + its linked context, building the review and
// incorporate prompts, and coercing the model's JSON response into review items.
// Kept side-effect-free so the integration tests can exercise the prompt/parse
// paths directly and the service stays a thin orchestrator.

const CATEGORIES: ReviewItemCategory[] = ['gap', 'clarification', 'assumption', 'risk', 'question']
const SEVERITIES: ReviewItemSeverity[] = ['low', 'medium', 'high']
const SEVERITY_RANK: Record<ReviewItemSeverity, number> = { high: 0, medium: 1, low: 2 }

/** A requirements/PRD/RFC document linked to the block as context. */
export interface ReviewContextDoc {
  title: string
  url: string
  excerpt: string
}

/** A tracker issue linked to the block as context. */
export interface ReviewContextTask {
  key: string
  title: string
  status: string
  type: string
  description: string
}

/** Everything the reviewer reasons over: the block plus its linked context. */
export interface RequirementsContext {
  block: Pick<Block, 'title' | 'type' | 'description'>
  docs: ReviewContextDoc[]
  tasks: ReviewContextTask[]
  /**
   * The standardized requirements document produced by a prior incorporation. When
   * present (a re-review or a redo), it is the authoritative requirements text the
   * reviewer/rework reasons over — the original description + linked context become
   * background reference. Absent on the first pass.
   */
  incorporatedDoc?: string
  /**
   * The human's freeform "do it differently" comment when redoing a merge they were
   * unhappy with — folded into the next rework so it corrects course. Absent otherwise.
   */
  reworkFeedback?: string
}

/**
 * Render the block's "collected requirements" as a single Markdown document — the
 * standardized incorporated document when one exists (a later review/rework cycle),
 * else the block description, plus any linked PRD/RFC pages and tracker issues. Used
 * both as the reviewer's input and as the base the incorporate step rewrites.
 */
export function renderRequirements(ctx: RequirementsContext): string {
  const lines: string[] = ctx.incorporatedDoc?.trim()
    ? [
        `# ${ctx.block.title} (${ctx.block.type})`,
        '',
        '## Current standardized requirements (under review)',
        ctx.incorporatedDoc.trim(),
      ]
    : [
        `# ${ctx.block.title} (${ctx.block.type})`,
        '',
        '## Description',
        ctx.block.description?.trim() || '(no description provided)',
      ]
  if (ctx.docs.length) {
    lines.push('', '## Linked requirement / PRD / RFC documents')
    for (const d of ctx.docs) lines.push('', `### ${d.title} (${d.url})`, d.excerpt)
  }
  if (ctx.tasks.length) {
    lines.push('', '## Linked tracker issues')
    for (const t of ctx.tasks) {
      lines.push('', `### ${t.key} — ${t.title} [${t.type} / ${t.status}]`, t.description)
    }
  }
  return lines.join('\n')
}

export function buildReviewPrompt(ctx: RequirementsContext): string {
  return [
    'Here are the collected requirements to review:',
    '',
    renderRequirements(ctx),
    '',
    'Produce a JSON object of this exact shape:',
    '{',
    '  "items": [',
    '    {',
    '      "category": "gap|clarification|assumption|risk|question",',
    '      "severity": "low|medium|high",',
    '      "title": "short headline of the concern",',
    '      "detail": "the full question / gap / challenge, phrased for a product owner"',
    '    }',
    '  ]',
    '}',
    '',
    'Assign a severity to EVERY item — no item may omit it. Use `high` for a gap or ' +
      'ambiguity that would block correct implementation, `medium` for one that risks ' +
      'rework or a wrong assumption, and `low` for a minor clarification or nice-to-have. ' +
      'Raise between 0 and 20 items, ordered by severity (high first). If the requirements ' +
      'are genuinely complete and unambiguous, return an empty items array. Output JSON only.',
  ].join('\n')
}

/** Pull the first JSON object out of a model response (tolerates code fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coerceCategory(value: unknown): ReviewItemCategory {
  return CATEGORIES.includes(value as ReviewItemCategory)
    ? (value as ReviewItemCategory)
    : 'question'
}

function coerceSeverity(value: unknown): ReviewItemSeverity {
  return SEVERITIES.includes(value as ReviewItemSeverity) ? (value as ReviewItemSeverity) : 'medium'
}

/**
 * Coerce the model's parsed JSON into review items. Tolerant: unknown
 * categories/severities fall back to sensible defaults, items missing both a
 * title and detail are dropped, and the result is sorted high-severity first and
 * capped so a runaway response can't flood the board.
 */
export function coerceReviewItems(
  raw: unknown,
  newId: () => string,
  now: number,
): RequirementReviewItem[] {
  const list = Array.isArray((raw as { items?: unknown })?.items)
    ? ((raw as { items: unknown[] }).items as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const items: RequirementReviewItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const title = asString(obj.title)
    const detail = asString(obj.detail) || asString(obj.question)
    if (!title && !detail) continue
    items.push({
      id: newId(),
      category: coerceCategory(obj.category),
      severity: coerceSeverity(obj.severity),
      title: title || detail.slice(0, 80),
      detail: detail || title,
      status: 'open',
      reply: null,
      createdAt: now,
      updatedAt: now,
    })
  }
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return items.slice(0, 20)
}

/**
 * Build the user prompt for the requirements-rework step: the gathered context plus
 * the human's answers (resolved items, folded in) and dismissals (kept out). Works
 * with an empty item list too — the "no challenges" path simply restates the
 * requirements in the standard structure. The {@link REWORK_SYSTEM_PROMPT} (in
 * `@cat-factory/agents`) defines the required output structure.
 */
export function buildReworkPrompt(
  ctx: RequirementsContext,
  items: RequirementReviewItem[],
): string {
  const lines: string[] = ['Current collected requirements:', '', renderRequirements(ctx), '']
  // An answered item (the human recorded a reply) is folded in; a resolved one too.
  const answered = items.filter(
    (i) => (i.status === 'answered' || i.status === 'resolved') && i.reply?.trim(),
  )
  const dismissed = items.filter((i) => i.status === 'dismissed')
  if (answered.length) {
    lines.push('Clarifications the product owner provided (fold these in):', '')
    for (const i of answered) {
      lines.push(`- Q (${i.category}): ${i.title} — ${i.detail}`)
      lines.push(`  A: ${i.reply?.trim() || '(no answer recorded)'}`)
    }
    lines.push('')
  }
  if (dismissed.length) {
    lines.push('Items the product owner dismissed as out of scope (do NOT add these):', '')
    for (const i of dismissed) lines.push(`- ${i.title}`)
    lines.push('')
  }
  if (!answered.length && !dismissed.length) {
    lines.push(
      'The reviewer raised no open questions — restate the requirements cleanly in the ' +
        'standard structure without inventing new facts.',
      '',
    )
  }
  // When the human was unhappy with a previous merge and asked to redo it, fold their
  // freeform direction in so this attempt corrects course rather than repeating it.
  if (ctx.reworkFeedback?.trim()) {
    lines.push(
      '',
      'The reviewer was UNHAPPY with your previous reworked document and asked you to ' +
        'redo it with this specific direction — follow it closely:',
      '',
      ctx.reworkFeedback.trim(),
      '',
    )
  }
  lines.push(
    'Rewrite the requirements as a single self-contained Markdown document in the standard ' +
      'structure described in your instructions, folding in every answer above. Output the ' +
      'revised requirements only.',
  )
  return lines.join('\n')
}

/** A best-practice fragment (team/org standard) made available to the Requirement Writer. */
export interface GroundingFragment {
  id: string
  title: string
  body: string
}

/** A web-search result folded into the Writer prompt (gateway-RAG grounding). */
export interface GroundingWebResult {
  title: string
  url: string
  content: string
}

/** Everything the Requirement Writer grounds a recommendation on, in precedence order. */
export interface RecommendationGrounding {
  /** Team/org standards — checked FIRST; a match becomes the recommendation (current standard). */
  fragments: GroundingFragment[]
  /** Relevant in-repo `spec/` (business) + `tech-spec/` (technical) excerpts, pre-rendered. */
  specExcerpts: string[]
  /** Web-search snippets for what the project material leaves open (gateway-RAG path). */
  webResults: GroundingWebResult[]
}

/**
 * Build the Requirement Writer's user prompt: the findings to answer, then the grounding
 * material in precedence order (best-practice fragments → in-repo spec/tech-spec excerpts →
 * web-search snippets). The {@link WRITER_SYSTEM_PROMPT} (in `@cat-factory/agents`) defines
 * the strict JSON output shape and the precedence rule. `note` is an optional human "do it
 * differently" steer for a single re-requested recommendation.
 */
export function buildRecommendationPrompt(
  ctx: RequirementsContext,
  findings: RequirementReviewItem[],
  grounding: RecommendationGrounding,
  note?: string,
): string {
  const lines: string[] = [
    'Recommend an answer for each of these requirements-review findings:',
    '',
  ]
  for (const f of findings) {
    lines.push(`- itemId: ${f.id}`)
    lines.push(`  category: ${f.category} (severity ${f.severity})`)
    lines.push(`  finding: ${f.title} — ${f.detail}`)
  }
  lines.push('', 'Context — the work under review:', '', renderRequirements(ctx))
  if (grounding.fragments.length) {
    lines.push(
      '',
      'BEST-PRACTICE STANDARDS (team/org standards — check these FIRST; if one settles a ' +
        'finding, recommend exactly that and return its id as "fromStandard"):',
      '',
    )
    for (const fr of grounding.fragments) lines.push(`### standard ${fr.id}: ${fr.title}`, fr.body, '')
  }
  if (grounding.specExcerpts.length) {
    lines.push('', 'IN-REPO SPECIFICATIONS (business `spec/` + technical `tech-spec/`):', '')
    for (const ex of grounding.specExcerpts) lines.push(ex, '')
  }
  if (grounding.webResults.length) {
    lines.push('', 'WEB SEARCH RESULTS (for what the project material leaves open):', '')
    for (const w of grounding.webResults) lines.push(`### ${w.title} (${w.url})`, w.content, '')
  }
  if (note?.trim()) {
    lines.push(
      '',
      'The human REJECTED your previous suggestion for one finding and asked you to try ' +
        'again with this steer — follow it closely:',
      '',
      note.trim(),
    )
  }
  lines.push(
    '',
    'Return ONLY the JSON object described in your instructions (one entry per itemId above).',
  )
  return lines.join('\n')
}

/**
 * Coerce the Requirement Writer's parsed JSON into a map of itemId → { recommendation,
 * fromStandard }. Tolerant of a bare array or a `{recommendations:[...]}` wrapper; entries
 * missing a recommendation string are dropped.
 */
export function coerceRecommendations(
  raw: unknown,
): Map<string, { recommendation: string; fromStandard: string | null }> {
  const list = Array.isArray((raw as { recommendations?: unknown })?.recommendations)
    ? ((raw as { recommendations: unknown[] }).recommendations as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const out = new Map<string, { recommendation: string; fromStandard: string | null }>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const itemId = asString(obj.itemId)
    const recommendation = asString(obj.recommendation)
    if (!itemId || !recommendation) continue
    const fromStandard = asString(obj.fromStandard)
    out.set(itemId, { recommendation, fromStandard: fromStandard || null })
  }
  return out
}

/**
 * Whether an incorporation pass has anything to fold in: at least one finding the human
 * answered/resolved with a non-empty reply, or a freeform "do it differently" feedback.
 * When false, the rework + re-review LLM calls would add no new facts — the only thing
 * {@link buildReworkPrompt} could still emit is dismissed items as negative "do NOT add"
 * guidance, never new content — so the engine skips them and settles the review directly
 * (the parallel of a polling gate's "precheck passed, don't spin up the agent" skip).
 * Matches the `answered` filter {@link buildReworkPrompt} uses to decide what gets folded
 * in. Note this changes the all-dismissed case: it no longer produces an LLM-restated
 * (reformatted-but-fact-identical) document; downstream consumes the last incorporated
 * doc if an earlier iteration produced one, else the original description.
 */
export function hasNotesToIncorporate(items: RequirementReviewItem[], feedback?: string): boolean {
  if (feedback?.trim()) return true
  return items.some(
    (i) => (i.status === 'answered' || i.status === 'resolved') && !!i.reply?.trim(),
  )
}

/**
 * What the engine should do with a reviewer pass's findings:
 * - `auto-pass`: no outstanding findings, or every outstanding finding's severity is at
 *   or below the task's tolerated level — record them but advance without a human.
 * - `awaiting`: outstanding findings above the tolerated level and the iteration budget
 *   has room — pause for the human to answer/dismiss.
 * - `exceeded`: outstanding findings above the tolerated level but the iteration budget
 *   is spent — pause for the human to pick how to proceed.
 */
export type ReviewDisposition = 'auto-pass' | 'awaiting' | 'exceeded'

/**
 * Decide a reviewer pass's disposition from its findings, the task's tolerated concern
 * level and the iteration budget. Only OUTSTANDING items (not yet resolved/dismissed)
 * gate the run, so a pass whose findings the human later dismisses converges. Pure so
 * the engine + tests share one rule.
 */
export function disposeReview(
  items: RequirementReviewItem[],
  opts: { iteration: number; maxIterations: number; concernThreshold: RequirementConcernLevel },
): ReviewDisposition {
  const outstanding = items.filter((i) => i.status !== 'dismissed' && i.status !== 'resolved')
  if (outstanding.length === 0) return 'auto-pass'
  const maxRank = Math.max(...outstanding.map((i) => REQUIREMENT_CONCERN_RANK[i.severity]))
  if (maxRank <= REQUIREMENT_CONCERN_RANK[opts.concernThreshold]) return 'auto-pass'
  if (opts.iteration >= opts.maxIterations) return 'exceeded'
  return 'awaiting'
}
