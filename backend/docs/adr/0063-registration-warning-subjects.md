# ADR 0063: A boot warning names ONE subject, so a deployment can dispose of it per id

- **Status:** Accepted (implemented)
- **Date:** 2026-09-02
- **Context layer:** backend (`@cat-factory/orchestration`, all three runtime facades)

Completes [ADR 0044](./0044-facade-extension-surface.md)'s `escalateRegistrationWarning`. That ADR
established the split this one keeps: the SEVERITY of a boot-validation problem is platform
judgement, and the DISPOSITION is deployment policy. What it left unfinished is the granularity at
which a deployment can exercise that policy. The feature both serve is
[reusable operations](../reusable-operations.md).

## Context

`escalateRegistrationWarning` is a per-deployment switch. The fact it acts on is per-id.

`task_type_unknown_fragment` fires when a registered task type's `defaultFragmentIds` (or
`conditionalFragmentIds`) name a fragment the code pool does not resolve. Boot cannot tell the two
causes apart: a typo in a code-owned id, or an account/workspace-tier id that merges per workspace
at run time and is structurally invisible here. A deployment whose fragment ids are all code-tier
knows the second cause cannot apply to it, sets the predicate, and gets what it wants.

A deployment that MIXES the tiers gets neither. The reusable-operations guide sanctions the mix
explicitly: `defaultFragmentIds` may name code-pool fragments "or ... the tenant tiers (account /
workspace rows, and the `src:<sourceId>:<slug>` ids of a repo-backed fragment source)". So a single
array can legitimately hold three code-registered standards plus one late-bound reference, and for
that deployment:

- setting the predicate failed boot on the legitimate late-bound id, which boot cannot see;
- not setting it left the typo at `warn`, which is the defect the predicate exists to catch. Every
  run of that operation then folds one fewer standard, forever.

Two properties of the validator blocked any narrower predicate, and both were about the problem
shape rather than the check:

- **The warning batched.** `checkTaskTypeFragments` collected every unresolved id of one
  declaration into a SINGLE problem, so the escalation unit was (task type x declaration).
- **`RegistrationProblem` carried no structured subject**, only `severity` / `code` / `message`. The
  offending ids existed solely interpolated into prose, so a predicate could not act on them at all
  without parsing English, and the batching meant one problem covered both anyway.

Every other warning the validator produces already names exactly one subject (an agent kind, a
tool-server id, a credential key) and names it only in prose, so the class was nine warnings wide
and nothing could act on any of them by data.

The report that surfaced this arrived as a consumer's second-round gap report (their finding G6),
measured against `main` at `b12617072` and re-verified against HEAD. Their workaround was an
`unresolvedFragmentIds()` helper in their own registration module plus a unit test re-deriving what
boot had already computed.

## Decision

**`RegistrationProblem` is a UNION, and its warn branch carries a required, singular `subject`.**

```ts
export type RegistrationProblem = RegistrationError | RegistrationWarning
export interface RegistrationError {
  severity: 'error'
  code: string
  message: string
}
export interface RegistrationWarning {
  severity: 'warn'
  code: string
  message: string
  subject: string
}
```

`escalateWarning` and `onWarn` take `RegistrationWarning`, since a warning is all either ever sees.
The union member meaning is fixed per `code` and stated at each emit site; it is always the same id
the `message` interpolates.

**`task_type_unknown_fragment` reports one warning PER UNRESOLVED ID**, for `defaultFragmentIds` and
`conditionalFragmentIds` alike (they already share one checker). A mixed declaration therefore gets
a per-id disposition:

```ts
escalateRegistrationWarning: (p) =>
  p.code === 'task_type_unknown_fragment' && !p.subject.startsWith('src:'),
```

**The platform severity does not move.** Both halves of that mixed declaration are still `warn` by
default, because boot still cannot tell which cause either one has. What changed is that the
deployment can now say so per id.

**All three facades narrow the option and re-export both union members**, and the Node and Worker
seam guards now import those types FROM THE FACADE, so dropping a re-export fails a test rather
than only a consumer's build.

## Rationale

- **The escalation unit is the PROBLEM, so the problem's subject must be singular.** A predicate is
  called once per warning; a warning naming N ids hands the deployment a decision it cannot make.
  The report's own proposal was an optional `subjects?: readonly string[]`, which would have made
  the batch expressible and still undecidable: the mixed case would keep offering only "escalate
  both" or "escalate neither". A required, SINGULAR field makes the batch unrepresentable, so this
  is a type doing the work rather than a convention to remember.
- **Required beats optional, for the same reason `CoreDependencies.operationalMetrics` is
  required.** An optional `subject` is a field the next warning producer forgets, and a predicate
  reading `p.subject?.startsWith(…)` cannot distinguish "not my id" from "this producer named
  nothing". Splitting the union is what makes a subject-less warning fail to compile, at a cost of
  nine emit sites.
- **The platform must NOT classify an id's tier syntactically**, which is the one part of the
  report's recommendation we refused. It proposed treating a `src:`-prefixed id as late-bound and
  everything else as unresolvable-and-therefore-an-error, needing no predicate for the common case.
  A tenant-tier fragment id is not syntactically recognisable: a hand-authored account- or
  workspace-tier row carries a plain slug (`kernel/src/ports/fragment-repositories.ts`), and a
  repo-sourced file's explicit frontmatter `id` deliberately carries one too so it can SHADOW a
  built-in (ADR 0006, `FragmentSourceService.syncEntry`). Erroring on "matches no known late-bound
  shape" would therefore fail boot on exactly the tenant-tier reference deployments are told to use,
  which is the constraint the report itself named as binding.
- **Prose is not an interface.** A deployment could have regex'd the message, and the fact that this
  was the only available move is what made it a gap rather than an inconvenience: the message is
  written for a human reader and is rewritten whenever the explanation improves.
- **Per-id reporting matches what run time already does.** `FragmentLibraryService` logs the dropped
  ids of a run and counts them on `fragments.dropped_from_run` PER FRAGMENT, because a run five
  standards short is five defects rather than one. Boot was the only place that lumped them, and it
  is the place where lumping also removed the deployment's only lever.
- **The cost is accepted deliberately**: the two-cause paragraph now repeats per id in the boot log.
  A batched line naming four ids was shorter and left three of them un-actionable.

## Consequences

- A deployment mixing code-tier and tenant-tier fragment ids gets a boot failure on its typos and a
  warning on its late-bound references, from one predicate, and can delete the local
  `unresolvedFragmentIds()` helper and the test re-deriving boot's own computation.
- A deployment whose ids are all code-tier is unaffected: the predicate it already wrote
  (`(p) => p.code === 'task_type_unknown_fragment'`) still escalates every one of them.
- **Internal break** (pre-1.0, no shim): `RegistrationProblem` is a union, so a consumer
  constructing one by hand, or reading `problem.subject` off the union without narrowing on
  `severity`, must narrow first. A PREDICATE written against ADR 0044's signature is unaffected: its
  parameter is narrowed, not widened, and every field it could have read is still there.
- The boot log gains one line per unresolved fragment id where it previously emitted one per
  declaration.
- The remaining eight warnings now carry a machine-readable subject as well, so a deployment can
  escalate a single agent kind's `postops_without_structured_output` or one tool server's
  `tool_server_unservable`. None of them needed it yet; the class was closed together because the
  type is what enforces it, and a per-code exception is not expressible.
- What no type can state is that `subject` is the id the MESSAGE names. A warning whose prose points
  at one registration while its subject points at another would silently escalate the wrong one, so
  that relation is asserted over every warning a deliberately misconfigured registry produces,
  rather than pinned to a count that would fail on every ordinary addition.
