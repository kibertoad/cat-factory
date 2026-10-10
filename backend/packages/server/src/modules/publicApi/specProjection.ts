import {
  PUBLIC_SPEC_MAX_ACCEPTANCE,
  PUBLIC_SPEC_MAX_FEATURE_CHARS,
  PUBLIC_SPEC_MAX_FEATURE_FILES,
  PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS,
  PUBLIC_SPEC_MAX_ISSUES,
  PUBLIC_SPEC_MAX_REQUIREMENTS,
  PUBLIC_SPEC_MAX_RULES,
  type PublicRunSpec,
  type PublicServiceSpec,
  type PublicSpecAnchor,
  type PublicSpecFeatureFile,
  type PublicSpecProvenance,
  type PublicSpecTruncation,
  type ReadSpecDoc,
  type RequirementGroup,
  type ServiceSpecView,
  type SpecFeatureFile,
  type SpecReadIssue,
} from '@cat-factory/contracts'

// Project the reader's {@link ServiceSpecView} onto the public wire shape, BOUNDED.
//
// A pure reduction, kept out of the controller because it is the half worth testing on its own:
// what a cap does to a tree is a property of this function, and every rule it applies exists to
// keep a bounded response from reading as a smaller spec.
//
// Four rules, and each is the same rule:
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
//     cap still names itself, because a vanished group reads as a service that never had one. Same
//     for a requirement whose criteria the acceptance budget could not fit: its id is the join key
//     this endpoint exists for, so the criteria are what a cap cuts, never the row that names them.
//  4. **EVERY axis is bounded, including the ones that do not grow with the spec.** The Gherkin is
//     capped across all files as well as within each one, and the issue list is capped too: it grows
//     with FAILURE, so a rate-limit window part-way through a large walk would otherwise make the
//     report of a degraded read the largest thing in a response whose every other axis is bounded.

/**
 * Clamp one feature file's Gherkin to `limit`, reporting what was kept and what exists.
 *
 * Counted and cut in code POINTS rather than UTF-16 units, the unit the debug surface's own
 * `chars`/`totalChars` are measured in: a `slice` on the raw string can land between the halves of
 * a surrogate pair and emit a lone one, which is a replacement character in the response and a
 * character count nobody can reproduce.
 *
 * `limit` is the smaller of the per-file cap and what is left of the response-wide one, so both
 * bounds report through the same `chars < totalChars` a reader already has to honour.
 */
function clampFeature(file: SpecFeatureFile, limit: number): PublicSpecFeatureFile {
  const points = [...file.content]
  const totalChars = points.length
  const chars = Math.min(totalChars, Math.max(limit, 0))
  return {
    module: file.module,
    group: file.group,
    path: file.path,
    content: chars === totalChars ? file.content : points.slice(0, chars).join(''),
    chars,
    totalChars,
    truncated: chars < totalChars,
  }
}

/**
 * The feature files this response carries: at most {@link PUBLIC_SPEC_MAX_FEATURE_FILES} of them,
 * holding at most {@link PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS} of Gherkin between them.
 *
 * The file count alone bounded the wrong thing: 500 files at the 20,000-character per-file cap is
 * a ten-megabyte body. A file the total budget cannot fit whole is carried CLAMPED rather than
 * dropped (its own `truncated` says so) and the walk stops at the first file the budget cannot
 * start, so `shown` counts what a caller actually received.
 */
function capFeatures(files: SpecFeatureFile[]): {
  features: PublicSpecFeatureFile[]
  truncations: PublicSpecTruncation[]
} {
  const features: PublicSpecFeatureFile[] = []
  let charBudget = PUBLIC_SPEC_MAX_FEATURE_TOTAL_CHARS
  for (const file of files.slice(0, PUBLIC_SPEC_MAX_FEATURE_FILES)) {
    if (charBudget <= 0) break
    const clamped = clampFeature(file, Math.min(PUBLIC_SPEC_MAX_FEATURE_CHARS, charBudget))
    charBudget -= clamped.chars
    features.push(clamped)
  }
  return {
    features,
    truncations:
      features.length < files.length
        ? [{ section: 'features', shown: features.length, total: files.length }]
        : [],
  }
}

/** Every group in the tree, in traversal order, so all three item caps cut the same way. */
function groupsOf(spec: ReadSpecDoc): RequirementGroup[] {
  return (spec.modules ?? []).flatMap((module) => module.groups ?? [])
}

/** What the whole tree declares, counted BEFORE anything is cut. */
function treeTotals(groups: RequirementGroup[]): {
  requirements: number
  rules: number
  acceptance: number
} {
  let requirements = 0
  let rules = 0
  let acceptance = 0
  for (const group of groups) {
    rules += (group.rules ?? []).length
    for (const requirement of group.requirements ?? []) {
      requirements += 1
      acceptance += (requirement.acceptance ?? []).length
    }
  }
  return { requirements, rules, acceptance }
}

/**
 * Rebuild the tree with at most {@link PUBLIC_SPEC_MAX_REQUIREMENTS} requirements,
 * {@link PUBLIC_SPEC_MAX_RULES} rules and {@link PUBLIC_SPEC_MAX_ACCEPTANCE} acceptance criteria
 * across it, reporting each cap that bit.
 *
 * The budgets are independent: a spec heavy in rules and light in requirements loses none of the
 * latter. They are spent in traversal order, so a group is either whole, partial, or empty, and
 * never a sample. A requirement whose criteria the acceptance budget could not fit is still
 * CARRIED (a requirement is the join key the whole endpoint exists for), with the criteria the
 * budget covered; the truncation row is what says the rest exist.
 */
function capTree(spec: ReadSpecDoc): {
  spec: ReadSpecDoc
  truncations: PublicSpecTruncation[]
} {
  const totals = treeTotals(groupsOf(spec))
  const truncations: PublicSpecTruncation[] = []
  if (totals.requirements > PUBLIC_SPEC_MAX_REQUIREMENTS) {
    truncations.push({
      section: 'requirements',
      shown: PUBLIC_SPEC_MAX_REQUIREMENTS,
      total: totals.requirements,
    })
  }
  if (totals.rules > PUBLIC_SPEC_MAX_RULES) {
    truncations.push({ section: 'rules', shown: PUBLIC_SPEC_MAX_RULES, total: totals.rules })
  }
  if (totals.acceptance > PUBLIC_SPEC_MAX_ACCEPTANCE) {
    truncations.push({
      section: 'acceptance',
      shown: PUBLIC_SPEC_MAX_ACCEPTANCE,
      total: totals.acceptance,
    })
  }
  if (truncations.length === 0) return { spec, truncations }
  let requirementBudget = PUBLIC_SPEC_MAX_REQUIREMENTS
  let ruleBudget = PUBLIC_SPEC_MAX_RULES
  let acceptanceBudget = PUBLIC_SPEC_MAX_ACCEPTANCE
  const modules = (spec.modules ?? []).map((module) => ({
    ...module,
    groups: (module.groups ?? []).map((group) => {
      const requirements = (group.requirements ?? [])
        .slice(0, Math.max(requirementBudget, 0))
        .map((requirement) => {
          const acceptance = (requirement.acceptance ?? []).slice(0, Math.max(acceptanceBudget, 0))
          acceptanceBudget -= acceptance.length
          return { ...requirement, acceptance }
        })
      const rules = (group.rules ?? []).slice(0, Math.max(ruleBudget, 0))
      requirementBudget -= requirements.length
      ruleBudget -= rules.length
      return { ...group, requirements, rules }
    }),
  }))
  return { spec: { ...spec, modules }, truncations }
}

/**
 * The read issues this response carries, capped, with a row saying so when the cap bit.
 *
 * The one axis that grows with FAILURE rather than with the spec: a rate-limit window part-way
 * through a few-thousand-shard walk logs a row per shard, so an uncapped list makes the report of
 * a degraded read the largest thing in a response whose every other axis is bounded.
 */
function capIssues(issues: SpecReadIssue[]): {
  issues: SpecReadIssue[]
  truncations: PublicSpecTruncation[]
} {
  if (issues.length <= PUBLIC_SPEC_MAX_ISSUES) return { issues, truncations: [] }
  return {
    issues: issues.slice(0, PUBLIC_SPEC_MAX_ISSUES),
    truncations: [{ section: 'issues', shown: PUBLIC_SPEC_MAX_ISSUES, total: issues.length }],
  }
}

/** The tree, the Gherkin, the issues and the caps: everything both spec reads answer alike. */
interface SpecBody {
  spec: ReadSpecDoc | null
  features: PublicSpecFeatureFile[]
  issues: SpecReadIssue[]
  truncations: PublicSpecTruncation[]
}

/**
 * The bounded body of one read view, shared by both spec endpoints.
 *
 * One function rather than one per endpoint, because the caps are a property of the DOCUMENT and
 * the two endpoints serve one document at two refs. A second copy is how the run read would come
 * to bound the Gherkin differently from the service read of the same repository.
 */
function specBody(view: ServiceSpecView): SpecBody {
  const capped = view.spec ? capTree(view.spec) : { spec: null, truncations: [] }
  const features = capFeatures(view.features)
  // An absent `diagnostics` means the producer diagnosed nothing, which on this path cannot
  // happen (the reader always sets it) but is answered as "no issues found" rather than left to
  // throw on a view assembled by hand.
  const issues = capIssues(view.diagnostics?.issues ?? [])
  return {
    spec: capped.spec,
    features: features.features,
    issues: issues.issues,
    truncations: [...capped.truncations, ...features.truncations, ...issues.truncations],
  }
}

/**
 * Project a read view onto the wire, under `anchor`.
 *
 * The anchor is passed IN rather than re-derived: the caller is where the four outcomes are
 * separated (an unreadable repository never reaches here at all), and a projection that recomputed
 * it from `view.present` would be a second opinion on the one judgement this endpoint exists to
 * make.
 */
export function toPublicServiceSpec(
  serviceId: string,
  anchor: PublicSpecAnchor,
  view: ServiceSpecView,
  provenance: PublicSpecProvenance,
): PublicServiceSpec {
  return { serviceId, anchor, provenance, ...specBody(view) }
}

/**
 * Project a RUN's read onto the wire. `view`/`provenance` are null exactly for `not_read`, the one
 * anchor state that describes the run rather than the branch.
 *
 * They travel together for that reason: an anchor of `not_read` with a provenance would name a
 * branch nothing was read from, and any other anchor without one would serve a tree that cannot say
 * where it came from. The signature makes both unrepresentable rather than leaving it to the caller
 * to pair them correctly.
 */
export function toPublicRunSpec(
  runId: string,
  read:
    | { anchor: PublicSpecAnchor; view: ServiceSpecView; provenance: PublicSpecProvenance }
    | { anchor: 'not_read' },
): PublicRunSpec {
  if (read.anchor === 'not_read') {
    return {
      runId,
      anchor: 'not_read',
      spec: null,
      features: [],
      provenance: null,
      issues: [],
      truncations: [],
    }
  }
  return { runId, anchor: read.anchor, provenance: read.provenance, ...specBody(read.view) }
}
