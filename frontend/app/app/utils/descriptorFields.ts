import { descriptorFieldSections } from '@cat-factory/contracts'
import type { DescriptorField, DescriptorFieldValue, DescriptorFieldValues } from '~/types/domain'

// Form-side helpers over the shared descriptor-field vocabulary (`contracts/src/form-fields.ts`),
// used by every surface that renders one through `DescriptorFields.vue`: an initiative preset's
// create form and a reusable operation's per-case form on a custom task type.
//
// The RULES (visibility, validation, sanitization, prose rendering, and now default seeding) live
// in contracts, because the server has to agree about them. What lives here is what only a FORM
// decides: how one edit changes the bag. Pure functions over the value bag rather than methods
// inside the SFC, so the mutation rules a wrong answer would freeze on an entity are unit-testable
// without mounting a component.

/**
 * A value that must stay ABSENT from the bag rather than freeze on the entity: an unchecked
 * (`false`) checkbox, a blank string, an empty multi-select, or a number that is not one (a
 * half-typed `number` input reads as `NaN`, which serialises to `null` on the wire and is refused
 * by the value schema, so the form must never carry it). A numeric `0` is a real answer and is kept.
 *
 * The same judgement the shared `validateDescriptorFields` / `sanitizeDescriptorFields` make about
 * an unset value, applied at the moment of the edit so the model never holds one at all.
 */
function isEmptyDescriptorValue(value: DescriptorFieldValue): boolean {
  if (typeof value === 'number') return !Number.isFinite(value)
  return value === false || value === '' || (Array.isArray(value) && value.length === 0)
}

/**
 * One field's value set immutably on the bag, DROPPING an empty one so a cleared field never
 * freezes an empty `''`/`[]`/`false` (mirroring `ProviderConnectionTab`'s delete-when-blank).
 */
export function setDescriptorValue(
  values: DescriptorFieldValues,
  key: string,
  value: DescriptorFieldValue | undefined,
): DescriptorFieldValues {
  const next = { ...values }
  if (value === undefined || isEmptyDescriptorValue(value)) delete next[key]
  else next[key] = value
  return next
}

/**
 * A checkbox's value set on the bag. A checkbox whose descriptor default is ON (`default: 'true'`)
 * must be able to persist an explicit `false`: {@link setDescriptorValue} otherwise drops it (an off
 * box "stays unset"), which for a default-ON field is indistinguishable from "untouched, still on",
 * so a consumer reading the opt-out as `humanReview !== false` (`seedMigrationPlan`) could never
 * observe the unchecked state and the toggle would be dead. A default-OFF checkbox keeps the
 * drop-when-false behaviour (absent === unchecked), so it never freezes a redundant `false`.
 */
export function setDescriptorCheckbox(
  values: DescriptorFieldValues,
  field: DescriptorField,
  checked: boolean,
): DescriptorFieldValues {
  if (!checked && field.default === 'true') return { ...values, [field.key]: false }
  return setDescriptorValue(values, field.key, checked)
}

/** One `checkbox-group` field's current value, as the `string[]` the renderer and wire expect. */
export function descriptorGroupValue(values: DescriptorFieldValues, key: string): string[] {
  const value = values[key]
  return Array.isArray(value) ? value : []
}

/** One row of a rendered descriptor form: a field, plus the section chrome that precedes it. */
export interface DescriptorFormRow {
  /** The field to render. Its `key` is the row's identity in the keyed diff. */
  field: DescriptorField
  /** The caption to print above this field, set only on the field that OPENS a captioned run. */
  caption?: string
  /** Whether this field opens a run with another run before it, i.e. needs the between-runs gap. */
  startsGroup: boolean
}

/**
 * A descriptor form reduced to a FLAT list of rows: the shared `descriptorFieldSections` grouping,
 * with each run's caption carried on the field that opens it rather than on a wrapper around it.
 *
 * Flat is the whole point, and it is a correctness rule rather than a layout preference. Run
 * membership is DERIVED state that changes as `showWhen` reveals and hides fields, while a field's
 * identity does not. Rendering the runs as nested `v-for`s re-parents a field the moment a boundary
 * moves, and Vue cannot move a node between two parents: it unmounts and remounts it. The field being
 * remounted is typically the one being TYPED INTO, because typing into a `showWhen` trigger is what
 * moved the boundary, so the input loses focus, caret and any in-flight IME composition mid-keystroke.
 * Keeping every field a sibling under one parent, keyed by `field.key`, makes that a MOVE, which
 * preserves the live input: the behaviour the flat column had before sections existed.
 *
 * Presentation, so it lives here rather than in contracts: what a caption spans is the shared rule,
 * and this is only how the SPA lays that out.
 */
export function descriptorFormRows(
  fields: readonly DescriptorField[],
  values: DescriptorFieldValues,
): DescriptorFormRow[] {
  return descriptorFieldSections(fields, values).flatMap((group, groupIndex) =>
    group.fields.map((field, fieldIndex) => ({
      field,
      ...(fieldIndex === 0 && group.section !== undefined ? { caption: group.section } : {}),
      startsGroup: fieldIndex === 0 && groupIndex > 0,
    })),
  )
}

/** One option toggled on/off in a `checkbox-group` field's value (deduped, order-preserving). */
export function toggleDescriptorGroupValue(
  values: DescriptorFieldValues,
  key: string,
  option: string,
  checked: boolean,
): DescriptorFieldValues {
  const current = descriptorGroupValue(values, key)
  const next = checked
    ? [...new Set([...current, option])]
    : current.filter((entry) => entry !== option)
  return setDescriptorValue(values, key, next)
}
