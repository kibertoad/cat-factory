import * as v from 'valibot'
import {
  descriptorFieldEntries,
  descriptorFieldTypeSchema,
  sanitizeDescriptorFields,
  validateDescriptorFields,
  withDescriptorFieldDefaults,
} from './form-fields.js'
import {
  INITIATIVE_ID_MAX,
  INITIATIVE_SHORT_MAX,
  INITIATIVE_TITLE_MAX,
  initiativeExecutionPolicySchema,
  initiativePresetInputsSchema,
  type InitiativePresetInputs,
} from './initiative.js'

// ---------------------------------------------------------------------------
// Initiative-preset wire contracts.
//
// An initiative PRESET is more than a pipeline: it bundles (a) its own FORM the user
// fills at create time — rendered generically by the SPA from this backend-supplied
// descriptor, zero frontend changes per preset — (b) a planning-pipeline binding
// (skip the interviewer when the form IS the interview), (c) execution-policy /
// fragment / human-review defaults, and (d) code hooks (a repo-detection prefill
// probe, a plan post-processor) that live on the KERNEL registration, not here (this
// file is the serialisable, SPA-facing subset). See
// `docs/initiatives/initiative-presets-and-docs-refresh.md` and the kernel
// `initiative-preset-registry.ts`.
//
// The FIELD vocabulary itself is shared with the other descriptor-driven form surface (a reusable
// operation's per-case brief on a custom task type) and lives in `form-fields.ts`; a preset admits
// EVERY type in it, including `password`, and this module only re-exports the preset-named
// aliases plus the two descriptor-taking wrappers. Descriptor labels are backend-supplied English
// (the `describeConfig` convention); only the surrounding chrome is i18n.
// ---------------------------------------------------------------------------

/**
 * How a preset field is rendered/collected: the whole shared union, a preset being the surface
 * that motivated it. `password` is admitted here (a preset input may carry a token the planning
 * flow needs) and refused for a task type, whose values reach prompts and telemetry.
 */
export const initiativePresetFieldTypeSchema = descriptorFieldTypeSchema
export type InitiativePresetFieldType = v.InferOutput<typeof initiativePresetFieldTypeSchema>

/** One value a preset needs, rendered as a single form field. */
export const initiativePresetFieldSchema = v.object({
  ...descriptorFieldEntries,
  /** Field type; absent is treated as `text`. */
  type: v.optional(initiativePresetFieldTypeSchema),
})
export type InitiativePresetField = v.InferOutput<typeof initiativePresetFieldSchema>

/** Display metadata for a preset in the create-initiative picker. */
export const initiativePresetPresentationSchema = v.object({
  /** Human label, e.g. `Documentation refresh`. */
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  /** Icon id (e.g. an `i-lucide-*` name). */
  icon: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Accent colour (CSS hex/keyword). */
  color: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  /** One-line description shown in the picker. */
  description: v.pipe(v.string(), v.maxLength(500)),
})
export type InitiativePresetPresentation = v.InferOutput<typeof initiativePresetPresentationSchema>

// ---------------------------------------------------------------------------
// Preset phase templates (a generic, declarative plan-shape capability).
//
// A preset MAY declare a fixed set of phases its plan must be built around — a
// database migration always runs blast-zone → coverage → transition → delivery →
// decommission, regardless of the specific from/to technologies. The template is pure
// serialisable data on the wire descriptor (exactly like `policyDefaults`), which lets
// the SPA preview "this preset runs these N phases" at create time with zero per-preset
// frontend work. Deep per-phase methodology stays code-side in the registration's
// `promptAdditions` (the off-the-wire rule) — the template carries only the short
// ids/titles/goals the planner emits and the ingest normalizer enforces.
//
// Generic machinery consumes it: the planner prompt fold renders a "required plan shape"
// section, and the ingest normalizer matches planned phases by id, reorders them into
// template order, and rejects a missing `required` phase (or an unknown extra phase when
// `allowAdditionalPhases` is false). `preset_generic` declares NO template, so it — and
// the loop — never branch on a preset id and free-form planning is byte-for-byte unchanged.
// ---------------------------------------------------------------------------

/**
 * One phase a preset's plan must be built around. `id`/`title`/`goal` reuse the exact clamps
 * of the plan's own {@link initiativePhaseSchema} (so a template phase and a planned phase are
 * byte-compatible and match by id at ingest); `goal` is the phase's charter — short prose shown
 * on the tracker and folded into the planner prompt. `required` marks a phase the ingest
 * normalizer refuses to drop (absent ⇒ an optional phase the planner may omit).
 */
export const initiativePresetTemplatePhaseSchema = v.object({
  /** Stable phase id, matched VERBATIM against the planned phases at ingest. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(INITIATIVE_ID_MAX)),
  /** Human phase title (backend-supplied English). */
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(INITIATIVE_TITLE_MAX)),
  /** The phase's charter — short prose shown on the tracker and fed to the planner. */
  goal: v.optional(v.pipe(v.string(), v.maxLength(INITIATIVE_SHORT_MAX)), ''),
  /** Whether ingest must reject a plan missing this phase (absent ⇒ optional). */
  required: v.optional(v.boolean()),
  /**
   * When true, the plan's matching phase pauses the initiative for human review once its items all
   * settle (the D2 checkpoint). Stamped onto the persisted phase at ingest and FORCED on — the
   * planner cannot unset a template-authored checkpoint. Absent ⇒ the phase advances unattended.
   */
  checkpoint: v.optional(v.boolean()),
})
export type InitiativePresetTemplatePhase = v.InferOutput<
  typeof initiativePresetTemplatePhaseSchema
>

/**
 * A preset's declarative PLAN-SHAPE template: the phases the plan must present, in order. Phase
 * ids must be unique (the ingest normalizer matches by id, so a duplicate would be ambiguous).
 * `allowAdditionalPhases` (absent ⇒ false — the template is exhaustive) governs whether the
 * planner may add phases beyond the template. Consumed generically (planner prompt fold + ingest
 * normalization); a preset with no template plans free-form.
 */
export const initiativePresetPhaseTemplateSchema = v.object({
  /** The template phases, in the order the plan must present them (at least one). */
  phases: v.pipe(
    v.array(initiativePresetTemplatePhaseSchema),
    v.minLength(1),
    v.check(
      (phases) => new Set(phases.map((p) => p.id)).size === phases.length,
      'Phase template ids must be unique.',
    ),
  ),
  /** Whether the planner may add phases beyond the template (absent ⇒ false — exhaustive). */
  allowAdditionalPhases: v.optional(v.boolean()),
})
export type InitiativePresetPhaseTemplate = v.InferOutput<
  typeof initiativePresetPhaseTemplateSchema
>

/**
 * The serialisable, SPA-facing description of a preset: everything the create-initiative
 * modal needs to render the picker + form and start planning, attached to the workspace
 * snapshot (the `customAgentKinds` precedent). The code hooks (`detect`/`seedPlan`/
 * `promptAdditions`) live on the kernel registration, NOT here.
 */
export const initiativePresetDescriptorSchema = v.object({
  /** Stable preset id (e.g. `preset_generic`, `preset_docs_refresh`). */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  presentation: initiativePresetPresentationSchema,
  /** The form fields the user fills at create time (empty for the generic preset). */
  fields: v.array(initiativePresetFieldSchema),
  /** The planning pipeline the SPA starts (e.g. `pl_initiative`, `pl_initiative_docs`). */
  planningPipelineId: v.pipe(v.string(), v.minLength(1)),
  /** `full` runs the interviewer; `skip` treats the form AS the interview (seeded qa). */
  interview: v.picklist(['full', 'skip']),
  /** Default for the human-review opt-in (mapped to the gate-override seam at start). */
  humanReviewDefault: v.boolean(),
  /** Best-practice prompt fragments applied by default (configurable via a form field). */
  defaultFragmentIds: v.optional(v.array(v.string()), []),
  /** Partial execution-policy overrides folded in at plan ingest. */
  policyDefaults: v.optional(v.partial(initiativeExecutionPolicySchema)),
  /**
   * Optional declarative plan-shape template (see {@link initiativePresetPhaseTemplateSchema}).
   * When present, the planner prompt fold renders a "required plan shape" section and the ingest
   * normalizer enforces the shape (match by id, reorder into template order, reject a missing
   * `required` / disallowed-extra phase). Absent ⇒ free-form planning (the generic preset).
   */
  phaseTemplate: v.optional(initiativePresetPhaseTemplateSchema),
  /**
   * Whether this preset supports a repo-detection PREFILL probe (a `detect` hook is wired on
   * the registration). Computed server-side when the snapshot is built (the `supportsTest`
   * convention) so the SPA knows to call `POST …/initiative-presets/:id/probe`. Never blocks
   * create — an unwired probe / GitHub simply falls back to the descriptor defaults.
   */
  probe: v.optional(v.boolean()),
})
export type InitiativePresetDescriptor = v.InferOutput<typeof initiativePresetDescriptorSchema>

/** Strictly parse a preset descriptor. Throws on shape violations. */
export function parseInitiativePresetDescriptor(value: unknown): InitiativePresetDescriptor {
  return v.parse(initiativePresetDescriptorSchema, value)
}

// ---------------------------------------------------------------------------
// Input validation (the shared pure rules, bound to a preset's descriptor).
//
// The rules themselves live in `form-fields.ts` and take a plain field list, because the other
// descriptor-driven surface (a custom task type's per-case form) has no preset descriptor to pass.
// These two wrappers exist because a preset's callers hold the DESCRIPTOR, not its fields, and the
// preset-named helpers below read as what they are at those call sites.
// ---------------------------------------------------------------------------

/**
 * The field-list-shaped rules under their preset names: `isPresetFieldVisible` (a field's
 * `showWhen` against the current inputs), `renderInitiativePresetValue` (one value as prose), and
 * the `path` write-boundary guard. Aliases, not copies: one implementation, two vocabularies.
 */
export {
  isDescriptorFieldVisible as isPresetFieldVisible,
  isSafeRepoDirPath,
  renderDescriptorFieldValue as renderInitiativePresetValue,
} from './form-fields.js'

/**
 * A filled preset form with the descriptor's own DEFAULTS folded in for the fields the caller left
 * absent: what a door validates, sanitizes and freezes.
 *
 * A create controller applies this BEFORE the two helpers below, so a `required` field carrying a
 * default is answered by the deployment's declared value rather than refused. The SPA seeds the
 * same defaults into the form, so this changes nothing for a browser submit and closes the gap for
 * every other caller (an initiative spawned by an operation, a script, the public API).
 */
export function withInitiativePresetDefaults(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
): InitiativePresetInputs {
  return withDescriptorFieldDefaults(descriptor.fields, inputs)
}

/**
 * Validate a filled preset form against its descriptor, returning a list of human-readable
 * problems (EMPTY means valid). Pure + total (never throws), so the create controller can map a
 * non-empty result to a single ValidationError and the SPA can disable submit off the same call.
 */
export function validateInitiativePresetInputs(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
): string[] {
  return validateDescriptorFields(descriptor.fields, inputs)
}

/**
 * Reduce a filled preset form to the values SAFE to freeze on the entity: the declared, currently
 * VISIBLE fields only, so a hidden field can never freeze an unvalidated value (e.g. a `path` that
 * escapes the repo). Pure + total; run AFTER validation, on a form already known valid.
 */
export function sanitizeInitiativePresetInputs(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
): InitiativePresetInputs {
  return sanitizeDescriptorFields(descriptor.fields, inputs)
}

/** Strictly parse a bounded preset-inputs record. Throws on shape violations. */
export function parseInitiativePresetInputs(value: unknown): InitiativePresetInputs {
  return v.parse(initiativePresetInputsSchema, value)
}
