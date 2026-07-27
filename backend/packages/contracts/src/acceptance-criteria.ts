import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-service ACCEPTANCE CRITERIA.
//
// The requirements-review loop produces a high-quality incorporated requirements
// document and then loses it: it lives on the run's review row, shapes one
// spec-writer dispatch, and never outlives the task. Nothing at the SERVICE level
// accumulates what the service is supposed to do, so the tester and the pre-PR
// validation loop verify generic health (suite green, build passes) rather than the
// specific behaviours a task was accepted against.
//
// An acceptance criterion is one durable, service-scoped statement of required
// behaviour in given/when/then form. Criteria are stored per SERVICE FRAME (resolved
// up the frame chain, exactly like `validation_configs` / `release_health_configs`),
// accrete automatically from settled requirements reviews as `proposed`, and only
// steer agents once a human CONFIRMS them.
//
// See docs/initiatives/acceptance-criteria-store.md.
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one criterion.
 *  - `proposed`  — extracted from a settled requirements review, awaiting a human. NEVER
 *                  reaches a prompt: an extraction pass is a model call, and a hallucinated
 *                  "requirement" that steered the coder before anyone read it would be worse
 *                  than having no store at all.
 *  - `confirmed` — a human accepted it. This is the ONLY status that feeds dispatch, the
 *                  tester's per-criterion verdicts and the PR report.
 *  - `retired`   — no longer required (superseded, or wrong). Kept rather than deleted so a
 *                  later extraction pass doesn't cheerfully re-propose it every run.
 */
export const acceptanceCriterionStatusSchema = v.picklist(['proposed', 'confirmed', 'retired'])
export type AcceptanceCriterionStatus = v.InferOutput<typeof acceptanceCriterionStatusSchema>

/**
 * Where a criterion came from.
 *  - `authored` — a human wrote it in the service inspector.
 *  - `derived`  — the accretion pass extracted it from an incorporated requirements document
 *                 (`sourceReviewId` names which one).
 */
export const acceptanceCriterionProvenanceSchema = v.picklist(['authored', 'derived'])
export type AcceptanceCriterionProvenance = v.InferOutput<
  typeof acceptanceCriterionProvenanceSchema
>

/** Short headline for a criterion — what it is, at a glance, in a list. */
const criterionTitleSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/**
 * One clause of the given/when/outcome triple. `given` may legitimately be empty (a criterion
 * that holds unconditionally), which is why only `when`/`outcome` are required below.
 *
 * The third clause is `outcome`, NOT `then`, matching the in-repo spec's own
 * `acceptanceCriterionSchema` (`contracts/src/spec.ts`) and for the same reason: an object with
 * a `then` member is treated as a THENABLE by the runtime, so any of these that reached a
 * `Promise.resolve`/`await` boundary as a bare value would be at the mercy of whether `then`
 * happened to be callable. Repo convention, and one less trap.
 */
const criterionClauseSchema = v.pipe(v.string(), v.trim(), v.maxLength(2000))
const requiredClauseSchema = v.pipe(criterionClauseSchema, v.minLength(1))

/** A free-form label for grouping/filtering (`auth`, `billing`, `regression`, …). */
const criterionTagSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40))

/** At most this many tags per criterion — they are labels, not prose. */
export const ACCEPTANCE_CRITERION_MAX_TAGS = 10

/**
 * At most this many criteria per service frame. A hard ceiling on both the accretion pass and
 * hand-authoring: past this the list stops being a spec a human curates and starts being a
 * dumping ground, and every dispatch would carry it. Reaching it is a signal to retire stale
 * criteria (or split the service), not to raise the number.
 */
export const ACCEPTANCE_CRITERIA_MAX_PER_FRAME = 200

/**
 * At most this many criteria the ACCRETION pass may add in one settlement. The extraction is a
 * model call over one document; a pass that wants to add fifty criteria has misread the
 * document, and the cost of that mistake is a human triaging fifty `proposed` rows.
 */
export const ACCEPTANCE_CRITERIA_MAX_PER_EXTRACTION = 12

/**
 * The most criteria — and the most characters of them — that may be RENDERED into one agent
 * prompt. Separate from {@link ACCEPTANCE_CRITERIA_MAX_PER_FRAME} because the two bound different
 * things: the store ceiling is about what a human can curate, this is about what a dispatch can
 * carry. At the store ceiling, with clauses at their own 2,000-character limit, an uncapped
 * section would be over a megabyte of prompt on EVERY standard phase.
 *
 * Whichever bound is hit first stops the list, and the renderer then states how many it left out
 * — a silently truncated behavioural contract reads exactly like a complete one, which is the
 * failure this feature exists to remove.
 */
export const ACCEPTANCE_CRITERIA_PROMPT_MAX_ENTRIES = 50
export const ACCEPTANCE_CRITERIA_PROMPT_MAX_CHARS = 12_000

/** One persisted acceptance criterion, as the wire sees it. */
export const serviceAcceptanceCriterionSchema = v.object({
  id: v.string(),
  /** The SERVICE FRAME block this criterion belongs to. */
  blockId: v.string(),
  title: criterionTitleSchema,
  /** Precondition / context. May be empty for a criterion that holds unconditionally. */
  given: criterionClauseSchema,
  /** The action or trigger. */
  when: requiredClauseSchema,
  /** The observable outcome — what makes the criterion verifiable. */
  outcome: requiredClauseSchema,
  tags: v.array(criterionTagSchema),
  status: acceptanceCriterionStatusSchema,
  provenance: acceptanceCriterionProvenanceSchema,
  /** The requirements review this was extracted from; null for a hand-authored criterion. */
  sourceReviewId: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type ServiceAcceptanceCriterion = v.InferOutput<typeof serviceAcceptanceCriterionSchema>

/** Create a criterion by hand from the service inspector. */
export const createAcceptanceCriterionSchema = v.object({
  title: criterionTitleSchema,
  given: v.optional(criterionClauseSchema, ''),
  when: requiredClauseSchema,
  outcome: requiredClauseSchema,
  tags: v.optional(v.pipe(v.array(criterionTagSchema), v.maxLength(ACCEPTANCE_CRITERION_MAX_TAGS))),
  /**
   * Omitted ⇒ `confirmed`: a human typing a criterion into the inspector has, by the act of
   * typing it, confirmed it. `proposed` exists for the accretion pass, not for this route.
   */
  status: v.optional(acceptanceCriterionStatusSchema),
})
export type CreateAcceptanceCriterionInput = v.InferOutput<typeof createAcceptanceCriterionSchema>

/**
 * Patch a criterion. Every field optional — the common call is a status flip
 * (`proposed` → `confirmed` / `retired`) from the inspector's triage list.
 */
export const updateAcceptanceCriterionSchema = v.pipe(
  v.object({
    title: v.optional(criterionTitleSchema),
    given: v.optional(criterionClauseSchema),
    when: v.optional(requiredClauseSchema),
    outcome: v.optional(requiredClauseSchema),
    tags: v.optional(
      v.pipe(v.array(criterionTagSchema), v.maxLength(ACCEPTANCE_CRITERION_MAX_TAGS)),
    ),
    status: v.optional(acceptanceCriterionStatusSchema),
  }),
  v.check(
    (o) => Object.values(o).some((value) => value !== undefined),
    'an update must change at least one field',
  ),
)
export type UpdateAcceptanceCriterionInput = v.InferOutput<typeof updateAcceptanceCriterionSchema>

/** What `GET .../acceptance-criteria` returns for one service frame. */
export const serviceAcceptanceCriteriaSchema = v.object({
  blockId: v.string(),
  criteria: v.array(serviceAcceptanceCriterionSchema),
})
export type ServiceAcceptanceCriteria = v.InferOutput<typeof serviceAcceptanceCriteriaSchema>

/**
 * One criterion as a DISPATCH sees it — the confirmed subset, stripped of the lifecycle
 * bookkeeping an agent has no use for. The `id` stays, because it is the key the tester's
 * per-criterion verdicts and the PR report's evidence table join on.
 */
export const resolvedAcceptanceCriterionSchema = v.object({
  id: v.string(),
  title: v.string(),
  given: v.string(),
  when: v.string(),
  outcome: v.string(),
  tags: v.array(v.string()),
})
export type ResolvedAcceptanceCriterion = v.InferOutput<typeof resolvedAcceptanceCriterionSchema>

/**
 * The RESOLVED criteria a dispatch carries: the frame-chain walk's result, folded onto the
 * agent run context and rendered into the spec-writer / coder / tester prompts. Absent ⇒ the
 * service has no CONFIRMED criteria, so every prompt is byte-for-byte what it was before this
 * feature existed.
 */
export const resolvedAcceptanceCriteriaSchema = v.object({
  criteria: v.array(resolvedAcceptanceCriterionSchema),
})
export type ResolvedAcceptanceCriteria = v.InferOutput<typeof resolvedAcceptanceCriteriaSchema>

/**
 * One criterion the ACCRETION pass extracted from an incorporated requirements document,
 * before it is persisted. Lenient (`v.fallback`) because it is parsed out of model output:
 * a malformed clause degrades to empty and is dropped by the service rather than throwing
 * inside a settled review.
 */
export const acceptanceCriterionDraftSchema = v.object({
  title: v.fallback(v.string(), ''),
  given: v.fallback(v.string(), ''),
  when: v.fallback(v.string(), ''),
  outcome: v.fallback(v.string(), ''),
  tags: v.fallback(v.array(v.string()), []),
})
export type AcceptanceCriterionDraft = v.InferOutput<typeof acceptanceCriterionDraftSchema>

/** Parse a batch of extracted drafts (lenient — malformed entries degrade, never throw). */
export function parseAcceptanceCriterionDrafts(value: unknown): AcceptanceCriterionDraft[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => v.parse(acceptanceCriterionDraftSchema, entry))
}

/**
 * Normalise a criterion title for DUPLICATE detection within a frame.
 *
 * Every run of the same task re-extracts near-identical criteria, so without this the store
 * grows one duplicate per run and the human triage list becomes useless. Case/whitespace/
 * punctuation-insensitive is deliberately coarse: a false MERGE costs one criterion the human
 * edits, a false SPLIT costs a duplicate on every future run.
 */
export function normalizeCriterionTitle(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
}
