# ADR 0044: A runtime facade is the whole extension surface a deployment needs

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/kernel`, `@cat-factory/orchestration`, all three runtime
  facades) + docs/CI guards

Extends [ADR 0040](./0040-deployment-extension-seam-reachability.md), which made every app-owned
seam REACHABLE from the boot entry points. This one is about being able to BUILD a value to put in
one, and about who decides what a boot warning costs. The feature both serve is
[reusable operations](../reusable-operations.md).

## Context

The same org package that produced ADR 0040 came back after building its operation against the
published packages. Most of what it reported was already fixed; three things were not, and two of
them turned out to be one thing.

**ADR 0040's guard grades the door, not whether you can cut a key for it.** Its two classifications
assert that every registry on `CoreDependencies` is an option on `NodeContainerOptions` and on
`StartOptions` / `StartLocalOptions`. Both were green while the Node and local facades exported no
way to CONSTRUCT a `GateRegistry`, a `JudgeRegistry`, a `StepResolverRegistry`, a
`VcsProviderRegistry` or a `PromptFragmentRegistry`. The consumer reported the fragment registry
because that is the one their feature needed; the audit that followed found four more of exactly the
same shape, none of which any test could see. The Worker facade had a different subset of the same
hole, so the three runtimes' extension surfaces had silently diverged.

The consequence is not inconvenience. Every `@cat-factory/*` package publishes at an EXACT version.
A consumer that reaches below the facade for a builder and floats that dependency onto a newer patch
than its facade pins resolves a SECOND physical copy of the package, which is precisely the failure
ADR 0040 introduced the registry seam to remove: the registration lands in the copy the server does
not read, and the only symptom is agents that fold nothing. The workaround for the duplicate-copy
bug still required taking the dependency that causes duplicate copies.

**And a warning's severity is set by what the platform can know, not by what it costs.**
`task_type_unknown_fragment` has to be a warn: boot sees only the code pool, and an
account/workspace-tier id merges per workspace at run time, so refusing every id it cannot see would
reject the tenant-tier reference deployments are told to use. The message names both causes because
it cannot separate them. But a deployment whose operations reference only fragments it registers
itself knows the second cause does not apply to it, and for that deployment the warn names a real
defect: part of an operation's standing guidance never enters a run, and for a
`conditionalFragmentIds` entry it goes missing only for the cases matching the condition. The
consumer's workaround was a test of their own re-deriving what boot had already computed.

## Decision

**Each runtime facade re-exports the constructor and the types for every seam it lets a deployment
inject.** The registries and their `default…()` / `…WithBuiltins()` builders, the reusable-operation
authoring vocabulary (`CustomTaskType`, `TaskTypePresentation`, `TaskTypeFieldDescriptor`,
`TaskTypeFieldOption`, `PromptFragment`, the shared `DescriptorField*` shapes), the four descriptor
helpers, the built-in `*_PIPELINE_ID` constants, and `RegistrationProblem`. A deployment package's
only cat-factory runtime dependency is the facade it boots through, on all three runtimes.

**A third classification in `registry-seams.spec.ts` grades constructibility.** `SEAM_CONSTRUCTORS`
is a total `Record` over the seams routed `entry-point` or `bundled`, derived from `BOOT_ROUTES`
rather than listed, so a new deployment-facing seam fails to compile until its constructor is named,
and the runtime half then fails until the facade exports it. The local facade derives the same rule
from the Node facade's own exports (a name shape, not a second table); the Worker carries an
explicit symmetry copy, having no shared dependency that could hold one. The type half is a
compile-time assertion, since a type union is not reflectable.

**`escalateWarning` on `validateRegistrations`, surfaced as `escalateRegistrationWarning` on all
three entry points.** It takes the whole `RegistrationProblem` and returns whether it should fail
boot. Escalated problems are partitioned in one pass and thrown WITH the genuine errors, so a boot
failure still names every problem at once, and an escalated warning is not also logged.

**Kernel's re-export of the authoring vocabulary is completed** (`TaskTypePresentation`,
`TaskTypeFieldOption`, the shared `DescriptorField*` shapes), which the docs had promised as whole
while stopping at the top-level shape.

## Rationale

- **A guard belongs at the boundary a consumer crosses**, which is ADR 0040's own lesson applied one
  layer out. "The option exists" and "a value for it can be built" are different boundaries, and the
  five seams that failed the second while passing the first are the proof they need separate
  assertions. Neither classification can express the other: an option is a TYPE and a constructor is
  a VALUE, so one is a compile-time assertion over an interface and the other a runtime check over a
  module namespace.
- **The dependency rule is the reason, not the ergonomics.** A doc telling deployments to import
  from the facade would be advice; making the facade the only place the builder EXISTS removes the
  second copy by construction. That is why the fix is exports plus a guard rather than a paragraph.
- **An injected registry replaces rather than merges, and that stays true.** Merging would make
  suppression unexpressible (a deployment could never ship without the platform's gates or
  standards), so both builders are exported and neither is inferred, with the trap named at each
  export site: a bare `defaultGateRegistry()` silently drops `ci` / `conflicts` /
  `post-release-health` from every pipeline that names them.
- **Severity is platform judgement; disposition is deployment policy.** A predicate over the problem
  keeps ADR 0040's severity bar intact (boot errors on what is fully knowable, warns where it
  structurally cannot see) while letting the party that DOES know act on it. The alternative the
  report proposed, a second `strictFragmentIds` array beside `defaultFragmentIds`, would make every
  operation restate per-id a fact that is true of the whole deployment, and would need repeating for
  `conditionalFragmentIds` and for every future late-bound reference. A predicate also covers
  warnings added later without naming them.
- **The predicate is called once per warning**, so an impure one cannot disagree with itself between
  the log and the throw.

## Consequences

- A deployment can implement a whole reusable operation (task type, descriptor, fragments,
  conditional fragments, pipeline, variants) with one cat-factory dependency, and delete its own
  facade-style re-exports and the dependency-tree checks that protected them.
- The consumer-side strict check over code-owned fragment ids becomes one predicate at boot, running
  in production rather than only in that deployment's test suite.
- Three facades now publish overlapping surfaces, and the Worker's copy of the required-constructor
  list is a symmetry assertion rather than a derived one: a seam added to the Node classification
  without the Worker export fails the Worker's own test, but only because somebody kept the list in
  step. That is the residual gap, and it is bounded by the two derived guards on either side of it.
- Deployment-owned `documentRef` was refused when this ADR landed, and the guide stated why in terms
  of the actual constraint: the registration is correctly deployment-wide, and what was missing was
  a deployment-scoped CREDENTIAL HOME. [ADR 0045](./0045-deployment-scoped-documents.md) supplies
  one, so a code-registered fragment may now name a living document for every source except
  `github`, whose credential is a workspace's App installation.
- `escalateRegistrationWarning` was a PER-DEPLOYMENT switch over a per-id fact, which the same
  consumer's next round reported: a `defaultFragmentIds` array mixing code-registered standards with
  a `src:<sourceId>:<slug>` reference could only escalate both or neither, and the batched warning
  named its ids in prose alone. [ADR 0063](./0063-registration-warning-subjects.md) gives the warn
  branch a required singular `subject` and reports one warning per unresolved id, keeping this ADR's
  severity bar and its rejection of a second `strictFragmentIds` array intact.
- The descriptor condition vocabulary stays `equals` / `includes`. A third predicate is a live
  option that rides the first operation that genuinely needs it, because it is published in
  `/api/v1/task-types`, rendered by four SDKs, and has to state how it contradicts the existing two
  for the section-reachability check to stay sound.
