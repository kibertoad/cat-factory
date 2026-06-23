import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Unified in-repo SPECIFICATION artifact (prescriptive, service-level).
//
// This is the durable PRESCRIPTIVE spec for a whole service, persisted in the
// service's own GitHub repo under `spec/` and aggregated across every task. It is
// the mirror image of the blueprint: a blueprint is DESCRIPTIVE ("what the code
// is"), this spec is PRESCRIPTIVE ("what must be true"). The canonical,
// machine-readable file is `spec.json` (a SpecDoc); the markdown files
// (`overview.md`, `rules.md`) and the Gherkin `features/*.feature` files are
// deterministic renderings of the same tree. Every agent reads it as context, and
// its acceptance criteria seed the test scenarios.
//
// Naming note: this "spec" family is distinct from the transient, per-block
// "requirements" CONTEXT review (see `requirements.ts`), which clarifies the
// linked-prose brief before work starts. A spec legitimately *contains*
// requirements, domain rules and acceptance criteria, so those inner item types
// keep their names.
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
 * artifact) because rules share the spec's lifecycle; rendered to `rules.md`.
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

/** The unified, prescriptive specification document for one service (the `spec.json` tree). */
export const specDocSchema = v.object({
  /** Service / frame name (defaults to the repo name). */
  service: reqNameField,
  /** One-paragraph product intent for the service overall. */
  summary: v.optional(reqSummaryField, ''),
  /** Requirements grouped by capability; each group renders one `.feature` file. */
  groups: v.optional(v.array(requirementGroupSchema), []),
  /** Cross-cutting domain rules / invariants / constraints. */
  rules: v.optional(v.array(domainRuleSchema), []),
})
export type SpecDoc = v.InferOutput<typeof specDocSchema>

/**
 * The lightweight `version.json` manifest committed alongside the spec. It carries a
 * monotonic version counter, the generation timestamp, a content hash of the
 * canonical tree, and the requirement/rule counts — so staleness checks are a tiny
 * read rather than a full parse of `spec.json`. Mirrors the blueprint's
 * `version.json` manifest field-for-field in spirit.
 */
export const specVersionSchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  generatedAt: v.string(),
  /** sha256 (hex) of the canonical `spec.json` bytes. */
  hash: v.string(),
  requirements: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rules: v.pipe(v.number(), v.integer(), v.minValue(0)),
})
export type SpecVersion = v.InferOutput<typeof specVersionSchema>

// ---- In-repo spec artifact paths ------------------------------------------
// The folder + file layout, the prescriptive sibling of `blueprints/`. The
// canonical machine-readable file is `spec.json`; the markdown and feature files
// are deterministic renderings of the same tree.

/** Folder, relative to the repo root, that holds the persisted spec. */
export const SPEC_DIR = 'spec'
/** Canonical machine-readable spec file (the SpecDoc tree). */
export const SPEC_JSON_PATH = `${SPEC_DIR}/spec.json`
/** High-level overview markdown — the file agents read first. */
export const SPEC_OVERVIEW_PATH = `${SPEC_DIR}/overview.md`
/** Domain rules / invariants / constraints markdown. */
export const SPEC_RULES_PATH = `${SPEC_DIR}/rules.md`
/** Tiny manifest read for quick staleness checks without parsing the full tree. */
export const SPEC_VERSION_PATH = `${SPEC_DIR}/version.json`
/** Sub-folder holding the generated Gherkin `.feature` files (one per group). */
export const SPEC_FEATURES_DIR = `${SPEC_DIR}/features`

/** Legacy folder name the spec lived under before the rename; relocated on first run. */
export const LEGACY_SPEC_DIR = 'requirements'

/**
 * Strictly parse an arbitrary value (e.g. the JSON read from `spec.json`, or a tree
 * returned by the spec-writer container) into a {@link SpecDoc}, enforcing the exact
 * schema shape. Throws on any shape violation, so a bad payload can never be
 * ingested. Use it at every trust boundary that ingests a spec.
 */
export function parseSpecDoc(value: unknown): SpecDoc {
  return v.parse(specDocSchema, value)
}

/** Non-throwing variant: returns the parsed doc or `undefined` when invalid. */
export function safeParseSpecDoc(value: unknown): SpecDoc | undefined {
  const result = v.safeParse(specDocSchema, value)
  return result.success ? result.output : undefined
}

/**
 * Render a {@link SpecDoc} as readable markdown for HUMAN + COMPANION review.
 *
 * The spec-writer is a container agent: it emits the spec as JSON, renders the
 * in-repo files and commits them, then its raw `summary` (a fragment of the Pi
 * transcript) is all that survives on the step. Grading that transcript instead of
 * the document is what made the spec-companion declare every pass "unreviewable" and
 * loop the producer to its cap. This renders the actual tree — every group, its
 * requirements (statement / kind / priority) and their Given/When/Then acceptance
 * criteria, plus the cross-cutting rules — so the reviewer (and the SPA reader, and
 * downstream steps) see the spec itself, not the agent's chatter. Deterministic and
 * dependency-free so it is safe to call at the ingest trust boundary.
 */
export function renderSpecForReview(spec: SpecDoc): string {
  const lines: string[] = [`# Specification: ${spec.service}`]
  if (spec.summary) lines.push('', spec.summary)
  for (const group of spec.groups ?? []) {
    lines.push('', `## ${group.name}`)
    if (group.summary) lines.push('', group.summary)
    for (const req of group.requirements ?? []) {
      lines.push('', `### ${req.title} (${req.id})`, '', `- Kind: ${req.kind}`)
      lines.push(`- Priority: ${req.priority}`)
      lines.push(`- Statement: ${req.statement}`)
      for (const ac of req.acceptance ?? []) {
        lines.push(`  - Acceptance ${ac.id}: GIVEN ${ac.given} WHEN ${ac.when} THEN ${ac.outcome}`)
      }
    }
  }
  const rules = spec.rules ?? []
  if (rules.length) {
    lines.push('', '## Domain rules')
    for (const rule of rules) {
      lines.push(`- ${rule.rule}${rule.rationale ? ` (${rule.rationale})` : ''}`)
    }
  }
  return lines.join('\n')
}
