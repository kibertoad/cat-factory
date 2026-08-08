import {
  PUBLIC_SPEC_MAX_FEATURE_CHARS,
  PUBLIC_SPEC_MAX_FEATURE_FILES,
  PUBLIC_SPEC_MAX_REQUIREMENTS,
  PUBLIC_SPEC_MAX_RULES,
  type PublicServiceSpec,
  type PublicSpecFeatureFile,
  type PublicSpecProvenance,
  type PublicSpecTruncation,
  type RequirementGroup,
  type ServiceSpecView,
  type SpecDoc,
  type SpecFeatureFile,
} from '@cat-factory/contracts'

// Project the reader's {@link ServiceSpecView} onto the public wire shape, BOUNDED.
//
// A pure reduction, kept out of the controller because it is the half worth testing on its own:
// what a cap does to a tree is a property of this function, and every rule it applies exists to
// keep a bounded response from reading as a smaller spec.
//
// Three rules, and each is the same rule:
//
//  1. **A cap counts against the WHOLE tree, and reports the whole tree's total.** `shown`/`total`
//     are computed before anything is dropped, so a reader of a capped response still learns how
//     many requirements the service declares. A count taken off the rows would be exactly the lie
//     the truncation record exists to prevent.
//  2. **A cap cuts in TRAVERSAL ORDER and nothing is re-ranked.** The platform does not judge which
//     requirement matters more, so it drops the tail rather than inventing a severity. The wire
//     contract says so; a reader that needs a particular requirement has its id and the spec is a
//     repository away.
//  3. **An emptied group/module is kept, not pruned.** A group whose requirements all fell past the
//     cap still names itself, because a vanished group reads as a service that never had one.

/**
 * Clamp one feature file's Gherkin, reporting what was kept and what exists.
 *
 * Counted and cut in code POINTS rather than UTF-16 units, the unit the debug surface's own
 * `chars`/`totalChars` are measured in: a `slice` on the raw string can land between the halves of
 * a surrogate pair and emit a lone one, which is a replacement character in the response and a
 * character count nobody can reproduce.
 */
function clampFeature(file: SpecFeatureFile): PublicSpecFeatureFile {
  const points = [...file.content]
  const totalChars = points.length
  const over = totalChars > PUBLIC_SPEC_MAX_FEATURE_CHARS
  const kept = over ? points.slice(0, PUBLIC_SPEC_MAX_FEATURE_CHARS).join('') : file.content
  const chars = over ? PUBLIC_SPEC_MAX_FEATURE_CHARS : totalChars
  return {
    module: file.module,
    group: file.group,
    path: file.path,
    content: kept,
    chars,
    totalChars,
    truncated: chars < totalChars,
  }
}

/** Every group in the tree, in traversal order, so both item caps cut the same way. */
function groupsOf(spec: SpecDoc): RequirementGroup[] {
  return (spec.modules ?? []).flatMap((module) => module.groups ?? [])
}

/**
 * Rebuild the tree with at most {@link PUBLIC_SPEC_MAX_REQUIREMENTS} requirements and
 * {@link PUBLIC_SPEC_MAX_RULES} rules across it, reporting each cap that bit.
 *
 * The two budgets are independent: a spec heavy in rules and light in requirements loses none of
 * the latter. They are spent in traversal order, so a group is either whole, partial, or empty,
 * and never a sample.
 */
function capTree(spec: SpecDoc): { spec: SpecDoc; truncations: PublicSpecTruncation[] } {
  const groups = groupsOf(spec)
  const totalRequirements = groups.reduce((n, g) => n + (g.requirements ?? []).length, 0)
  const totalRules = groups.reduce((n, g) => n + (g.rules ?? []).length, 0)
  if (totalRequirements <= PUBLIC_SPEC_MAX_REQUIREMENTS && totalRules <= PUBLIC_SPEC_MAX_RULES) {
    return { spec, truncations: [] }
  }
  let requirementBudget = PUBLIC_SPEC_MAX_REQUIREMENTS
  let ruleBudget = PUBLIC_SPEC_MAX_RULES
  const modules = (spec.modules ?? []).map((module) => ({
    ...module,
    groups: (module.groups ?? []).map((group) => {
      const requirements = (group.requirements ?? []).slice(0, Math.max(requirementBudget, 0))
      const rules = (group.rules ?? []).slice(0, Math.max(ruleBudget, 0))
      requirementBudget -= requirements.length
      ruleBudget -= rules.length
      return { ...group, requirements, rules }
    }),
  }))
  const truncations: PublicSpecTruncation[] = []
  if (totalRequirements > PUBLIC_SPEC_MAX_REQUIREMENTS) {
    truncations.push({
      section: 'requirements',
      shown: PUBLIC_SPEC_MAX_REQUIREMENTS,
      total: totalRequirements,
    })
  }
  if (totalRules > PUBLIC_SPEC_MAX_RULES) {
    truncations.push({ section: 'rules', shown: PUBLIC_SPEC_MAX_RULES, total: totalRules })
  }
  return { spec: { ...spec, modules }, truncations }
}

/**
 * Project a read view onto the wire.
 *
 * `view.present === false` is passed through as-is: the CALLER has already separated the reasons a
 * view can be empty (this is only ever handed an absent spec, never a failed read), which is the
 * whole point of the reader's `diagnostics.anchor`.
 */
export function toPublicServiceSpec(
  serviceId: string,
  view: ServiceSpecView,
  provenance: PublicSpecProvenance,
): PublicServiceSpec {
  const capped = view.spec ? capTree(view.spec) : { spec: null, truncations: [] }
  const truncations = [...capped.truncations]
  const features = view.features.slice(0, PUBLIC_SPEC_MAX_FEATURE_FILES).map(clampFeature)
  if (view.features.length > PUBLIC_SPEC_MAX_FEATURE_FILES) {
    truncations.push({
      section: 'features',
      shown: PUBLIC_SPEC_MAX_FEATURE_FILES,
      total: view.features.length,
    })
  }
  return {
    serviceId,
    present: view.present,
    spec: capped.spec,
    features,
    provenance,
    // An absent `diagnostics` means the producer diagnosed nothing, which on this path cannot
    // happen (the reader always sets it) but is answered as "no issues found" rather than left to
    // throw on a view assembled by hand.
    issues: view.diagnostics?.issues ?? [],
    truncations,
  }
}
