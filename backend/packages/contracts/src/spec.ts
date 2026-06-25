import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Unified in-repo SPECIFICATION artifact (prescriptive, service-level).
//
// This is the durable PRESCRIPTIVE spec for a whole service, persisted in the
// service's own GitHub repo under `spec/` and aggregated across every task. It is
// the mirror image of the blueprint: a blueprint is DESCRIPTIVE ("what the code
// is"), this spec is PRESCRIPTIVE ("what must be true").
//
// The spec is SHARDED on disk into many small files so concurrent task branches
// touch disjoint files and merge cleanly (a single monolithic `spec.json` produced
// crippling merge churn). The shape is a two-level taxonomy — MODULE (a domain,
// e.g. `auth`) → GROUP (a feature / logical group, e.g. `login`) — and each group
// carries BOTH its requirements and the domain rules scoped to it (there is no
// catch-all rules file; a cross-cutting concern is just a `common`/`infrastructure`
// module that is itself split into feature groups). The canonical per-group file is
// `spec/modules/<module>/<group>.json`; the markdown (`overview.md` index +
// per-group `<group>.md`) and the Gherkin `features/<module>/<group>.feature` files
// are deterministic renderings of the same tree. Every agent reads it as context,
// and its acceptance criteria seed the test scenarios.
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
 * A domain rule / invariant / constraint — prescriptive. Each rule is scoped to the
 * group (feature) it governs and lives inside that group, so there is no catch-all
 * rules document; a genuinely service-wide invariant is attached to a group under a
 * `common`/`infrastructure` module. Rendered into the owning group's `<group>.md`.
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

/**
 * A feature / logical group: related requirements plus the domain rules scoped to
 * them. The leaf shard of the taxonomy — one group renders one canonical
 * `<group>.json`, one `<group>.md`, and one `.feature` file.
 */
export const requirementGroupSchema = v.object({
  name: reqNameField,
  summary: v.optional(reqSummaryField, ''),
  requirements: v.optional(v.array(requirementItemSchema), []),
  /** Domain rules / invariants scoped to this feature (rendered into its `<group>.md`). */
  rules: v.optional(v.array(domainRuleSchema), []),
})
export type RequirementGroup = v.InferOutput<typeof requirementGroupSchema>

/** A module (domain, e.g. `auth`) — the top level of the taxonomy, holding feature groups. */
export const specModuleSchema = v.object({
  name: reqNameField,
  summary: v.optional(reqSummaryField, ''),
  groups: v.optional(v.array(requirementGroupSchema), []),
})
export type SpecModule = v.InferOutput<typeof specModuleSchema>

/** The unified, prescriptive specification document for one service (the sharded tree). */
export const specDocSchema = v.object({
  /** Service / frame name (defaults to the repo name). */
  service: reqNameField,
  /** One-paragraph product intent for the service overall. */
  summary: v.optional(reqSummaryField, ''),
  /** Modules (domains), each grouping its feature groups; the two-level taxonomy. */
  modules: v.optional(v.array(specModuleSchema), []),
})
export type SpecDoc = v.InferOutput<typeof specDocSchema>

// ---- In-repo spec artifact paths ------------------------------------------
// The sharded folder layout, the prescriptive sibling of `blueprints/`. The
// canonical machine-readable files are the per-group `modules/<m>/<g>.json` shards;
// the markdown (`overview.md` index + per-group `<g>.md`) and feature files are
// deterministic renderings of the same tree. There is NO single `spec.json`.

/** Folder, relative to the repo root, that holds the persisted spec. */
export const SPEC_DIR = 'spec'
/** Tiny file carrying only the service name + one-paragraph summary. */
export const SPEC_SERVICE_PATH = `${SPEC_DIR}/service.json`
/** High-level overview markdown (the module → feature index) — the file agents read first. */
export const SPEC_OVERVIEW_PATH = `${SPEC_DIR}/overview.md`
/** Sub-folder holding the per-module folders, each with its per-group canonical shards. */
export const SPEC_MODULES_DIR = `${SPEC_DIR}/modules`
/** Sub-folder holding the generated Gherkin `.feature` files (`features/<module>/<group>.feature`). */
export const SPEC_FEATURES_DIR = `${SPEC_DIR}/features`

// ---- Service-spec read view (served to the SPA) ---------------------------
// The spec lives in the service repo, sharded under `spec/`; the SPA cannot read a
// repo directly. The backend reassembles the tree from the repo's DEFAULT branch and
// serves it as this view so the inspector's "View Requirements" window can navigate
// the structured spec and (when present) show the rendered Gherkin scenarios.

/** A rendered Gherkin feature file read back from `spec/features/<module>/<group>.feature`. */
export const specFeatureFileSchema = v.object({
  /** The owning module's display name (resolved from its `_module.json`, else the slug). */
  module: v.string(),
  /** The feature/group display name (resolved from the group shard, else the slug). */
  group: v.string(),
  /** Repo-relative path of the `.feature` file. */
  path: v.string(),
  /** The raw Gherkin content. */
  content: v.string(),
})
export type SpecFeatureFile = v.InferOutput<typeof specFeatureFileSchema>

/**
 * The service-spec view served to the SPA: the reassembled prescriptive spec tree read
 * from the service repo's default branch, plus its rendered Gherkin feature files.
 * `present` is false (and `spec` null) when no spec exists on the default branch, or when
 * GitHub isn't connected — so the window renders an empty state rather than erroring.
 */
export const serviceSpecViewSchema = v.object({
  /** Whether a spec exists on the service repo's default branch (a `spec/service.json`). */
  present: v.boolean(),
  /** The reassembled spec tree, or null when none is present. */
  spec: v.nullable(specDocSchema),
  /** The rendered Gherkin feature files (empty when none present). The producer always
   * sends this field (`[]` when there are none), and the SPA dereferences it unguarded, so
   * it is required — not optional — to keep the wire shape and its sole consumer in lockstep. */
  features: v.array(specFeatureFileSchema),
})
export type ServiceSpecView = v.InferOutput<typeof serviceSpecViewSchema>

/** The canonical "no spec" view — GitHub not connected, or no spec on the default branch. */
export const EMPTY_SERVICE_SPEC_VIEW: ServiceSpecView = { present: false, spec: null, features: [] }

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
 * Non-throwing parse of a single module shard. Lets a reader validate the tree PER NODE
 * (dropping only the offending shard) instead of letting one malformed module blank the
 * whole spec.
 */
export function safeParseSpecModule(value: unknown): SpecModule | undefined {
  const result = v.safeParse(specModuleSchema, value)
  return result.success ? result.output : undefined
}

/**
 * Non-throwing parse of a single feature-group shard. Lets a reader validate the tree PER
 * NODE (dropping only the offending shard) rather than failing the whole document.
 */
export function safeParseRequirementGroup(value: unknown): RequirementGroup | undefined {
  const result = v.safeParse(requirementGroupSchema, value)
  return result.success ? result.output : undefined
}

/**
 * Non-throwing parse of a single requirement item. Lets a reader salvage a group shard one
 * requirement at a time — so ONE over-long/malformed requirement (e.g. a title past the
 * schema cap that the lenient writer never enforced) drops only that requirement, not the
 * whole group with its valid siblings, acceptance criteria and rules.
 */
export function safeParseRequirementItem(value: unknown): RequirementItem | undefined {
  const result = v.safeParse(requirementItemSchema, value)
  return result.success ? result.output : undefined
}

/**
 * Non-throwing parse of a single domain rule. The rule-level counterpart of
 * {@link safeParseRequirementItem}, so one malformed rule drops only itself.
 */
export function safeParseDomainRule(value: unknown): DomainRule | undefined {
  const result = v.safeParse(domainRuleSchema, value)
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
  for (const module of spec.modules ?? []) {
    lines.push('', `## ${module.name}`)
    if (module.summary) lines.push('', module.summary)
    for (const group of module.groups ?? []) {
      lines.push('', `### ${group.name}`)
      if (group.summary) lines.push('', group.summary)
      for (const req of group.requirements ?? []) {
        lines.push('', `#### ${req.title} (${req.id})`, '', `- Kind: ${req.kind}`)
        lines.push(`- Priority: ${req.priority}`)
        lines.push(`- Statement: ${req.statement}`)
        for (const ac of req.acceptance ?? []) {
          lines.push(
            `  - Acceptance ${ac.id}: GIVEN ${ac.given} WHEN ${ac.when} THEN ${ac.outcome}`,
          )
        }
      }
      const rules = group.rules ?? []
      if (rules.length) {
        lines.push('', `#### Domain rules`)
        for (const rule of rules) {
          lines.push(`- ${rule.rule}${rule.rationale ? ` (${rule.rationale})` : ''}`)
        }
      }
    }
  }
  return lines.join('\n')
}
