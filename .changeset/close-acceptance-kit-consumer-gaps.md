---
'@cat-factory/acceptance-kit': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/cli': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Close the gaps a third-party acceptance suite hit, and fix the 422 our own suite would have hit.

The kit is published so a deployment can cover its OWN providers, gates and environment backends.
The first consumer to actually do that came back with thirteen findings, and one of them is a real
defect here: a task `description` caps at 2,000 characters, both scaffold briefs in
`backend/internal/acceptance` measure past it (2,507 and 2,697), and scenario 01 passed them straight
through. The platform's own acceptance pass could not create its first task, and would have found
that out as a `422` after an operator had created two repositories and wired a workspace.

`briefFields` now owns the branch, reading the cap from the contracts rather than restating it: over
it the brief becomes an attached document (this surface's own documented path for spec-sized input),
under it nothing changes at all. `MAX_TASK_DESCRIPTION_CHARS` is exported so the branch and the route
cannot disagree.

The rest of the kit changes are seams a consumer had to re-derive by reading our source. A
`resource.ts` giving an external RESOURCE the record-before-you-can-observe discipline `resume.ts`
gives runs, because a teardown needs the provider's id plus what the provision captured and neither
can be re-derived, so a killed pass leaks a machine nothing on disk can name. `PassOptions.onSettled`,
so a reclaim report lands INSIDE the closing words rather than after the sentence written to be read
last. An `unknown` verdict constructor beside its two siblings, and `Prerequisite.probe`, so a check
reaching a host that is not the deployment still gets kernel's transport classification. A
`ConfigProblem` export. Provider-neutral evidence prose (`checkEphemeralEnvironment` claimed the
disposer reclaimed "the namespace", which is false of every non-Kubernetes backend). The console
password prompt as an opt-in `@cat-factory/acceptance-kit/console-credential` subpath, so the base
package keeps no terminal code. And the `.env` MERGE half published from `@cat-factory/cli` beside
the `renderEnvFile` it completes.

On `/api/v1` (spec `1.57.0`, all additive): `PublicServiceProvisioning` gains a `custom` variant so a
service pinned to a deployment's own environment backend can be declared and, more importantly, READ
BACK (the projection dropped what it could not describe, so a pinned service and an unpinned one
answered identically); `GET /api/v1/environments/connections` closes the write-only loop on handlers,
reporting BOTH manifest-id fields because the engine matches a pinned service against either and each
way of registering a handler sets only one; and `GET /api/v1/repos/{owner}/{name}/contents` reads one
file out of a linked repository, so a caller can grade what a run committed without a second VCS
credential. That read answers `ref: null` for a request that named none, since the branch the provider
resolved is not something it learns and the platform's recorded default may be one it invented; `sha`
is the handle to record. It refuses rather than answering approximately in three cases: past its own
cap, past the PROVIDER's contents ceiling (`file_too_large` either way, which is also what stops
GitHub's over-limit `403` reading as a revoked credential), and for bytes that are not UTF-8
(`file_not_text`, carrying the `sha`).

Watch for: `provisioning.type` must now be narrowed before `manifestSource` is read, since the public
union is no longer single-member. A `custom` service patch that omits `manifestPath` CLEARS the stored
one, which is the only way this surface can express "back to the manifest type's default".
`RepoFileContent` gains an optional `lossy`, so a `VcsClient` implementation outside this repo should
set it where it can tell. What was DELIBERATELY not added, and why, is
`backend/docs/adr/0058-acceptance-kit-consumer-gaps.md`.
