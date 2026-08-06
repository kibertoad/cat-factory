import { descriptorFieldDefaults } from '@cat-factory/contracts'
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
 * The initial values a field list implies, for seeding a freshly opened form. A repo-detection
 * probe's prefill and the user's own edits layer on top.
 *
 * The SHARED helper, not a form-side copy: the server folds the same defaults in at the creation
 * door (`withDescriptorFieldDefaults`), so a duplicate here would be the drift that made a headless
 * caller and this form disagree about what a descriptor's default means.
 */
export function defaultDescriptorValues(fields: readonly DescriptorField[]): DescriptorFieldValues {
  return descriptorFieldDefaults(fields)
}

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
