import {
  type DescriptorField,
  descriptorFieldDefaults,
  duplicatedDescriptorSectionCaptions,
  validateDescriptorFields,
} from '@cat-factory/contracts'
// Type-only, so the pairing with the module this section was extracted from stays a compile-time
// fact and no import cycle exists at runtime.
import type { RegistrationProblem } from './validateRegistrations.js'

// The shared boot checker for every DESCRIPTOR-DRIVEN FORM a registration declares (a custom task
// type's per-case form, an initiative preset's create form, a gate's per-step config form, an
// inline use case's parameter form). Its own module rather than more of `validateRegistrations.ts`
// for the reason the binary-generator and inline-use-case sections have one: a cohesive concern
// with a growing rule set, and a host at its size ratchet.

/**
 * The surfaces that declare a descriptor-driven form, as the prefix their boot-error codes carry.
 *
 * A UNION rather than a `string`, so adding the next such surface has to come here and be named,
 * which is the moment to ask whether {@link descriptorFormProblems} is wired for it at all. That
 * question went unasked for the gate config form, which rendered through the same component for a
 * release with none of these checks behind it.
 */
export type DescriptorFormSurface = 'task_type' | 'initiative_preset' | 'gate' | 'use_case'

/**
 * A descriptor-driven FORM that structurally cannot be filled, plus the one grouping fault that has
 * no honest rendering. Each of these is a typo in the deployment's own descriptor with no run-time
 * recovery, and each fails SILENTLY without this check: a duplicate key means the later declaration
 * wins wherever the fields are indexed, an optionless picker renders an empty control (and, if
 * required, makes the subject un-creatable), and a `showWhen` naming no declared field hides its own
 * field forever, so the value can never be collected.
 *
 * Errors rather than warnings, because unlike a `defaultFragmentIds` id (which may legitimately name
 * a tenant-tier fragment invisible at boot) every input here is fully known from the registration.
 *
 * Takes a plain FIELD LIST, because every surface that declares a form draws on one vocabulary
 * (`contracts/src/form-fields.ts`) and renders through one component: a custom task type's per-case
 * form, an initiative preset's create form and a registered gate's per-step config form fail these
 * ways identically, so they are checked by one function under their own {@link DescriptorFormSurface}
 * prefixes rather than by a copy each. A surface reaching that component without reaching this
 * checker is the gap to look for.
 */
export function descriptorFormProblems(
  fields: readonly DescriptorField[],
  codePrefix: DescriptorFormSurface,
  /**
   * How the message OPENS, e.g. `Gate "ci"`. Prose, deliberately not called a subject: a
   * `RegistrationWarning.subject` is a machine-readable ID, and while both fields carried the same
   * name the nearest value in scope for a new warn-severity check added here was this label.
   */
  label: string,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const seen = new Set<string>()
  const declared = new Set(fields.map((field) => field.key))
  const bad = (code: string, message: string): void => {
    problems.push({
      severity: 'error',
      code: `${codePrefix}_${code}`,
      message: `${label} ${message}`,
    })
  }
  for (const field of fields) {
    if (seen.has(field.key)) bad('field_duplicate', `declares field "${field.key}" twice.`)
    seen.add(field.key)
    if ((field.type === 'select' || field.type === 'checkbox-group') && !field.options?.length) {
      bad(
        'field_no_options',
        `declares "${field.key}" as a ${field.type} with no options, so the form renders an empty picker.`,
      )
    }
    if (field.showWhen && !declared.has(field.showWhen.key)) {
      bad(
        'field_unknown_condition',
        `gates field "${field.key}" on "${field.showWhen.key}", which it does not declare, so the field never shows.`,
      )
    }
    problems.push(...defaultOutsideOptions(field, codePrefix, label))
    problems.push(...defaultBreaksOwnRules(field, codePrefix, label))
  }
  // A `section` a filled form can be made to caption TWICE. Presentation rather than fillability,
  // and an error all the same: the renderer preserves declaration order, so the caption renders
  // twice (reading as a platform fault rather than as the declaration it is), and the only
  // alternative would be moving a field away from where its author wrote it. Fully knowable from the
  // registration, so boot is where it can still be fixed.
  //
  // Reachability, not contiguity: interleaving a section with a MUTUALLY EXCLUSIVE branch is how a
  // form keeps each branch's fields beside the picker they qualify, and it prints one caption in
  // every state. Refusing it would fail boot over a form nobody can break.
  for (const caption of duplicatedDescriptorSectionCaptions(fields)) {
    bad(
      'field_section_interleaved',
      `declares section "${caption}" in two places with a field between them that shows at the ` +
        `same time, so its caption renders twice. Declare a section's fields consecutively ` +
        `(matching on case and spacing, which the renderer folds), or gate the field between them ` +
        `so it cannot show alongside both.`,
    )
  }
  return problems
}

/**
 * A declared DEFAULT that is not one of the field's own options: an error for the same reason the
 * three above are: fully known from the registration, and silently broken at run time.
 *
 * It became reachable when the creation door started folding defaults in
 * (`withDescriptorFieldDefaults`), which is what makes a default mean the same thing to a form and
 * to a headless caller. The consequence is that a default outside the picklist is no longer merely
 * a form that opens on an odd value: it is an answer the validator refuses, so EVERY creation of
 * the subject fails with "has a value outside its options" naming a value the caller never sent.
 */
function defaultOutsideOptions(
  field: DescriptorField,
  codePrefix: DescriptorFormSurface,
  /** The message's opening prose, as in {@link descriptorFormProblems}. */
  label: string,
): RegistrationProblem[] {
  const options = new Set((field.options ?? []).map((option) => option.value))
  if (options.size === 0) return []
  const declared =
    field.type === 'checkbox-group'
      ? (field.defaultValues ?? [])
      : field.type === 'select' && field.default !== undefined
        ? [field.default]
        : []
  return declared
    .filter((value) => !options.has(value))
    .map((value) => ({
      severity: 'error' as const,
      code: `${codePrefix}_field_default_outside_options`,
      message:
        `${label} defaults field "${field.key}" to "${value}", which is not one of its ` +
        `options, so every creation of it is refused for a value the caller never sent.`,
    }))
}

/**
 * A declared DEFAULT that the field's OWN value rules refuse: a `number` outside its `min` / `max`
 * or not whole when `integer` is set, a text default longer than its `maxLength`, a `path` default
 * that escapes the repo. The sibling of {@link defaultOutsideOptions}, which owns the option-drawn
 * types, so a picker's bad default is reported once.
 *
 * Reachable for the same reason that one is: every door fills declared defaults in before it
 * validates, so a default its own field refuses fails EVERY creation of the subject (for a gate,
 * every save and every run of a pipeline holding the step) naming a value the caller never sent,
 * and the only workaround is overriding the field everywhere it appears. Fully knowable from the
 * registration, so boot is where it is refused.
 *
 * The field is judged unconditionally (its `showWhen` set aside): a default is declared whether or
 * not the field is showing, and a hidden field's default surfaces the moment the field shows.
 */
function defaultBreaksOwnRules(
  field: DescriptorField,
  codePrefix: DescriptorFormSurface,
  /** The message's opening prose, as in {@link descriptorFormProblems}. */
  label: string,
): RegistrationProblem[] {
  if (field.type === 'select' || field.type === 'checkbox-group') return []
  const defaults = descriptorFieldDefaults([field])
  if (!(field.key in defaults)) return []
  const { showWhen: _ignored, ...unconditional } = field
  return validateDescriptorFields([unconditional], defaults).map((problem) => ({
    severity: 'error' as const,
    code: `${codePrefix}_field_default_invalid`,
    message:
      `${label} declares a default for field "${field.key}" that its own rules refuse (${problem}), ` +
      `so every creation of it is refused for a value the caller never sent.`,
  }))
}
