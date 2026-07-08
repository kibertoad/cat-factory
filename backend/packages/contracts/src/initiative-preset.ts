import * as v from 'valibot'
import {
  INITIATIVE_ID_MAX,
  INITIATIVE_SHORT_MAX,
  INITIATIVE_TITLE_MAX,
  initiativeExecutionPolicySchema,
  initiativePresetInputsSchema,
  type InitiativePresetInputs,
  type InitiativePresetInputValue,
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
// The field descriptor extends the `ProviderConfigField` family with the two shapes a
// preset form needs that a flat provider form did not: `checkbox-group` (a multi-select
// whose value is `string[]`) and `path` (a repo-relative directory), plus single-condition
// `showWhen` visibility (a per-doc-type subfolder shown only when that type is checked).
// Descriptor labels are backend-supplied English (the `describeConfig` convention); only
// the surrounding chrome is i18n.
// ---------------------------------------------------------------------------

/**
 * How a preset field is rendered/collected. The first six mirror {@link ProviderConfigField}'s
 * types exactly; `checkbox-group` (a multi-select, value `string[]`) and `path` (a repo-relative
 * directory, {@link isSafeRepoDirPath}-validated) are the two additions the preset form needs.
 */
export const initiativePresetFieldTypeSchema = v.picklist([
  'text',
  'password',
  'select',
  'number',
  'checkbox',
  'textarea',
  'checkbox-group',
  'path',
])
export type InitiativePresetFieldType = v.InferOutput<typeof initiativePresetFieldTypeSchema>

/**
 * Single-condition visibility for a field: it renders only when the referenced field's value
 * matches. `equals` compares a scalar value; `includes` tests membership in a `checkbox-group`
 * value (the per-doc-type subfolder case — "show `diagramsDir` only when `docTypes` includes
 * `diagrams`"). Deliberately ONE condition — resist growing this into a recursive schema
 * renderer (that is the descriptor-forms initiative's separate line item).
 */
export const initiativePresetShowWhenSchema = v.object({
  /** The `key` of the field whose value gates this one's visibility. */
  key: v.pipe(v.string(), v.minLength(1)),
  /**
   * Show when the referenced scalar value equals this. A union so `equals` can gate a
   * `checkbox` (boolean) or `number` field, not only a `select`/`text` string — the
   * comparison is strict, so the type must match the referenced field's value.
   */
  equals: v.optional(v.union([v.string(), v.boolean(), v.number()])),
  /** Show when the referenced `checkbox-group` value includes this. */
  includes: v.optional(v.string()),
})
export type InitiativePresetShowWhen = v.InferOutput<typeof initiativePresetShowWhenSchema>

/** One value a preset needs, rendered as a single form field. */
export const initiativePresetFieldSchema = v.object({
  /** Stable key the value is stored/sent under (e.g. `docTypes`, `docsRoot`). */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  /** Human label for the form field (backend-supplied English). */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Optional helper text shown under the field. */
  help: v.optional(v.string()),
  /** Optional input placeholder. */
  placeholder: v.optional(v.string()),
  /** Whether the value is required (absent ⇒ optional). A hidden (`showWhen`) field is never required. */
  required: v.optional(v.boolean()),
  /** Field type; absent is treated as `text`. */
  type: v.optional(initiativePresetFieldTypeSchema),
  /** Choices for a `select` / `checkbox-group` field. */
  options: v.optional(v.array(v.object({ value: v.string(), label: v.string() }))),
  /** The scalar default (`text`/`select`/`path`/`number`/`checkbox`); the form falls back to it when blank. */
  default: v.optional(v.string()),
  /** The multi-select default for a `checkbox-group` field. */
  defaultValues: v.optional(v.array(v.string())),
  /** Single-condition visibility; absent ⇒ always shown. */
  showWhen: v.optional(initiativePresetShowWhenSchema),
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
// Path safety + input validation (pure — shared by the create-flow validation).
// ---------------------------------------------------------------------------

/**
 * Whether `path` is a SAFE repo-relative DIRECTORY (the `path`-field analogue of
 * {@link isSafeDocPath}, minus the `.md` requirement). A preset `path` value is used verbatim
 * as an in-repo placement dir the writers commit under, so it must not escape the repo: no `..`
 * traversal, no absolute path (`/…` or a Windows drive), no backslash / NUL. An empty string is
 * NOT a valid path (callers treat "unset" separately). A trailing slash is tolerated.
 */
export function isSafeRepoDirPath(path: string): boolean {
  const p = path.trim()
  if (!p || p.length > 300) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  if (p.includes('\\') || p.includes('\0')) return false
  return !p.split('/').some((segment) => segment === '..')
}

/** Whether a field is visible given the current input values (its `showWhen` condition). */
export function isPresetFieldVisible(
  field: InitiativePresetField,
  inputs: InitiativePresetInputs,
): boolean {
  const cond = field.showWhen
  if (!cond) return true
  const value = inputs[cond.key]
  if (cond.equals !== undefined) {
    // An unchecked checkbox is ABSENT from the inputs (an off box stays unset — see the create
    // form's `defaultPresetInputs` / renderer), so an absent value reads as `false` when the
    // condition compares against a boolean. Without this, `equals: false` would never match at
    // initial render (only after a toggle on→off), hiding a field that should be shown.
    const actual = value === undefined && typeof cond.equals === 'boolean' ? false : value
    return actual === cond.equals
  }
  if (cond.includes !== undefined) return Array.isArray(value) && value.includes(cond.includes)
  // A `showWhen` with neither predicate is a malformed condition — treat as always visible.
  return true
}

/** Whether a filled value matches the field's declared type (structural, pre-semantic check). */
function valueMatchesFieldType(
  field: InitiativePresetField,
  value: InitiativePresetInputValue,
): boolean {
  switch (field.type) {
    case 'checkbox-group':
      return Array.isArray(value)
    case 'checkbox':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number'
    default:
      // text / password / select / textarea / path (and the untyped default) are strings.
      return typeof value === 'string'
  }
}

/**
 * Validate a filled preset form against its descriptor, returning a list of human-readable
 * problems (EMPTY ⇒ valid). Pure + total (never throws), so the create controller can map a
 * non-empty result to a single ValidationError. Enforces: no unknown keys, correct value type
 * per field, required VISIBLE fields present (a required `checkbox` must be CHECKED — an
 * unchecked `false` counts as unset), `select`/`checkbox-group` values drawn from the declared
 * options, and `path` values that stay inside the repo ({@link isSafeRepoDirPath}). Hidden
 * fields (failing `showWhen`) are not required and their stale values are ignored.
 */
export function validateInitiativePresetInputs(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
): string[] {
  const problems: string[] = []
  const byKey = new Map(descriptor.fields.map((f) => [f.key, f]))

  for (const key of Object.keys(inputs)) {
    if (!byKey.has(key)) problems.push(`Unknown field "${key}".`)
  }

  for (const field of descriptor.fields) {
    const visible = isPresetFieldVisible(field, inputs)
    const value = inputs[field.key]
    // A checkbox is "present" only when checked: a required checkbox means "must be checked",
    // so an unchecked (`false`) box counts as unset and fails the required check below.
    const present =
      value !== undefined &&
      !(typeof value === 'string' && value.trim() === '') &&
      !(Array.isArray(value) && value.length === 0) &&
      value !== false

    if (!visible) continue
    if (!present) {
      if (field.required) problems.push(`Field "${field.key}" is required.`)
      continue
    }
    if (!valueMatchesFieldType(field, value)) {
      problems.push(`Field "${field.key}" has the wrong type for a ${field.type ?? 'text'} field.`)
      continue
    }
    const optionValues = new Set((field.options ?? []).map((o) => o.value))
    if (field.type === 'select' && optionValues.size > 0 && !optionValues.has(value as string)) {
      problems.push(`Field "${field.key}" has a value outside its options.`)
    }
    if (field.type === 'checkbox-group' && optionValues.size > 0) {
      for (const entry of value as string[]) {
        if (!optionValues.has(entry))
          problems.push(`Field "${field.key}" has an option "${entry}" outside its choices.`)
      }
    }
    if (field.type === 'path' && !isSafeRepoDirPath(value as string)) {
      problems.push(
        `Field "${field.key}" must be a relative path inside the repo (no "..", absolute, or backslash segments).`,
      )
    }
  }

  return problems
}

/**
 * Reduce a filled preset form to the values SAFE to freeze on the entity: only fields the
 * descriptor declares AND that are currently VISIBLE (their `showWhen` holds). Unknown keys and
 * hidden fields — whose stale values {@link validateInitiativePresetInputs} deliberately skips —
 * are dropped, so a hidden field can never freeze an unvalidated value (e.g. a `path` that escapes
 * the repo). Pure + total; run AFTER validation, on a form already known valid.
 */
export function sanitizeInitiativePresetInputs(
  descriptor: InitiativePresetDescriptor,
  inputs: InitiativePresetInputs,
): InitiativePresetInputs {
  const sanitized: InitiativePresetInputs = {}
  for (const field of descriptor.fields) {
    if (!isPresetFieldVisible(field, inputs)) continue
    const value = inputs[field.key]
    if (value !== undefined) sanitized[field.key] = value
  }
  return sanitized
}

/**
 * Render one filled preset value as human-readable prose (option labels preferred over raw
 * values, `checkbox-group` joined, boolean → `Yes`/`No`). Shared by the create flow's skip-interview
 * qa seeding and the SPA form review so a field reads identically in both. Backend-supplied English
 * (the `describeConfig` convention). Pure + total.
 */
export function renderInitiativePresetValue(
  field: InitiativePresetField,
  value: InitiativePresetInputValue,
): string {
  const labelOf = (v: string): string =>
    (field.options ?? []).find((o) => o.value === v)?.label ?? v
  if (Array.isArray(value)) return value.map(labelOf).join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  return labelOf(value)
}

/** Strictly parse a bounded preset-inputs record. Throws on shape violations. */
export function parseInitiativePresetInputs(value: unknown): InitiativePresetInputs {
  return v.parse(initiativePresetInputsSchema, value)
}
