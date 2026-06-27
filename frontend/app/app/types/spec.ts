// The prescriptive, service-level SPECIFICATION read view. These shapes mirror the
// `@cat-factory/contracts` `spec.ts` wire schemas exactly (see the note in `domain.ts`),
// so the service-spec endpoint's payload drops straight into the store. The spec lives
// sharded in the service repo under `spec/`; the backend reassembles it from the repo's
// default branch and serves it as `ServiceSpecView` for the inspector's "View
// Requirements" window.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  RequirementPriority,
  RequirementKind,
  AcceptanceCriterion,
  RequirementItem,
  DomainRule,
  RequirementGroup,
  SpecModule,
  SpecDoc,
  SpecFeatureFile,
  ServiceSpecView,
} from '@cat-factory/contracts'
