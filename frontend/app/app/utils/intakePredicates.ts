import type { IssueIntakePredicate, TaskSourceState } from '@cat-factory/contracts'

/**
 * Whether the selected task source will actually APPLY an intake predicate the form offers.
 *
 * Both surfaces that compose an intake query (the recurring `bug-intake` schedule and the
 * interactive bug hunt) render one field per predicate, and not every tracker can evaluate every
 * one: Linear has no issue-type notion at all, and GitLab's is a closed set with no member meaning
 * "bug". A field whose value the backend then drops is worse than a missing field, because the
 * schedule saves, fires, and picks up an issue the operator believes it filtered out.
 *
 * The answer comes off `TaskSourceState`, which each provider declares, rather than a source-id
 * check here: restating the backend's compiler in the SPA is exactly how the two drift, and the
 * deployment-registered sources are not on a list this file could hold anyway.
 *
 * An UNRESOLVED source (nothing picked yet, or a state not loaded) answers `true`. The field is
 * shown plainly in that case, which is what it looked like before a source was chosen; claiming a
 * gap we cannot see yet would put a warning under every freshly-opened form.
 */
export function appliesIntakePredicate(
  state: TaskSourceState | undefined,
  predicate: IssueIntakePredicate,
): boolean {
  return !state?.ignoredIntakePredicates?.includes(predicate)
}
