---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Public API (`/api/v1`, spec 1.32.0): serve a service's in-repo specification. Additive.

One new operation, `GET /api/v1/services/:serviceId/spec` at `read` scope: the prescriptive
requirement tree stored under `spec/` in the service's repository (modules → feature groups →
requirement items, each with its MoSCoW priority, its `aspirational`/`established` state and its
Given/When/Then acceptance criteria, plus the domain rules scoped to each group), the Gherkin
rendered from the same tree, and the branch and commit both were read at.

It closes a join, not just a gap. The requirement ids on `GET /api/v1/runs/:runId/report` and
`.../outcome` were already a key onto a document no headless caller could fetch, so an
outcome-reviewing integration could read what a run scored and not what it scored against. Fetch the
spec once per service and a run's outcome per run, and criterion → evidence is a map lookup outside
the platform.

**The read has four outcomes and the endpoint keeps them apart.** The reader behind it is total (a
flaky repository read degrades rather than throwing), and the app's own requirements window folds an
unreadable repository into the same empty state as a repository with no spec, which is right for a
window and wrong for an integrator: folded here it would report every service as requirement-free
for the duration of a VCS incident. So `present: false` means only "no spec on the default branch";
an unreadable repository is a `503` with `reason: "spec_read_failed"`; an unwired or unconnected VCS
integration is a `503` with `reason: "vcs_not_configured"`; a service frame with no linked repository
is the same `422` that starting a run on it gets; and a spec that read PARTIALLY is served, with
`issues` naming every file that did not survive and how many items a salvaged group lost.

**Two commitments a consumer should read.** `SpecDoc` and everything under it (`SpecModule`,
`RequirementGroup`, `RequirementItem`, `AcceptanceCriterion`, `DomainRule`) are served as the SAME
shapes the app consumes rather than a re-projection, deliberately, so one artifact cannot be
described two ways. From this version they are part of the stable `/api/v1` surface rather than
internals. And the `spec/` tree is anchored at the repository ROOT, so two services carved out of
one monorepo share one spec and this endpoint answers both alike; `provenance` names the repository
and commit rather than a subdirectory, because a subdirectory would imply a scoping the read does
not apply.

There is deliberately no write side: the spec's write path is a reviewed commit, and `state` is
promoted only by an observed test pass.

Internal, not `/api/v1`: `readServiceSpec` now returns a `diagnostics` field on `ServiceSpecView`
(`anchor` plus per-file `issues`), so every caller can separate an absent spec from an unread one.
The field is optional, so a view assembled by hand keeps type-checking, and `EMPTY_SERVICE_SPEC_VIEW`
carries none.
