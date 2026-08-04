import type { DescriptorField, DescriptorFieldValues } from '~/types/domain'

// Form-side helpers over the shared descriptor-field vocabulary (`contracts/src/form-fields.ts`),
// used by every surface that renders one through `DescriptorFields.vue`: an initiative preset's
// create form and a reusable operation's per-case form on a custom task type.
//
// The RULES (visibility, validation, sanitization, prose rendering) live in contracts, because the
// server has to agree about them. What lives here is the one judgement only a FORM makes: which
// values to start it with.

/**
 * The initial, typed values a field list implies: its declared DEFAULTS folded into the
 * `DescriptorFieldValues` shape the renderer and the wire contract expect (`checkbox-group` to
 * `string[]`, `checkbox` to a boolean, `number` to a number, everything else a string). Only fields
 * with a meaningful default are seeded, so an unfilled optional field stays absent (which is what
 * validation reads as unset) and never freezes an empty value. A repo-detection probe's prefill and
 * the user's own edits layer on top.
 */
export function defaultDescriptorValues(fields: readonly DescriptorField[]): DescriptorFieldValues {
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
