import type { InlineUseCaseDefinition } from '@cat-factory/kernel'
import { isResolvableModelId, useCaseGenerationLimits } from '@cat-factory/kernel'
import { isNamespacedId, USE_CASE_TEXT_LIMITS } from '@cat-factory/contracts'
// Type-only, so the pairing with the module this section was extracted from stays a compile-time
// fact and no import cycle exists at runtime.
import type { RegistrationProblem } from './validateRegistrations.js'

/**
 * Deployment-registered INLINE USE CASES: every way a registration is broken that nothing at run
 * time can recover from, minus its parameter form (which its host still runs the SHARED descriptor
 * checker over, alongside every other registered form).
 *
 * Its own module rather than more of `validateRegistrations.ts` for the reason the binary-generator
 * section has one: a cohesive concern with a growing rule set, and a host at its size ratchet.
 *
 * All errors, by the bar the rest of that validator uses: each is fully knowable from the
 * registration itself. Boot is also the only door these ever reach. A use case is code, so no write
 * boundary refuses it, and every fault below is either silent or MISATTRIBUTED at request time:
 *
 *  - a malformed id is unaddressable, because the id IS the path segment;
 *  - an empty or ambiguously-defaulted model list means an invocation naming no model either cannot
 *    resolve one or resolves whichever the author happened to list first, which is exactly the
 *    substitution the narrowing exists to prevent;
 *  - a bound whose default sits outside its own range refuses every invocation that omits the knob,
 *    naming a value the caller never sent;
 *  - a catalog model id nothing resolves publishes as `provider_unavailable`, whose documented
 *    remedy is "configure the provider": the operator then hunts a key for a model that will never
 *    resolve, and the two-member reason vocabulary the surface publishes cannot say otherwise;
 *  - a caption outside the PUBLISHED bounds serves a shape the surface's own OpenAPI calls
 *    impossible, and silently, because a response is not re-validated on the way out;
 *  - a blank `systemPrompt` is the one the type comment already argues about: a use case with no
 *    instruction is an unrestricted model call wearing a name.
 */
export function inlineUseCaseProblems(useCase: InlineUseCaseDefinition): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const subject = `Inline use case "${useCase.useCaseId}"`
  const bad = (code: string, message: string): void => {
    problems.push({ severity: 'error', code: `use_case_${code}`, message: `${subject} ${message}` })
  }
  if (!isNamespacedId(useCase.useCaseId)) {
    bad(
      'bad_id',
      'is not a namespaced id. Use "<namespace>:<name>" (lowercase, dash-separated), e.g. "acme:scene-prose".',
    )
  }
  checkCaptions(useCase, bad)
  checkModels(useCase.models, bad)
  checkLimits(useCase, bad)
  return problems
}

/** One caption, held to the bound the wire schema publishes for it. */
function checkCaption(
  value: string | undefined,
  field: string,
  max: number,
  required: boolean,
  bad: (code: string, message: string) => void,
): void {
  if (value === undefined) {
    if (required) bad('missing_text', `declares no ${field}.`)
    return
  }
  if (value.trim() === '') {
    bad('blank_text', `declares a blank ${field}, which every caller sees as an empty caption.`)
  } else if (value.length > max) {
    bad(
      'text_too_long',
      `declares a ${field} of ${value.length} characters, past the ${max} this surface publishes.`,
    )
  }
}

/** The use case's own captions and its standing instruction. */
function checkCaptions(
  useCase: InlineUseCaseDefinition,
  bad: (code: string, message: string) => void,
): void {
  checkCaption(useCase.label, 'label', USE_CASE_TEXT_LIMITS.label, true, bad)
  checkCaption(useCase.description, 'description', USE_CASE_TEXT_LIMITS.description, true, bad)
  checkCaption(useCase.category, 'category', USE_CASE_TEXT_LIMITS.category, false, bad)
  if (useCase.systemPrompt.trim() === '') {
    bad(
      'blank_system_prompt',
      'declares a blank systemPrompt, so every invocation would be an unrestricted model call ' +
        'under this use case’s name. State what it may generate.',
    )
  }
}

/** The model list's own faults: empty, duplicated, no single default, or naming nothing. */
function checkModels(
  models: InlineUseCaseDefinition['models'],
  bad: (code: string, message: string) => void,
): void {
  if (models.length === 0) {
    bad('no_models', 'declares no models, so nothing can be generated through it.')
    return
  }
  const seen = new Set<string>()
  for (const option of models) {
    if (seen.has(option.id)) bad('duplicate_model', `declares model "${option.id}" twice.`)
    seen.add(option.id)
    checkCaption(option.id, `id for model "${option.id}"`, USE_CASE_TEXT_LIMITS.modelId, true, bad)
    checkCaption(
      option.label,
      `label for model "${option.id}"`,
      USE_CASE_TEXT_LIMITS.label,
      true,
      bad,
    )
    checkCaption(
      option.description,
      `description for model "${option.id}"`,
      USE_CASE_TEXT_LIMITS.description,
      false,
      bad,
    )
    // A `provider` source names its ref outright and is resolved by whatever the deployment
    // registered for that provider id, which is not knowable here. A `catalog` id is: the catalog
    // is a compile-time constant, so a typo in one is a boot fault rather than a request-time
    // misattribution.
    if (option.source.kind === 'catalog' && !isResolvableModelId(option.source.modelId)) {
      bad(
        'unknown_catalog_model',
        `declares model "${option.id}" as catalog id "${option.source.modelId}", which is not in ` +
          `the model catalog and is not a local-runner or OpenRouter id. Nothing would ever ` +
          `resolve it, and the invocation would report it as an unconfigured provider.`,
      )
    }
  }
  const defaults = models.filter((option) => option.default)
  if (defaults.length > 1) {
    bad(
      'ambiguous_default_model',
      `marks ${defaults.length} models as the default. Exactly one may carry \`default\`.`,
    )
  }
  if (defaults.length === 0 && models.length > 1) {
    // One model needs no flag (there is nothing to choose between). Several with none is the case
    // where an invocation omitting `model` would run on whichever happens to be listed first, and a
    // reorder would silently change what every such caller gets.
    bad(
      'no_default_model',
      'declares several models and marks none as the default, so an invocation naming no model has no stated answer.',
    )
  }
}

/** A generation bound whose own default falls outside it: every defaulted invocation is refused. */
function checkLimits(
  useCase: InlineUseCaseDefinition,
  bad: (code: string, message: string) => void,
): void {
  const limits = useCaseGenerationLimits(useCase)
  for (const [name, limit] of Object.entries(limits)) {
    if (limit.min > limit.max) {
      bad('bad_generation_range', `declares ${name} with min ${limit.min} above max ${limit.max}.`)
    } else if (limit.default < limit.min || limit.default > limit.max) {
      bad(
        'default_outside_generation_range',
        `declares ${name} default ${limit.default} outside its own ${limit.min}..${limit.max} range.`,
      )
    }
  }
}
