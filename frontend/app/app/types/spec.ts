// The prescriptive, service-level SPECIFICATION read view. These shapes mirror the
// `@cat-factory/contracts` `spec.ts` wire schemas exactly (see the note in `domain.ts`),
// so the service-spec endpoint's payload drops straight into the store. The spec lives
// sharded in the service repo under `spec/`; the backend reassembles it from the repo's
// default branch and serves it as `ServiceSpecView` for the inspector's "View
// Requirements" window.

export type RequirementPriority = 'must' | 'should' | 'could'
export type RequirementKind = 'functional' | 'nonfunctional' | 'constraint'

/** One acceptance criterion in Given/When/Then form — the seed for a Gherkin scenario. */
export interface AcceptanceCriterion {
  id: string
  given: string
  when: string
  /** The Gherkin "Then" clause (named `outcome` so the object is never thenable). */
  outcome: string
}

/** A single prescriptive requirement, traceable to the board task(s) it came from. */
export interface RequirementItem {
  id: string
  title: string
  statement: string
  kind: RequirementKind
  priority: RequirementPriority
  sourceBlockIds?: string[]
  acceptance?: AcceptanceCriterion[]
}

/** A domain rule / invariant scoped to the feature group it governs. */
export interface DomainRule {
  id: string
  rule: string
  rationale?: string
  sourceBlockIds?: string[]
}

/** A feature / logical group: related requirements plus the domain rules scoped to them. */
export interface RequirementGroup {
  name: string
  summary?: string
  requirements?: RequirementItem[]
  rules?: DomainRule[]
}

/** A module (domain) — the top level of the taxonomy, holding feature groups. */
export interface SpecModule {
  name: string
  summary?: string
  groups?: RequirementGroup[]
}

/** The unified prescriptive specification document for one service. */
export interface SpecDoc {
  service: string
  summary?: string
  modules?: SpecModule[]
}

/** A rendered Gherkin feature file read back from the repo. */
export interface SpecFeatureFile {
  module: string
  group: string
  path: string
  content: string
}

/** The service-spec view: the reassembled tree + its Gherkin files (empty when none). */
export interface ServiceSpecView {
  present: boolean
  spec: SpecDoc | null
  features: SpecFeatureFile[]
}
