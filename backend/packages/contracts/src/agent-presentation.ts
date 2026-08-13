import * as v from 'valibot'
import { pipelinePurposeSchema } from './pipeline-purpose-vocabulary.js'
import { agentKindSchema, namespacedIdSchema } from './primitives.js'
import { RESULT_VIEW_IDS } from './result-views.js'

// ---------------------------------------------------------------------------
// Presentation metadata for an agent kind — the display fields the SPA palette,
// timeline and result-view host render. A registered (custom) agent supplies this so
// it becomes a first-class palette block with the right icon/label/category instead of
// the generic fallback; the server serialises the registered kinds' presentation into
// the workspace snapshot so the frontend catalog stops being a hand-synced mirror.
// ---------------------------------------------------------------------------

/** The palette section an agent groups under. Mirrors the frontend `AGENT_CATEGORIES`. */
export const agentCategorySchema = v.picklist([
  'review',
  'design',
  'build',
  'test',
  'docs',
  'gates',
])
export type AgentCategory = v.InferOutput<typeof agentCategorySchema>

const AGENT_CATEGORY_SET: ReadonlySet<string> = new Set(agentCategorySchema.options)

/**
 * Whether a value is a category THIS BUILD knows, DERIVED from the picklist so it cannot drift
 * from it the way a hand-written second list would.
 *
 * The vocabulary is closed, but the values reaching a reader are not this build's alone: a
 * `presentation.category` arrives in the workspace snapshot from a kind a DEPLOYMENT registered,
 * and a category retired from the union goes on living in stored pipelines. A reader that maps one
 * through an exhaustive `Record` is therefore total against the TYPE and partial against the DATA,
 * which is the gap where the lookup returns `undefined` and whatever reads it renders a blank or
 * throws. Narrow with this first and state the negative case as the unknown it is.
 */
export function isAgentCategory(value: string): value is AgentCategory {
  return AGENT_CATEGORY_SET.has(value)
}

// ---------------------------------------------------------------------------
// Agent TIER — how specialist a kind is, in three cumulative levels. Orthogonal to
// `category` (which section a kind groups under) and to the interface mode
// (`basic`/`advanced`, which is about the whole SPA): a tier says how far down the
// catalog a reader has to go before this kind is worth offering them.
//
// Two surfaces filter on it — the pipeline builder's palette and the model preset's
// per-agent override list — and both share the pure predicate below so they cannot
// drift, exactly as they share `purposeAllowsAgentCategory`.
// ---------------------------------------------------------------------------

/**
 * The agent tiers, WIDEST LAST. The order is load-bearing: {@link agentTierVisibleAt}
 * compares positions in this array, so a level includes every tier at or before it.
 *
 *  - `basic`        — the everyday delivery loop: the kinds a first pipeline is built from.
 *  - `intermediate` — reached for regularly, but not part of the minimal loop.
 *  - `advanced`     — specialist kinds that answer a narrow need (and, as the widest
 *                     level, the setting that shows the whole catalog).
 */
export const AGENT_TIERS = ['basic', 'intermediate', 'advanced'] as const
export const agentTierSchema = v.picklist(AGENT_TIERS)
export type AgentTier = v.InferOutput<typeof agentTierSchema>

/**
 * The tier a kind that declares none is treated as. `intermediate` rather than `basic`,
 * because the default view is the minimal loop and a kind nobody classified has not earned
 * a place in it; and rather than `advanced`, because a deployment-registered kind was
 * deliberately installed and should not sit at the bottom of the catalog by omission. A
 * deployment that wants its kind in the default view declares `tier: 'basic'`.
 */
export const DEFAULT_AGENT_TIER: AgentTier = 'intermediate'

/**
 * Whether a kind of `tier` is shown at the selected `level`. Tiers are CUMULATIVE: `basic`
 * shows only the basic kinds, `intermediate` adds the intermediate ones, and `advanced` —
 * the widest level — shows everything. An absent tier is {@link DEFAULT_AGENT_TIER}.
 */
export function agentTierVisibleAt(tier: AgentTier | null | undefined, level: AgentTier): boolean {
  return AGENT_TIERS.indexOf(tier ?? DEFAULT_AGENT_TIER) <= AGENT_TIERS.indexOf(level)
}

/** Display metadata for one agent kind (the wire shape sent to the SPA). */
export const agentPresentationSchema = v.object({
  /** Human label, e.g. `Security Auditor`. */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  /** Icon id (e.g. an `i-lucide-*` name). */
  icon: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Accent colour (CSS hex/keyword). */
  color: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  /**
   * One-line description shown in the palette / inspector when the kind is selected. Required
   * and non-empty (like label/icon/color): the SPA renders it verbatim as the palette entry's
   * tooltip + inline text with no fallback, so a blank one would surface as an empty description
   * on a first-class palette block.
   */
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  /** Palette section; omitted ⇒ the kind is not a standalone palette block (e.g. a companion). */
  category: v.optional(agentCategorySchema),
  /**
   * The pipeline PURPOSES the palette should offer this kind to, WITHIN the ones its
   * {@link category} already admits (`purposeSuggestsAgentKind`). Omitted ⇒ the category alone
   * decides, which is the normal case. Declare it to opt OUT of a purpose the category would
   * admit: a documentation AUTHOR has no business in a pipeline whose whole job is reviewing
   * someone else's pull request, and its category cannot say so without also taking the Domain
   * Rules Reviewer down with it. It never widens anything, in the palette or in what the
   * builder will SAVE (`purposeAllowsAgentCategory`), so a kind that opts out of a purpose
   * stays editable in a stored pipeline that already uses it.
   *
   * `build` and `bugfix` are read as ONE purpose here, one way (`classifierSuits`): naming
   * `build` also offers the kind to every bugfix palette, because the two are the same work and
   * differ only in the task type their pipelines are offered to. So there is deliberately no way
   * to declare "general builds but not defect work": that is not a distinction about the kind's
   * work, which is all this list may express. Naming `bugfix` alone is a claim about the
   * defect-report context specifically and does NOT buy the kind into `build`.
   *
   * An EMPTY list is refused rather than accepted, because the reader treats "declared nothing"
   * and "declared an empty list" as the same thing (the category alone decides, so the kind is
   * offered at every purpose that section admits) and that is the exact inverse of what an author
   * writing `purposes: []` means by it. Refusing at registration is the only place the two can
   * still be told apart: by the time the palette reads the list the intent is gone. Note this is
   * NOT the same case as a list whose every member THIS BUILD cannot name, which the palette
   * deliberately reads as no declaration: that one is a retired vocabulary member outliving the
   * bundle reading it, not a statement someone typed.
   */
  purposes: v.optional(v.pipe(v.array(pipelinePurposeSchema), v.minLength(1))),
  /**
   * How specialist this kind is ({@link AGENT_TIERS}). The palette and the model-preset
   * override list show the selected tier and everything below it, so a kind declared
   * `basic` is offered in the default view and one declared `advanced` only at the widest
   * setting. Omitted ⇒ {@link DEFAULT_AGENT_TIER}.
   */
  tier: v.optional(agentTierSchema),
  /**
   * Id of a dedicated result-view component to open instead of the generic prose panel.
   * Either a canonical BUILT-IN id ({@link RESULT_VIEW_IDS}, e.g. `generic-structured`) OR
   * a CONSUMER-namespaced id (`<ns>:<name>`, e.g. `acme:security-report`) that a deployment
   * registers a frontend component for through the modular `resultViews` slot. A bare id that
   * is not a built-in still fails validation (the typo guardrail); a namespaced id is trusted
   * to the deployment and paired on the frontend (an unpaired one degrades to the generic
   * panel — the `pairById` `missing` bucket). Omitted ⇒ the generic step-detail panel.
   */
  resultView: v.optional(v.union([v.picklist(RESULT_VIEW_IDS), namespacedIdSchema])),
  /**
   * When true the kind is INTERNAL: the platform dispatches it for a flow of its own and the
   * builder palette never offers it as a placeable block. The environment analyst is the model —
   * it exists to draft a stack recipe for the setup wizard, which runs it on demand, and a step of
   * it in a hand-built pipeline has nothing to hand its draft to.
   *
   * Deliberately NOT expressed by omitting {@link category}: a kind with no category is not a
   * palette block either, but it is also how a COMPANION and a deployment kind that simply
   * classified nothing arrive, and the palette files those under "Custom" rather than dropping
   * them. This says the opposite thing on purpose — do not offer it, whatever else it declares —
   * and it still carries the label/icon/result view every run view needs to RENDER the step.
   *
   * Absent / false ⇒ an ordinary palette block.
   */
  internal: v.optional(v.boolean()),
})
export type AgentPresentation = v.InferOutput<typeof agentPresentationSchema>

/** A registered agent kind's id + presentation + whether it runs in a container — the
 * snapshot entry the SPA merges into its palette catalog. */
export const customAgentKindSchema = v.object({
  kind: agentKindSchema,
  presentation: agentPresentationSchema,
  /** Whether the kind runs in a container (vs an inline LLM call). */
  container: v.boolean(),
  /**
   * Whether the kind carries the `binary-output` trait: its deliverable is binary artifacts
   * stored through a foundational service, so a step of this kind REQUIRES a
   * `stepOptions.binaryOutput` selection and is refused at pipeline save AND run start without
   * one (`assertValidBinaryOutputSteps`). The pipeline builder reads it to decide which steps
   * must offer the storage/context picker — the SPA has no other way to know, and guessing
   * either shows the picker on every step or lets a generator step save into a refusal.
   *
   * A BOOLEAN PROJECTION rather than a `traits: string[]` dump, following {@link container}:
   * the snapshot carries the facts the SPA branches on, not the backend's trait vocabulary.
   * Every other trait is prompt-shaping with no UI consequence; the day one gains one it gets
   * its own field, and the reason is visible in that diff instead of being inferred from a
   * string the client had to know to look for. Absent ⇒ false (the stock product, where no
   * built-in kind carries the trait).
   */
  binaryOutput: v.optional(v.boolean()),
  /**
   * The producer kinds this kind REVIEWS, when a deployment registered it as a COMPANION: it
   * grades the immediately-preceding step's output and, below the step's threshold, loops that
   * producer back for automatic rework before any human is asked.
   *
   * The pipeline builder needs it and has no other way to know. A companion is not a standalone
   * palette block: it renders as an "add companion" toggle ON its producer, and the builder
   * inserts/removes it immediately after. Without this the SPA would either show a deployment's
   * companion as a placeable block (which pipeline validation then refuses on save, because the
   * adjacency rule is enforced server-side) or not show it at all.
   *
   * An ARRAY of targets rather than one, matching `CompanionDefinition.targets`: a companion may
   * legitimately review more than one producer kind. Absent ⇒ the kind is not a companion, which
   * is every custom kind in the stock product.
   */
  companionTargets: v.optional(v.array(agentKindSchema)),
})
export type CustomAgentKind = v.InferOutput<typeof customAgentKindSchema>

/**
 * A registered VARIATION of an existing agent kind — an alternate prompt a step selects through
 * `stepOptions.agentVariantId`. Carried in the snapshot so the pipeline builder can offer the
 * variants registered for a step's kind and the run views can name the one a step ran under.
 *
 * Deliberately NOT a {@link customAgentKindSchema} entry: a variant is not a placeable palette
 * block and has no result view of its own — it runs as `baseKind` in every respect. So it needs
 * only the label that distinguishes it, shown BESIDE the base kind's own.
 */
export const agentKindVariantSchema = v.object({
  id: v.string(),
  baseKind: agentKindSchema,
  label: v.string(),
  description: v.optional(v.string()),
})
export type AgentKindVariant = v.InferOutput<typeof agentKindVariantSchema>
