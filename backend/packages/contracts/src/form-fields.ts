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
  /**
   * Optional grouping caption, rendered once above the run of consecutively-declared fields that
   * share it ({@link descriptorFieldSections}). Deployment-supplied English, like every other
   * caption here.
   *
   * PRESENTATION ONLY: it groups nothing else. A section has no effect on validation, on what is
   * frozen, or on how the answers fold into a prompt, so moving a field between sections can never
   * change what the platform does with its value. It exists because a form that collects a dozen
   * fields, each of which changes what the agents do, reads as one undifferentiated column.
   */
  section: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
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
  /**
   * Inclusive bounds for a `number` value, enforced by the input AND the validator; ignored for
   * every other type.
   *
   * The numeric counterpart of {@link maxLength}, and it exists for the same reason: a declared
   * bound that only the input enforces is not a bound, because the form is not the only door. A
   * gate's `maxAttempts` filled over the public API, or typed into a hand-authored pipeline, has
   * to be refused where the value is FROZEN — otherwise the only remaining defence is the reader
   * silently clamping it, which turns a configuration mistake into behaviour nobody asked for and
   * nobody is told about.
   */
  min: v.optional(v.number()),
  max: v.optional(v.number()),
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

/**
 * The typed values a field list's declared DEFAULTS imply, in the `DescriptorFieldValues` shape the
 * renderer, the wire contract and the validators all expect (`checkbox-group` to `string[]`,
 * `checkbox` to a boolean, `number` to a number, everything else a string).
 *
 * Only fields with a MEANINGFUL default are seeded, so an unfilled optional field stays absent,
 * which is what validation reads as unset and what sanitization keeps out of the frozen bag.
 */
export function descriptorFieldDefaults(fields: readonly DescriptorField[]): DescriptorFieldValues {
  const values: DescriptorFieldValues = {}
  for (const field of fields) {
    if (field.type === 'checkbox-group') {
      if (field.defaultValues?.length) values[field.key] = [...field.defaultValues]
    } else if (field.type === 'checkbox') {
      if (field.default === 'true') values[field.key] = true
    } else if (field.type === 'number') {
      const parsed = Number(field.default)
      if (field.default !== undefined && field.default !== '' && Number.isFinite(parsed)) {
        values[field.key] = parsed
      }
    } else if (field.default) {
      values[field.key] = field.default
    }
  }
  return values
}

/**
 * A filled bag with each ABSENT field's declared default folded in: the values a door should
 * validate, sanitize and freeze.
 *
 * This is what keeps the doors from disagreeing. The SPA seeds a form with
 * {@link descriptorFieldDefaults} before the user touches it, so a `required` field carrying a
 * default arrives filled from the browser and is never refused there. A headless caller sends only
 * what it knows about, so the SAME descriptor refused the SAME creation over the public API for a
 * value the deployment had already stated. Applying defaults HERE, at the door rather than in the
 * form, makes the descriptor's default mean one thing everywhere: the answer when the caller gives
 * none.
 *
 * Only absent keys are filled, so an explicit value always wins, including the one case where the
 * distinction is load-bearing: a `false` on a default-ON `checkbox` is the opt-OUT, and re-seeding
 * `true` over it would make that toggle unpressable for every caller that is not the form.
 */
export function withDescriptorFieldDefaults(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): DescriptorFieldValues {
  const defaults = descriptorFieldDefaults(fields)
  const merged: DescriptorFieldValues = { ...values }
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in merged)) merged[key] = value
  }
  return merged
}

/**
 * Evaluate ONE {@link DescriptorFieldShowWhen} against a filled bag.
 *
 * The single evaluator for the whole vocabulary, extracted from {@link isDescriptorFieldVisible}
 * when a second consumer appeared (a registered task type selecting extra standing-context
 * fragments from the answers just collected). It carries the two non-obvious rules a re-implementation
 * would get wrong: an absent value reads as `false` against a BOOLEAN condition, and a condition with
 * neither predicate is malformed and reads as `true`.
 *
 * `true` for a malformed condition is the right default HERE, where the caller is asking "does this
 * gate hold", because the alternative silently removes a field from a form. A caller for whom the
 * safe default is the other way round says so at its own site rather than by re-deriving the rule.
 */
/**
 * Whether a condition STATES anything. Both predicates are optional in the schema, so a dropped
 * `equals: 'graphql'` still validates and arrives here saying nothing.
 *
 * Exported because the two readers must not each re-derive it, and they react OPPOSITELY:
 * {@link matchesDescriptorCondition} treats a predicate-less condition as satisfied (the
 * alternative hides a field forever), while boot validation refuses one on a conditional-fragment
 * rule (where "always satisfied" seeds every case with guidance meant for one). One predicate, two
 * dispositions, is the shape the repo already uses for a rule whose outcome is judged per caller.
 */
export function descriptorConditionHasPredicate(condition: DescriptorFieldShowWhen): boolean {
  return condition.equals !== undefined || condition.includes !== undefined
}

export function matchesDescriptorCondition(
  condition: DescriptorFieldShowWhen,
  values: DescriptorFieldValues,
): boolean {
  const value = values[condition.key]
  if (condition.equals !== undefined) {
    // An unchecked checkbox is ABSENT from the values (an off box stays unset: see the form
    // renderer's drop-when-empty rule), so an absent value reads as `false` when the condition
    // compares against a boolean. Without this, `equals: false` would never match at initial
    // render (only after a toggle on then off), hiding a field that should be shown.
    const actual = value === undefined && typeof condition.equals === 'boolean' ? false : value
    return actual === condition.equals
  }
  if (condition.includes !== undefined) {
    return Array.isArray(value) && value.includes(condition.includes)
  }
  // A condition with neither predicate is malformed; treat as satisfied (see the doc comment).
  return true
}

/** Whether a field is visible given the current values (its `showWhen` condition). */
export function isDescriptorFieldVisible(
  field: DescriptorField,
  values: DescriptorFieldValues,
): boolean {
  return !field.showWhen || matchesDescriptorCondition(field.showWhen, values)
}

/** One run of a descriptor form: the fields to render, and the caption to render above them. */
export interface DescriptorFieldSection {
  /** The caption for this run, absent for the fields that declare no section. */
  section?: string
  /** The run's VISIBLE fields, in declaration order. Never empty. */
  fields: DescriptorField[]
}

/**
 * The caption a section groups under: its own text folded on CASE and on whitespace runs, so two
 * spellings of one section ("Placement" / "placement") are ONE run rather than two identical-looking
 * captions in a row. Whitespace-only is no section at all: the schema bounds a caption at
 * `minLength(1)`, but a CODE registration is never parsed, so `'  '` reaches here and must read as
 * "ungrouped" instead of rendering an empty heading.
 *
 * The same fold, for the same reason, as the task-type picker's category rows (`taskTypePicker.ts`),
 * including why it is not slugified: a caption is arbitrary Unicode a deployment writes in its own
 * language, so reducing it to an id-safe key would fold genuinely distinct captions together.
 */
function sectionOf(field: DescriptorField): { key: string; caption: string } | undefined {
  const caption = field.section?.trim()
  if (!caption) return undefined
  return { key: caption.toLowerCase().replace(/\s+/g, ' '), caption }
}

/**
 * A field list reduced to the runs a form RENDERS: consecutively-declared fields sharing one
 * `section`, over the fields currently VISIBLE, in declaration order.
 *
 * The grouping rule lives here rather than in the renderer because two surfaces read it: the SPA's
 * `DescriptorFields.vue`, and the boot check that refuses a declaration this reduction cannot render
 * honestly ({@link duplicatedDescriptorSectionCaptions}).
 *
 * Two properties the caller gets from the ORDER of the two steps:
 *
 * - **A section whose every field is hidden renders NO caption**, because visibility is applied
 *   before the runs are cut, so an empty run never exists. A caption over nothing reads as a form
 *   that failed to load its own controls. It also means a hidden field BETWEEN two fields of one
 *   section does not split its caption in half.
 * - **Declaration order is never rearranged.** A field renders where its author declared it, and a
 *   section declared in two places stays two runs. Merging them would move a field away from where
 *   it was written, which is why the boot check refuses that declaration rather than this function
 *   quietly repairing it.
 */
export function descriptorFieldSections(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): DescriptorFieldSection[] {
  const sections: DescriptorFieldSection[] = []
  let openKey: string | undefined
  for (const field of fields) {
    if (!isDescriptorFieldVisible(field, values)) continue
    const declared = sectionOf(field)
    const open = sections[sections.length - 1]
    if (open && declared?.key === openKey) {
      open.fields.push(field)
      continue
    }
    // The FIRST spelling of a folded caption is the one rendered, because the caption is the
    // deployment's own words rather than an id.
    sections.push({ ...(declared ? { section: declared.caption } : {}), fields: [field] })
    openKey = declared?.key
  }
  return sections
}

/**
 * Whether two fields can be visible AT THE SAME TIME, i.e. whether some value bag satisfies both
 * their `showWhen` conditions at once.
 *
 * This is what keeps {@link duplicatedDescriptorSectionCaptions} from refusing a declaration that
 * renders perfectly. A form whose shape is chosen by one picker routinely declares the branches
 * INTERLEAVED, because each branch's fields belong beside the ones they qualify:
 *
 *   kind (select) | Endpoint: method (kind=http) | Command: argv (kind=cli) | Endpoint: timeout (kind=http)
 *
 * `Endpoint` is declared in two places and can never print twice, because the `Command` field
 * between them is visible in exactly the state its two neighbours are not. Reading contiguity off
 * the flat list alone would fail this deployment's boot over a form no user can break.
 *
 * Sound for the single-condition vocabulary: two conditions on DIFFERENT keys are independent (one
 * bag satisfies both), and on the SAME key only two shapes contradict, both because one value
 * cannot be two things at once: differing `equals`, and `equals` (a scalar) against `includes` (an
 * array). Because pairwise contradiction is the only kind available, checking pairs decides
 * satisfiability for a whole set. A predicate-less condition states nothing and reads as
 * always-visible, matching {@link matchesDescriptorCondition}.
 */
function canCoexist(a: DescriptorField, b: DescriptorField): boolean {
  const x = a.showWhen
  const y = b.showWhen
  if (!x || !y) return true
  if (!descriptorConditionHasPredicate(x) || !descriptorConditionHasPredicate(y)) return true
  if (x.key !== y.key) return true
  if (x.equals !== undefined && y.equals !== undefined) return x.equals === y.equals
  if (x.includes !== undefined && y.includes !== undefined) return true
  return false
}

/**
 * The sections whose caption a form can be made to print TWICE, in first-offence order.
 *
 * Boot refuses these, because neither available rendering is honest. {@link descriptorFieldSections}
 * preserves declaration order, so the caption appears twice, which reads as a platform fault rather
 * than as the declaration it is; merging the runs instead would render a field order nobody wrote.
 * Both are fully knowable from the registration, which is the one place it can still be fixed, and
 * both are presentation, so there is no run-time recovery to prefer either way.
 *
 * The criterion is REACHABILITY, never contiguity in the declared list, because the reduction this
 * mirrors applies visibility BEFORE it cuts the runs. So a caption is reported only on finding a
 * concrete state that prints it twice: two of its fields with a differently-captioned field between
 * them, all three simultaneously visible ({@link canCoexist}). A declaration that interleaves only
 * through mutually exclusive branches is silently fine, which is the common case rather than an edge
 * one, and a false refusal here would fail boot outright.
 *
 * Reported by the FIRST-SEEN spelling, and folded through the same key the runs are cut on, so a
 * case-variant re-declaration is caught rather than passing as a distinct section.
 */
export function duplicatedDescriptorSectionCaptions(fields: readonly DescriptorField[]): string[] {
  const declared = fields.map((field) => ({ field, section: sectionOf(field) }))
  const reported = new Map<string, string>()
  for (const [index, opener] of declared.entries()) {
    const open = opener.section
    if (!open || reported.has(open.key)) continue
    for (let split = index + 1; split < declared.length; split++) {
      const splitter = declared[split]!
      // A field of the same section only EXTENDS the open run, and one that cannot be on screen
      // beside the opener cannot close its run either.
      if (splitter.section?.key === open.key) continue
      if (!canCoexist(opener.field, splitter.field)) continue
      const reopens = declared
        .slice(split + 1)
        .some(
          (candidate) =>
            candidate.section?.key === open.key &&
            canCoexist(opener.field, candidate.field) &&
            canCoexist(splitter.field, candidate.field),
        )
      if (reopens) {
        reported.set(open.key, open.caption)
        break
      }
    }
  }
  return [...reported.values()]
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
      // Equivalent to `unfilledRequiredDescriptorFields` by construction: visibility and
      // filled-ness are already decided by the two lines above, so all that is left of that
      // predicate here is `required`. Calling it would allocate a list and a Set per validation
      // to re-derive what this loop has in hand. The shared rule is what the OTHER caller (the
      // input gate) needs, because it reports the descriptors rather than walking them.
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

/**
 * The required fields a descriptor form declares that this value bag does NOT answer, in
 * declaration order.
 *
 * Split out of {@link validateDescriptorFields} because two very different doors ask it and must
 * agree: the create FORM refuses a submission, and the pre-dispatch INPUT GATE parks a run whose
 * task reached the board some other way (the public API, an initiative spawn, a tracker import
 * and every path the form never guarded). One rule, so a deployment that marks a field required
 * cannot have it enforced at one door and ignored at the other.
 *
 * VISIBILITY is honoured, and it is the whole subtlety: a field hidden by its own `showWhen`
 * is not required, because a form that never showed it cannot have asked for it. Parking a run
 * on such a field would name an input with nowhere to go and fix it.
 *
 * Returns the DESCRIPTORS rather than the keys, so a caller rendering a refusal has the human
 * label without a second lookup against a list it would have to be handed anyway.
 */
export function unfilledRequiredDescriptorFields(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): DescriptorField[] {
  return fields.filter(
    (field) =>
      field.required && isDescriptorFieldVisible(field, values) && !isFilled(values[field.key]),
  )
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
  if (typeof value === 'number') {
    if (field.min !== undefined && value < field.min) {
      problems.push(`Field "${field.key}" must be at least ${field.min}.`)
    }
    if (field.max !== undefined && value > field.max) {
      problems.push(`Field "${field.key}" must be at most ${field.max}.`)
    }
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
