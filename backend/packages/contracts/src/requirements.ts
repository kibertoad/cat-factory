import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Requirements-review wire contracts. A stateless reviewer agent inspects a
// board block's "collected requirements" — its description plus any linked
// PRD / RFC / requirements documents and tracker issues — and raises a list of
// review items: gaps, ambiguities, unstated assumptions, risks and open
// questions. A human answers or dismisses each item; once every item is settled
// the agent folds the answers back into the block's requirements (the
// "incorporate" step).
//
// Unlike the execution / bootstrap flows this is fully synchronous and
// stateless — there is no container and no durable driver — so the review and
// its items are persisted (migration 0021) but mutated in plain request/response
// round-trips. Storage-only bookkeeping (the owning workspace) is NOT on the
// wire; it lives in the core ports / D1 layer.
// ---------------------------------------------------------------------------

/** What kind of concern a review item raises. */
export const reviewItemCategorySchema = v.picklist([
  'gap',
  'clarification',
  'assumption',
  'risk',
  'question',
])
export type ReviewItemCategory = v.InferOutput<typeof reviewItemCategorySchema>

/** How important resolving the item is before implementation should proceed. */
export const reviewItemSeveritySchema = v.picklist(['low', 'medium', 'high'])
export type ReviewItemSeverity = v.InferOutput<typeof reviewItemSeveritySchema>

/**
 * Lifecycle of a single item: `open` until a human engages, `answered` once a
 * reply is recorded, `resolved` when accepted as done, `dismissed` when waved
 * off as not applicable. Both `resolved` and `dismissed` count as "settled" for
 * the purpose of gating incorporation.
 */
export const reviewItemStatusSchema = v.picklist(['open', 'answered', 'resolved', 'dismissed'])
export type ReviewItemStatus = v.InferOutput<typeof reviewItemStatusSchema>

/** A single question / challenge the reviewer raised about the requirements. */
export const requirementReviewItemSchema = v.object({
  id: v.string(),
  category: reviewItemCategorySchema,
  severity: reviewItemSeveritySchema,
  /** Short headline of the concern. */
  title: v.string(),
  /** The full question / gap / challenge, in plain prose. */
  detail: v.string(),
  status: reviewItemStatusSchema,
  /** The human's answer, or null while unanswered. */
  reply: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReviewItem = v.InferOutput<typeof requirementReviewItemSchema>

/**
 * Lifecycle of the review as a whole: `ready` once items are generated and
 * awaiting human answers, `incorporated` once the answers have been folded back
 * into the block's requirements.
 */
export const requirementReviewStatusSchema = v.picklist(['ready', 'incorporated'])
export type RequirementReviewStatus = v.InferOutput<typeof requirementReviewStatusSchema>

/** A completed requirements review for one board block. */
export const requirementReviewSchema = v.object({
  id: v.string(),
  blockId: v.string(),
  status: requirementReviewStatusSchema,
  items: v.array(requirementReviewItemSchema),
  /** `provider:model` that produced the review, for transparency; null in tests. */
  model: v.nullable(v.string()),
  /**
   * The revised requirements text the reviewer last folded the answers into (the
   * new block description). Null until an incorporate run has completed.
   */
  incorporatedRequirements: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type RequirementReview = v.InferOutput<typeof requirementReviewSchema>

// ---- Request bodies -------------------------------------------------------

/** Record a human's answer to a single review item. */
export const replyReviewItemSchema = v.object({
  reply: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
})
export type ReplyReviewItemInput = v.InferOutput<typeof replyReviewItemSchema>

/** Set a review item's status (resolve / dismiss / reopen). */
export const updateReviewItemStatusSchema = v.object({
  status: reviewItemStatusSchema,
})
export type UpdateReviewItemStatusInput = v.InferOutput<typeof updateReviewItemStatusSchema>

// ---------------------------------------------------------------------------
// Unified in-repo requirements artifact (prescriptive, service-level).
//
// Where the per-task review above is a transient clarification loop (one block at
// a time, persisted in D1), this is the durable PRESCRIPTIVE spec for a whole
// service, persisted in the service's own GitHub repo under `requirements/` and
// aggregated across every task. It is the mirror image of the blueprint: a
// blueprint is DESCRIPTIVE ("what the code is"), these requirements are
// PRESCRIPTIVE ("what must be true"). The canonical, machine-readable file is
// `requirements.json` (a RequirementsDoc); the markdown files (`overview.md`,
// `rules.md`) and the Gherkin `features/*.feature` files are deterministic
// renderings of the same tree. Every agent reads it as context, and its
// acceptance criteria seed the test scenarios.
// ---------------------------------------------------------------------------

const requirementIdField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))
const reqNameField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
const reqSummaryField = v.pipe(v.string(), v.maxLength(2000))
const reqStatementField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000))
const blockIdField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** MoSCoW priority — how essential a requirement is. */
export const requirementPrioritySchema = v.picklist(['must', 'should', 'could'])
export type RequirementPriority = v.InferOutput<typeof requirementPrioritySchema>

/** Whether a requirement is a behaviour, a quality attribute, or a hard constraint. */
export const requirementKindSchema = v.picklist(['functional', 'nonfunctional', 'constraint'])
export type RequirementKind = v.InferOutput<typeof requirementKindSchema>

/**
 * A single acceptance criterion in structured Given/When/Then form — the seed for
 * one Gherkin `Scenario`. Kept structured (not prose) so the harness can render it
 * mechanically and deterministically into a `.feature` file.
 */
export const acceptanceCriterionSchema = v.object({
  id: requirementIdField,
  given: v.pipe(v.string(), v.maxLength(2000)),
  when: v.pipe(v.string(), v.maxLength(2000)),
  // The Gherkin "Then" clause. Named `outcome` (not `then`) so the object is never
  // accidentally thenable — an object with a `then` member misbehaves under `await`.
  outcome: v.pipe(v.string(), v.maxLength(2000)),
})
export type AcceptanceCriterion = v.InferOutput<typeof acceptanceCriterionSchema>

/** A single prescriptive requirement, traceable back to the board task(s) it came from. */
export const requirementItemSchema = v.object({
  /** Stable slug, e.g. `req-login-rate-limit`. */
  id: requirementIdField,
  /** Short headline. */
  title: reqNameField,
  /** The requirement itself, as `The system SHALL …` prose. */
  statement: reqStatementField,
  kind: requirementKindSchema,
  priority: requirementPrioritySchema,
  /** Ids of the board task/block(s) this requirement was aggregated from (provenance). */
  sourceBlockIds: v.optional(v.array(blockIdField), []),
  /** Structured acceptance criteria → the seed for this requirement's Gherkin scenarios. */
  acceptance: v.optional(v.array(acceptanceCriterionSchema), []),
})
export type RequirementItem = v.InferOutput<typeof requirementItemSchema>

/**
 * A cross-cutting domain rule / invariant / constraint — prescriptive, but not tied
 * to a single capability. Unified into THIS document (not a separate `domain/`
 * artifact) because rules share the requirements' lifecycle; rendered to `rules.md`.
 */
export const domainRuleSchema = v.object({
  id: requirementIdField,
  /** The invariant, e.g. `An order may never have a negative total.` */
  rule: reqStatementField,
  /** Why the rule exists (optional). */
  rationale: v.optional(reqSummaryField, ''),
  sourceBlockIds: v.optional(v.array(blockIdField), []),
})
export type DomainRule = v.InferOutput<typeof domainRuleSchema>

/** A grouping of related requirements (a capability / feature area ≈ one `.feature` file). */
export const requirementGroupSchema = v.object({
  name: reqNameField,
  summary: v.optional(reqSummaryField, ''),
  requirements: v.optional(v.array(requirementItemSchema), []),
})
export type RequirementGroup = v.InferOutput<typeof requirementGroupSchema>

/** The unified, prescriptive requirements document for one service (the `requirements.json` tree). */
export const requirementsDocSchema = v.object({
  /** Service / frame name (defaults to the repo name). */
  service: reqNameField,
  /** One-paragraph product intent for the service overall. */
  summary: v.optional(reqSummaryField, ''),
  /** Requirements grouped by capability; each group renders one `.feature` file. */
  groups: v.optional(v.array(requirementGroupSchema), []),
  /** Cross-cutting domain rules / invariants / constraints. */
  rules: v.optional(v.array(domainRuleSchema), []),
})
export type RequirementsDoc = v.InferOutput<typeof requirementsDocSchema>

/**
 * The lightweight `version.json` manifest committed alongside the requirements. It
 * carries a monotonic version counter, the generation timestamp, a content hash of
 * the canonical tree, and the requirement/rule counts — so staleness checks are a
 * tiny read rather than a full parse of `requirements.json`. Mirrors the blueprint's
 * `version.json` manifest field-for-field in spirit.
 */
export const requirementsVersionSchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  generatedAt: v.string(),
  /** sha256 (hex) of the canonical `requirements.json` bytes. */
  hash: v.string(),
  requirements: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rules: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type RequirementsVersion = v.InferOutput<typeof requirementsVersionSchema>

// ---- In-repo requirements artifact paths ----------------------------------
// The folder + file layout, the prescriptive sibling of `blueprints/`. The
// canonical machine-readable file is `requirements.json`; the markdown and feature
// files are deterministic renderings of the same tree.

/** Folder, relative to the repo root, that holds the persisted requirements. */
export const REQUIREMENTS_DIR = 'requirements'
/** Canonical machine-readable requirements file (the RequirementsDoc tree). */
export const REQUIREMENTS_JSON_PATH = `${REQUIREMENTS_DIR}/requirements.json`
/** High-level overview markdown — the file agents read first. */
export const REQUIREMENTS_OVERVIEW_PATH = `${REQUIREMENTS_DIR}/overview.md`
/** Domain rules / invariants / constraints markdown. */
export const REQUIREMENTS_RULES_PATH = `${REQUIREMENTS_DIR}/rules.md`
/** Tiny manifest read for quick staleness checks without parsing the full tree. */
export const REQUIREMENTS_VERSION_PATH = `${REQUIREMENTS_DIR}/version.json`
/** Sub-folder holding the generated Gherkin `.feature` files (one per group). */
export const REQUIREMENTS_FEATURES_DIR = `${REQUIREMENTS_DIR}/features`

/**
 * Strictly parse an arbitrary value (e.g. the JSON read from `requirements.json`, or
 * a tree returned by the requirements-writer container) into a {@link RequirementsDoc},
 * enforcing the exact schema shape. Throws on any shape violation, so a bad payload
 * can never be ingested. Use it at every trust boundary that ingests requirements.
 */
export function parseRequirementsDoc(value: unknown): RequirementsDoc {
  return v.parse(requirementsDocSchema, value)
}

/** Non-throwing variant: returns the parsed doc or `undefined` when invalid. */
export function safeParseRequirementsDoc(value: unknown): RequirementsDoc | undefined {
  const result = v.safeParse(requirementsDocSchema, value)
  return result.success ? result.output : undefined
}
