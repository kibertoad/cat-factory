// Pure logic behind the service-spec window's IMPLEMENTATION-STATE view.
//
// `spec/` is prescriptive — it says what must be TRUE — and `requirementItem.state` is what
// lets it also say what is true YET (`aspirational` = agreed via the spec diff's PR review,
// `established` = a tester exercised its acceptance criteria and they passed). The agents
// already read that split off their checkout; this is the half a HUMAN reads, so the same
// window that lists a service's behaviour can say how much of it the service actually honours.
//
// Kept out of the SFC so the counting and filtering are unit-testable without mounting Nuxt.
import type { RequirementItem, RequirementState, SpecModule } from '~/types/spec'

/** Which half of the spec the reader wants to see. `all` is the default (nothing hidden). */
export type RequirementStateFilter = 'all' | RequirementState

/** Requirement counts for one scope (a group, or a whole spec). */
export interface RequirementStateSummary {
  total: number
  established: number
  aspirational: number
}

/**
 * Read a requirement's implementation state defensively. The wire schema defaults an absent
 * value to `aspirational` at the parse boundary, but a requirement nobody has observed to hold
 * is exactly what an unreadable/absent state means — so treating anything that is not literally
 * `established` as aspirational is both the safe answer and the one the backend renders.
 */
export function requirementState(item: Pick<RequirementItem, 'state'>): RequirementState {
  return item.state === 'established' ? 'established' : 'aspirational'
}

/** Count a list of requirements by implementation state. */
export function summarizeRequirementStates(
  requirements: readonly Pick<RequirementItem, 'state'>[] | undefined,
): RequirementStateSummary {
  const total = requirements?.length ?? 0
  let established = 0
  for (const req of requirements ?? []) {
    if (requirementState(req) === 'established') established += 1
  }
  return { total, established, aspirational: total - established }
}

/** Roll the per-group counts up across the whole spec tree (the overview pane's headline). */
export function summarizeSpecStates(
  modules: readonly SpecModule[] | undefined,
): RequirementStateSummary {
  const summary: RequirementStateSummary = { total: 0, established: 0, aspirational: 0 }
  for (const module of modules ?? []) {
    for (const group of module.groups ?? []) {
      const groupSummary = summarizeRequirementStates(group.requirements)
      summary.total += groupSummary.total
      summary.established += groupSummary.established
      summary.aspirational += groupSummary.aspirational
    }
  }
  return summary
}

/**
 * Apply the reader's state filter. `all` returns the SAME array reference (not a copy), so the
 * default view costs nothing and a `v-for` key set never churns on an unrelated re-render.
 */
export function filterRequirementsByState<T extends Pick<RequirementItem, 'state'>>(
  requirements: readonly T[] | undefined,
  filter: RequirementStateFilter,
): readonly T[] {
  const list = requirements ?? []
  if (filter === 'all') return list
  return list.filter((req) => requirementState(req) === filter)
}
