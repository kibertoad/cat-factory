import type {
  Block,
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
} from '@cat-factory/kernel'

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
}

/**
 * Render the block's "collected requirements" as a single Markdown document —
 * its description plus any linked PRD/RFC pages and tracker
 * issues. Used both as the reviewer's input and as the base the incorporate step
 * rewrites.
 */
export function renderRequirements(ctx: RequirementsContext): string {
  const lines: string[] = [
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

export const INCORPORATE_SYSTEM_PROMPT =
  'You are a requirements editor. You are given the current collected requirements for a ' +
  'unit of software work, plus clarifying questions and the answers a human gave. Produce a ' +
  'revised, self-contained requirements document in Markdown that folds every answer into ' +
  'the requirements, resolves the ambiguities, and states the previously-missing details ' +
  'explicitly. Preserve the original intent and structure; do not invent facts beyond what ' +
  'the answers provide. Respond with ONLY the revised requirements in Markdown — no ' +
  'preamble, no commentary, no code fences.'

export function buildIncorporatePrompt(
  ctx: RequirementsContext,
  items: RequirementReviewItem[],
): string {
  const lines: string[] = ['Current collected requirements:', '', renderRequirements(ctx), '']
  const resolved = items.filter((i) => i.status === 'resolved')
  const dismissed = items.filter((i) => i.status === 'dismissed')
  if (resolved.length) {
    lines.push('Clarifications the product owner provided (fold these in):', '')
    for (const i of resolved) {
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
  lines.push(
    'Rewrite the requirements as a single Markdown document that incorporates every answer ' +
      'above. Output the revised requirements only.',
  )
  return lines.join('\n')
}
