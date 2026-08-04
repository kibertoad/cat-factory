import * as v from 'valibot'

// ---------------------------------------------------------------------------
// ONE descriptor-driven form vocabulary, shared by every surface where a DEPLOYMENT declares a
// small form and the platform collects, validates, freezes and renders the answers as data:
//
//   - an initiative PRESET's create form (`initiative-preset.ts`, values on `presetInputs`)
//   - a reusable OPERATION's per-case brief (a custom task type's `fields` in `task-types.ts`,
//     values in the sparse `taskTypeFields.custom` bag)
//
// The two grew the same shape independently, and the second was the poorer copy: four input types
// against eight, no defaults, no conditional visibility, and no shared validation, so a form that
// rendered correctly in one surface was unexpressible in the other. This module is the union, and
// each surface declares only WHICH TYPES it admits over it (see `taskTypeFieldTypeSchema`, which
// excludes `password` by construction: a task field value reaches prompts, the board snapshot and
// telemetry, so a secret belongs in the capability-credential store instead).
//
// Everything here is PURE and total, because the same rule has to hold at four doors: the SPA's
// submit button, the internal create controller, the public API, and (for rendering) the prompt
// fold. Descriptor labels/help/option captions are DEPLOYMENT-authored English rendered verbatim
// (the `describeConfig` convention); only the chrome around them is i18n.
// ---------------------------------------------------------------------------

/** Bound on a field `key`, and on a key in a filled {@link descriptorFieldValuesSchema} bag. */
export const DESCRIPTOR_FIELD_KEY_MAX = 80
/** Bound on a single string / string-array element value. */
export const DESCRIPTOR_FIELD_VALUE_MAX = 2000
/** Bound on the number of elements in a `checkbox-group` (multi-value) answer. */
export const DESCRIPTOR_FIELD_ARRAY_MAX = 50

/** One filled value: a scalar (`text`/`select`/`path`/…), a multi-select, a toggle, or a number. */
export const descriptorFieldValueSchema = v.union([
  v.pipe(v.string(), v.maxLength(DESCRIPTOR_FIELD_VALUE_MAX)),
  v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(DESCRIPTOR_FIELD_VALUE_MAX))),
    v.maxLength(DESCRIPTOR_FIELD_ARRAY_MAX),
  ),
  v.boolean(),
  v.number(),
])
export type DescriptorFieldValue = v.InferOutput<typeof descriptorFieldValueSchema>

/** A filled descriptor form: a bounded map from field `key` to its value. */
export const descriptorFieldValuesSchema = v.record(
  v.pipe(v.string(), v.minLength(1), v.maxLength(DESCRIPTOR_FIELD_KEY_MAX)),
  descriptorFieldValueSchema,
)
export type DescriptorFieldValues = v.InferOutput<typeof descriptorFieldValuesSchema>

/**
 * How a field is rendered and collected. The first six mirror `ProviderConfigField`'s types
 * exactly; `checkbox-group` (a multi-select, value `string[]`) and `path` (a repo-relative
 * directory, {@link isSafeRepoDirPath}-validated) are the two the preset form added.
 *
 * A surface may admit a SUBSET (each declares its own picklist over these members) but never a
 * member outside them: the renderer and the validators below switch over exactly this union.
 */
export const descriptorFieldTypeSchema = v.picklist([
  'text',
  'password',
  'select',
  'number',
  'checkbox',
  'textarea',
  'checkbox-group',
  'path',
])
export type DescriptorFieldType = v.InferOutput<typeof descriptorFieldTypeSchema>

/**
 * Single-condition visibility for a field: it renders only when the referenced field's value
 * matches. `equals` compares a scalar value; `includes` tests membership in a `checkbox-group`
 * value ("show `diagramsDir` only when `docTypes` includes `diagrams`"). Deliberately ONE
 * condition: resist growing this into a recursive schema renderer (that is the descriptor-forms
 * initiative's separate line item).
 */
export const descriptorFieldShowWhenSchema = v.object({
  /** The `key` of the field whose value gates this one's visibility. */
  key: v.pipe(v.string(), v.minLength(1)),
  /**
   * Show when the referenced scalar value equals this. A union so `equals` can gate a `checkbox`
   * (boolean) or `number` field, not only a `select`/`text` string. The comparison is strict, so
   * the type must match the referenced field's value.
   */
  equals: v.optional(v.union([v.string(), v.boolean(), v.number()])),
  /** Show when the referenced `checkbox-group` value includes this. */
  includes: v.optional(v.string()),
})
export type DescriptorFieldShowWhen = v.InferOutput<typeof descriptorFieldShowWhenSchema>

/** One choice of a `select` / `checkbox-group` field. */
export const descriptorFieldOptionSchema = v.object({
  /** The value stored when this choice is picked (an enum-stable string). */
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** The caption shown in the form, and rendered in place of the value in prose. */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
})
export type DescriptorFieldOption = v.InferOutput<typeof descriptorFieldOptionSchema>

/**
 * Everything a descriptor field carries EXCEPT its `type`, which each surface narrows to its own
 * admitted picklist. Spread into that surface's own `v.object({ ...descriptorFieldEntries, type })`
 * so the shared bounds cannot drift per surface and a new shared attribute reaches both at once.
 */
export const descriptorFieldEntries = {
  /** Stable key the value is stored/sent under (e.g. `docTypes`, `entity`). */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(DESCRIPTOR_FIELD_KEY_MAX)),
  /** Human label for the form field (deployment-supplied English). */
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Optional helper text shown under the field. */
  help: v.optional(v.pipe(v.string(), v.maxLength(300))),
  /** Optional input placeholder. */
  placeholder: v.optional(v.pipe(v.string(), v.maxLength(200))),
  /** Whether the value is required (absent means optional). A hidden field is never required. */
  required: v.optional(v.boolean()),
  /** Choices for a `select` / `checkbox-group` field; ignored for the other types. */
  options: v.optional(v.array(descriptorFieldOptionSchema)),
  /** The scalar default (`text`/`select`/`path`/`number`/`checkbox`), used to seed the form. */
  default: v.optional(v.pipe(v.string(), v.maxLength(DESCRIPTOR_FIELD_VALUE_MAX))),
  /** The multi-select default for a `checkbox-group` field. */
  defaultValues: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(DESCRIPTOR_FIELD_VALUE_MAX))),
      v.maxLength(DESCRIPTOR_FIELD_ARRAY_MAX),
    ),
  ),
  /** Single-condition visibility; absent means always shown. */
  showWhen: v.optional(descriptorFieldShowWhenSchema),
  /**
   * Max length for a string value (characters), enforced by the input AND the validator.
   *
   * Capped at {@link DESCRIPTOR_FIELD_VALUE_MAX}, the bound the filled bag itself carries: a
   * descriptor allowed to declare more would render an input that accepts what the wire schema
   * then refuses, and that refusal arrives as a raw schema error from the request parse rather
   * than the readable per-field message {@link validateDescriptorFields} produces.
   */
  maxLength: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(DESCRIPTOR_FIELD_VALUE_MAX)),
  ),
} as const

/**
 * A descriptor field admitting EVERY type: the shape the shared helpers below take. A surface's
 * own narrower field type is structurally assignable to it, so `validate`/`sanitize`/`render`
 * work against a preset's fields and a task type's alike with no adapter.
 */
export const descriptorFieldSchema = v.object({
  ...descriptorFieldEntries,
  /** Field type; absent is treated as `text`. */
  type: v.optional(descriptorFieldTypeSchema),
})
export type DescriptorField = v.InferOutput<typeof descriptorFieldSchema>

// ---------------------------------------------------------------------------
// Path safety, visibility, validation, sanitization, rendering: the pure rules every door shares.
// ---------------------------------------------------------------------------

/**
 * Whether `path` is a SAFE repo-relative DIRECTORY (the `path`-field analogue of `isSafeDocPath`,
 * minus the `.md` requirement). A `path` value is used verbatim as an in-repo placement dir that
 * agents commit under, so it must not escape the repo: no `..` traversal, no absolute path (`/…`
 * or a Windows drive), no backslash / NUL. An empty string is NOT a valid path (callers treat
 * "unset" separately). A trailing slash is tolerated.
 */
export function isSafeRepoDirPath(path: string): boolean {
  const p = path.trim()
  if (!p || p.length > 300) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  if (p.includes('\\') || p.includes('\0')) return false
  return !p.split('/').some((segment) => segment === '..')
}

/** Whether a field is visible given the current values (its `showWhen` condition). */
export function isDescriptorFieldVisible(
  field: DescriptorField,
  values: DescriptorFieldValues,
): boolean {
  const cond = field.showWhen
  if (!cond) return true
  const value = values[cond.key]
  if (cond.equals !== undefined) {
    // An unchecked checkbox is ABSENT from the values (an off box stays unset: see the form
    // renderer's drop-when-empty rule), so an absent value reads as `false` when the condition
    // compares against a boolean. Without this, `equals: false` would never match at initial
    // render (only after a toggle on then off), hiding a field that should be shown.
    const actual = value === undefined && typeof cond.equals === 'boolean' ? false : value
    return actual === cond.equals
  }
  if (cond.includes !== undefined) return Array.isArray(value) && value.includes(cond.includes)
  // A `showWhen` with neither predicate is a malformed condition; treat as always visible.
  return true
}

/** Whether a filled value matches the field's declared type (structural, pre-semantic check). */
function valueMatchesFieldType(field: DescriptorField, value: DescriptorFieldValue): boolean {
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
 * Whether a value counts as FILLED. A checkbox is "present" only when checked, so a required
 * checkbox means "must be checked" and an unchecked `false` counts as unset. A numeric `0` is a
 * real answer (the strict comparisons never match it).
 */
function isFilled(value: DescriptorFieldValue | undefined): value is DescriptorFieldValue {
  if (value === undefined || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Whether a value {@link isFilled} rejects is nonetheless an ANSWER worth freezing. Exactly one
 * is: an explicit `false` on a `checkbox`, which is the opt-OUT of a default-ON toggle. Absent and
 * `false` are the same value there and opposite facts, so dropping it would leave a consumer
 * reading `inputs[key] !== false` (the tech-migration preset's `humanReview`) unable to ever
 * observe the unchecked state, and the toggle would be dead.
 *
 * A `false` on any OTHER field type is not an answer at all: it is a wrong-typed value that
 * {@link validateDescriptorFields} never type-checked, because the fill check short-circuits
 * first. Same for a blank string or an empty multi-select, which say nothing anywhere.
 */
function isExplicitOptOut(field: DescriptorField, value: DescriptorFieldValue): boolean {
  return field.type === 'checkbox' && value === false
}

/**
 * Validate filled values against a field list, returning a list of human-readable problems (EMPTY
 * means valid). Pure + total (never throws), so a controller maps a non-empty result to a single
 * `ValidationError` and the SPA disables its submit button off the same call. Enforces: no unknown
 * keys, the right value type per field, required VISIBLE fields present,
 * `select`/`checkbox-group` values drawn from the declared options, declared `maxLength` respected,
 * and `path` values that stay inside the repo ({@link isSafeRepoDirPath}). Hidden fields (failing
 * `showWhen`) are not required and their stale values are ignored.
 */
export function validateDescriptorFields(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): string[] {
  const problems: string[] = []
  const byKey = new Map(fields.map((f) => [f.key, f]))

  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) problems.push(`Unknown field "${key}".`)
  }

  for (const field of fields) {
    if (!isDescriptorFieldVisible(field, values)) continue
    const value = values[field.key]
    if (!isFilled(value)) {
      if (field.required) problems.push(`Field "${field.key}" is required.`)
      continue
    }
    if (!valueMatchesFieldType(field, value)) {
      problems.push(`Field "${field.key}" has the wrong type for a ${field.type ?? 'text'} field.`)
      continue
    }
    problems.push(...semanticProblems(field, value))
  }

  return problems
}

/** The per-type semantic checks, once the value is present and structurally right. */
function semanticProblems(field: DescriptorField, value: DescriptorFieldValue): string[] {
  const problems: string[] = []
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
  // A declared `maxLength` binds the SERVER too, not only the input's own attribute: a form is not
  // the only door (the public API fills the same fields), so the descriptor's stated bound has to
  // hold where the value is actually frozen.
  if (
    field.maxLength !== undefined &&
    typeof value === 'string' &&
    value.length > field.maxLength
  ) {
    problems.push(`Field "${field.key}" exceeds its maximum length of ${field.maxLength}.`)
  }
  return problems
}

/**
 * Reduce filled values to the ones SAFE to freeze: only fields the list declares, that are
 * currently VISIBLE (their `showWhen` holds), and that {@link validateDescriptorFields} actually
 * inspected. Unknown keys and hidden fields, whose stale values validation deliberately skips, are
 * dropped, so a hidden field can never freeze an unvalidated value (e.g. a `path` that escapes the
 * repo). Pure + total; run AFTER validation, on values already known valid.
 *
 * The UNFILLED values go too, and that is the same rule rather than a second one: validation
 * short-circuits on a value that says nothing, so a `false` on a `text` field, a blank string or
 * an empty multi-select reaches here having passed NO type check. Keeping them would freeze a
 * wrong-typed answer the prompt fold then renders to every agent as the operation's own brief
 * (`notes: false` reads as `Notes: No`), and would put a `custom` bag on a row that collected
 * nothing, when its presence is what tells the dispatch projection parameters WERE collected. The
 * one exception is {@link isExplicitOptOut}.
 */
export function sanitizeDescriptorFields(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): DescriptorFieldValues {
  const sanitized: DescriptorFieldValues = {}
  for (const field of fields) {
    if (!isDescriptorFieldVisible(field, values)) continue
    const value = values[field.key]
    if (value === undefined) continue
    if (!isFilled(value) && !isExplicitOptOut(field, value)) continue
    sanitized[field.key] = value
  }
  return sanitized
}

/**
 * Render one filled value as human-readable prose (option captions preferred over raw values,
 * `checkbox-group` joined, boolean as `Yes`/`No`). Shared by the initiative create flow's
 * skip-interview qa seeding, the operation prompt fold, and the SPA form review, so a field reads
 * identically everywhere. Deployment-supplied English. Pure + total.
 *
 * `field` is OPTIONAL because a bag key can outlive the descriptor that declared it (a node whose
 * build predates a re-registration still has to render the row it stored). With no field there is
 * no option list to consult, so the raw value is the answer; the caller does not have to invent a
 * fieldless descriptor to say so.
 */
export function renderDescriptorFieldValue(
  field: DescriptorField | undefined,
  value: DescriptorFieldValue,
): string {
  const labelOf = (raw: string): string =>
    (field?.options ?? []).find((o) => o.value === raw)?.label ?? raw
  if (Array.isArray(value)) return value.map(labelOf).join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  return labelOf(value)
}
