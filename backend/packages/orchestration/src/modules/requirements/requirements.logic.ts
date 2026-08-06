import type {
  Block,
  DocumentFreshness,
  OwnServiceContext,
  RequirementConcernLevel,
  RequirementReviewItem,
  ReviewItemCategory,
  ReviewItemSeverity,
} from '@cat-factory/kernel'
import { freshnessHeaderLines } from '@cat-factory/kernel'
import type { RecommendationSource } from '@cat-factory/contracts'
import { REQUIREMENT_CONCERN_RANK } from '@cat-factory/contracts'
import { productIsIdentifiedFrom, renderProductContextLines } from '../review/product-context.js'

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
  /**
   * What the dispatch-time refresh concluded about this excerpt's currency, rendered exactly as it
   * is for every other reader of a linked document. Absent when no refresher is wired, which the
   * renderer treats as "nothing to state", which is the prior behaviour, byte for byte.
   */
  freshness?: DocumentFreshness
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
   * Which system this work belongs to — the enclosing service frame, or the positive reason there
   * is none. The reviewer runs INLINE with no checkout, so this is its only means of knowing what
   * software is under discussion; `renderProductContext` states the unresolved case rather than
   * omitting it. Absent only for a caller that does not resolve it (a test fake), which renders
   * nothing either way.
   */
  service?: OwnServiceContext
  /**
   * One-paragraph intent lifted from the service repo's committed `spec/overview.md`, when the
   * repo is readable. Grounds the reviewer in what the service actually is, beyond its board
   * title. Absent when unwired, unreadable or empty.
   */
  specIntent?: string
  /**
   * The converged direction an upstream `requirements-brainstorm` dialogue settled on. When
   * present it is the primary subject the reviewer critiques — the rough description that fed the
   * dialogue is kept ALONGSIDE it (see {@link renderRequirements}) rather than replaced.
   */
  refinedDirection?: string
  /**
   * The standardized requirements document produced by a prior incorporation. When
   * present (a re-review or a redo), it is the authoritative requirements text the
   * reviewer/rework reasons over — the original description + linked context stay in the prompt
   * as background reference. Absent on the first pass.
   */
  incorporatedDoc?: string
  /**
   * The human's freeform "do it differently" comment when redoing a merge they were
   * unhappy with — folded into the next rework so it corrects course. Absent otherwise.
   */
  reworkFeedback?: string
}

/**
 * Render the system this work belongs to (shared renderer — see `review/product-context.ts`, which
 * holds why the unresolved case is stated rather than omitted), plus the service's own statement of
 * intent from its committed `spec/overview.md` when one was readable.
 */
export function renderProductContext(ctx: RequirementsContext): string[] {
  return renderProductContextLines(ctx.service, 'reason', {
    label: 'From the service specification (`spec/overview.md`):',
    body: ctx.specIntent ?? '',
  })
}

/**
 * Render the block's "collected requirements" as a single Markdown document — the system the work
 * belongs to, the current subject (the standardized incorporated document on a later cycle, else
 * the brainstormed direction, else the raw description), and any linked PRD/RFC pages and tracker
 * issues. Used both as the reviewer's input and as the base the incorporate step rewrites.
 *
 * A derived subject (an incorporated document, a brainstormed direction) NEVER displaces the
 * requester's own words: it is rendered above them, and the original description stays in the
 * prompt labelled as the original request. Displacement was how a single stray assumption became
 * permanent — the incorporated document is authoritative on the next pass, so once one pass wrote
 * an assumed product into it, no later pass could see the request it came from, and every
 * re-review re-derived from the drifted text. Keeping the original in view is what lets both the
 * reviewer and a human notice the drift.
 */
export function renderRequirements(ctx: RequirementsContext): string {
  const heading = [`# ${ctx.block.title} (${ctx.block.type})`, ...renderProductContext(ctx)]
  const original = ctx.block.description?.trim()
  const derived = ctx.incorporatedDoc?.trim()
    ? {
        title: 'Current standardized requirements (under review)',
        body: ctx.incorporatedDoc.trim(),
      }
    : ctx.refinedDirection?.trim()
      ? {
          title: 'Requirements direction (agreed in the brainstorm)',
          body: ctx.refinedDirection.trim(),
        }
      : undefined
  const lines: string[] = derived
    ? [
        ...heading,
        '',
        `## ${derived.title}`,
        derived.body,
        '',
        '## Original request (as written by the requester)',
        original || '(no description provided)',
        '',
        'The section above is derived from this original request. Where the two disagree about ' +
          'what is being built, treat the derived document as the current subject but FLAG the ' +
          'divergence — it means an earlier pass drifted.',
      ]
    : [...heading, '', '## Description', original || '(no description provided)']
  if (ctx.docs.length) {
    lines.push('', '## Linked requirement / PRD / RFC documents')
    for (const d of ctx.docs) {
      // The same freshness note every other reader of a linked document gets. This review is the
      // step a HUMAN signs off on, so an unconfirmed excerpt reaching it unmarked is the worst
      // version of the omission: the sign-off is recorded against a revision nobody verified, and
      // the build two steps later runs on a body the reviewer never saw.
      const freshness = freshnessHeaderLines(d.freshness).trimEnd()
      lines.push('', `### ${d.title} (${d.url})`, ...(freshness ? [freshness] : []), d.excerpt)
    }
  }
  if (ctx.tasks.length) {
    lines.push('', '## Linked tracker issues')
    for (const t of ctx.tasks) {
      lines.push('', `### ${t.key} — ${t.title} [${t.type} / ${t.status}]`, t.description)
    }
  }
  return lines.join('\n')
}

/**
 * Whether the context identifies the system under discussion. Read by the Requirement Writer path
 * to decide whether a product-specific WEB SEARCH is legitimate: searching about a product the
 * model had to guess at launders an invention into cited fact, which is far more convincing to a
 * human than the guess would have been.
 */
export function productIsIdentified(ctx: RequirementsContext): boolean {
  return productIsIdentifiedFrom(ctx.service)
}

export function buildReviewPrompt(ctx: RequirementsContext): string {
  return [
    'Here are the collected requirements to review:',
    '',
    renderRequirements(ctx),
    '',
    ...(productIsIdentified(ctx)
      ? []
      : [
          'Note: the context above does not identify which system this work belongs to. Do not ' +
            'pick one. If knowing it matters for this work, raise THAT as a finding (a `gap` — ' +
            'which service / product is this for?) instead of assuming an answer.',
          '',
        ]),
    'Produce a JSON object of this exact shape:',
    '{',
    '  "items": [',
    '    {',
    '      "category": "gap|clarification|assumption|risk|question",',
    '      "severity": "low|medium|high",',
    '      "title": "short headline of the concern",',
    '      "detail": "the full question / gap / challenge, phrased for a product owner",',
    '      "autoAnswerable": true | false',
    '    }',
    '  ]',
    '}',
    '',
    'Every item must be a PRODUCT / BUSINESS question — user-visible behaviour, business ' +
      'rules and their edge cases, actors and permissions, the meaning of business data, ' +
      'scope boundaries, or a business-level quality expectation stated as an outcome. Do ' +
      'NOT raise technical design questions: technology / framework / library choice, ' +
      'architecture or component decomposition, API, endpoint, schema or data-model shape, ' +
      'algorithms, caching, performance techniques, infrastructure and deployment, or coding ' +
      'and test approach. The Architect and Researcher steps own those and settle them later ' +
      'with the codebase and the technical specification in hand. Before raising an item, ' +
      'apply the test: could a product owner who does not read code answer it from business ' +
      'knowledge alone? If not, leave it out entirely — do not downgrade its severity to ' +
      'squeeze it in. ' +
      'Assign a severity to EVERY item — no item may omit it. Use `high` for a gap or ' +
      'ambiguity that would block correct implementation, `medium` for one that risks ' +
      'rework or a wrong assumption, and `low` for a minor clarification or nice-to-have. ' +
      'Set `autoAnswerable` on EVERY item: true only when a confident answer follows from ' +
      'universal best practice or the context already provided (no product owner needed), ' +
      'false when it needs a real business / product / domain decision or missing information ' +
      '(when unsure, false). ' +
      'Raise between 0 and 20 items, ordered by severity (high first). If the requirements ' +
      'are complete and unambiguous at the product level, or the work is purely technical ' +
      'and changes no user-visible behaviour or business rule, return an empty items array. ' +
      'Output JSON only.',
  ].join('\n')
}

/** Pull the first JSON value out of a model response (tolerates code fences). */
export { extractJson } from '@cat-factory/kernel'

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
      // The reviewer flags whether a finding is answerable without the product owner. Only a
      // literal `true` enables the auto-recommendation; anything else (false / missing / a
      // non-boolean from a sloppy model) is the safe default of "needs a human".
      autoAnswerable: obj.autoAnswerable === true,
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
      'structure described in your instructions, folding in every answer above. Keep it at ' +
      'the product / business level: what the software must do and the rules that govern it, ' +
      'never how it will be built. The Architect step designs that afterwards, using this ' +
      'document as its input — so a technical decision you write in here pre-empts a step ' +
      'that knows the codebase and you do not. Output the revised requirements only.',
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
    for (const fr of grounding.fragments)
      lines.push(`### standard ${fr.id}: ${fr.title}`, fr.body, '')
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
    'Each recommendation must be a product / business decision the owner can accept or reject ' +
      '— a behaviour, rule, limit or scope boundary — not a technical design. Treat the ' +
      'technical material above as a constraint on what you recommend, not as something to ' +
      'recommend; the Architect step owns the design.',
    '',
    'Return ONLY the JSON object described in your instructions (one entry per itemId above).',
  )
  return lines.join('\n')
}

/** One Writer suggestion as parsed off the model's reply, before it is persisted. */
export interface WriterSuggestion {
  recommendation: string
  fromStandard: string | null
  /** The precedence level the Writer reports it came from; null when it reported none. */
  groundedIn: RecommendationSource | null
}

const RECOMMENDATION_SOURCES: RecommendationSource[] = [
  'standard',
  'project-spec',
  'web',
  'general-practice',
]

/**
 * Coerce the Writer's reported grounding level, or null.
 *
 * Null rather than a default, deliberately: a missing or unrecognised value means the Writer did
 * not say, and filling that in with `general-practice` would invent the very provenance claim this
 * field exists to make trustworthy — in the direction that makes a well-grounded answer look
 * weak, while a garbled `standard` would make a guess look authoritative.
 */
function coerceSource(value: unknown): RecommendationSource | null {
  return RECOMMENDATION_SOURCES.includes(value as RecommendationSource)
    ? (value as RecommendationSource)
    : null
}

/**
 * Coerce the Requirement Writer's parsed JSON into a map of itemId → {@link WriterSuggestion}.
 * Tolerant of a bare array or a `{recommendations:[...]}` wrapper; entries
 * missing a recommendation string are dropped.
 */
export function coerceRecommendations(raw: unknown): Map<string, WriterSuggestion> {
  const list = Array.isArray((raw as { recommendations?: unknown })?.recommendations)
    ? ((raw as { recommendations: unknown[] }).recommendations as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const out = new Map<string, WriterSuggestion>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const itemId = asString(obj.itemId)
    const recommendation = asString(obj.recommendation)
    if (!itemId || !recommendation) continue
    const fromStandard = asString(obj.fromStandard)
    out.set(itemId, {
      recommendation,
      fromStandard: fromStandard || null,
      groundedIn: coerceSource(obj.groundedIn),
    })
  }
  return out
}

/**
 * Coerce the Writer's JSON for a MULTI-finding chunk into a map keyed by FINDING id. Prefers the
 * echoed `itemId` to route each suggestion to its finding (so two findings that share an identical
 * title+detail stay distinct), then falls back to POSITIONAL order for any finding the ids didn't
 * cover: models frequently omit or garble the echoed id, and {@link coerceRecommendations} alone
 * would then drop a perfectly usable batched response and force-reopen every finding in the chunk.
 * Entries not consumed by an id match are handed to the still-unanswered findings in prompt order —
 * the order {@link buildRecommendationPrompt} lists them and asks the Writer to answer them in — so
 * a response that echoes no ids still routes correctly as long as it preserves that order.
 */
export function coerceChunkRecommendations(
  raw: unknown,
  findings: RequirementReviewItem[],
): Map<string, WriterSuggestion> {
  const list = Array.isArray((raw as { recommendations?: unknown })?.recommendations)
    ? ((raw as { recommendations: unknown[] }).recommendations as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const entries = list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((obj) => ({
      itemId: asString(obj.itemId),
      recommendation: asString(obj.recommendation),
      fromStandard: asString(obj.fromStandard) || null,
      groundedIn: coerceSource(obj.groundedIn),
    }))
    .filter((e) => e.recommendation)
  const out = new Map<string, WriterSuggestion>()
  const findingIds = new Set(findings.map((f) => f.id))
  const consumed = new Set<number>()
  // Pass 1: route each entry whose echoed itemId names a finding in this chunk.
  entries.forEach((e, idx) => {
    if (e.itemId && findingIds.has(e.itemId) && !out.has(e.itemId)) {
      out.set(e.itemId, {
        recommendation: e.recommendation,
        fromStandard: e.fromStandard,
        groundedIn: e.groundedIn,
      })
      consumed.add(idx)
    }
  })
  // Pass 2: fill any finding the ids didn't cover from the leftover entries, in prompt order.
  const leftover = entries.filter((_, idx) => !consumed.has(idx))
  let li = 0
  for (const f of findings) {
    if (out.has(f.id) || li >= leftover.length) continue
    const e = leftover[li++]!
    out.set(f.id, {
      recommendation: e.recommendation,
      fromStandard: e.fromStandard,
      groundedIn: e.groundedIn,
    })
  }
  return out
}

/**
 * Coerce the Writer's JSON for a SINGLE-finding call. The per-finding recommendation flow
 * prompts the Writer with exactly one finding, so it must tolerate a missing/garbled `itemId`:
 * single-item prompts frequently omit the echoed id, and {@link coerceRecommendations} drops
 * any entry without one — which would silently discard a perfectly good suggestion and
 * force-reopen the finding. So: prefer the entry whose id matches, but when the model returns a
 * lone entry with a recommendation string, take it regardless of the id. Returns null only when
 * there is genuinely no usable recommendation.
 */
export function coerceSingleRecommendation(raw: unknown, itemId: string): WriterSuggestion | null {
  const list = Array.isArray((raw as { recommendations?: unknown })?.recommendations)
    ? ((raw as { recommendations: unknown[] }).recommendations as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []
  const entries = list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((obj) => ({
      itemId: asString(obj.itemId),
      recommendation: asString(obj.recommendation),
      fromStandard: asString(obj.fromStandard) || null,
      groundedIn: coerceSource(obj.groundedIn),
    }))
    .filter((e) => e.recommendation)
  if (entries.length === 0) return null
  const chosen =
    entries.find((e) => e.itemId === itemId) ?? (entries.length === 1 ? entries[0] : null)
  return chosen
    ? {
        recommendation: chosen.recommendation,
        fromStandard: chosen.fromStandard,
        groundedIn: chosen.groundedIn,
      }
    : null
}

/**
 * Resolve the live review item a recommendation answers. Prefers the snapshotted `itemId` (the
 * primary anchor, so two findings with identical title+detail stay distinct), then falls back to
 * title+detail for recommendations created before the id was snapshotted or whose finding id
 * churned across a re-review. Returns undefined when no finding matches.
 */
export function findSourceItem(
  items: RequirementReviewItem[],
  source: { title: string; detail: string; itemId?: string },
): RequirementReviewItem | undefined {
  if (source.itemId) {
    const byId = items.find((i) => i.id === source.itemId)
    if (byId) return byId
  }
  return items.find((i) => i.title === source.title && i.detail === source.detail)
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
  // Guard the loop accounting: a non-positive cap or a sub-1 iteration counter (the initial
  // review is iteration 1) is a wiring bug that would otherwise yield a misleading `exceeded`
  // / never-converging verdict. `iteration` MAY exceed `maxIterations` — a human-granted
  // extra round legitimately runs one past the cap — so that is not checked here.
  if (!Number.isInteger(opts.maxIterations) || opts.maxIterations < 1) {
    throw new Error(
      `disposeReview: maxIterations must be a positive integer, got ${opts.maxIterations}`,
    )
  }
  if (!Number.isInteger(opts.iteration) || opts.iteration < 1) {
    throw new Error(`disposeReview: iteration must be a positive integer, got ${opts.iteration}`)
  }
  const outstanding = items.filter((i) => i.status !== 'dismissed' && i.status !== 'resolved')
  if (outstanding.length === 0) return 'auto-pass'
  const maxRank = Math.max(...outstanding.map((i) => REQUIREMENT_CONCERN_RANK[i.severity]))
  if (maxRank <= REQUIREMENT_CONCERN_RANK[opts.concernThreshold]) return 'auto-pass'
  if (opts.iteration >= opts.maxIterations) return 'exceeded'
  return 'awaiting'
}
