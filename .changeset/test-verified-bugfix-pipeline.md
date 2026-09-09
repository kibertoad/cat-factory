---
'@cat-factory/contracts': patch
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
---

Add a bugfix preset that proves the fix from the repository and spends the environment on one question

Every way the platform had of establishing that a change works needs a running system: the API and
UI testers read a provisioned ephemeral environment, and the acceptance author writes tests that
target one. On a deployment whose preview environments are slow, costly or not representative, that
makes a bugfix wait on infrastructure to answer a question a committed test answers better, and it
leaves nothing behind: the environment goes away and the next regression is found the same way.

`pl_bugfix_tested` ("Fix bug, verified by tests") is `pl_bugfix`'s investigate, triage, reproduce,
fix, review spine with the verification moved into the checkout:

- **`mocker` then `integration-test`**, both after the fix and both before the `ci` gate. The mock
  step is the existing one (WireMock stubs the repo owns, wired into compose and CI); the
  integration step is a new registered kind that drives the fix through the seam a caller uses
  against those stubs, commits the tests, and reports what it could NOT cover. CI re-running them
  is the enforcement, which is why the step is a `container-coding` kind rather than a tester: only
  the tester family is handed environment coordinates, so tests written here cannot come to depend
  on a URL even by accident.
- **`deployer` then `disposer`, with nothing between them**, as a LAUNCH CHECK. The deployer
  provisions the pull-request branch and settles on a reachability verdict, so a service that no
  longer starts fails the run; a service that stands nothing up records a clean no-op as always.
  That verdict is the only thing this preset asks an environment for, so the reclaim is adjacent
  rather than terminal: holding the environment through the merge tail would bill for a URL no step
  is going to open.

Two things about the new step are deliberate and worth knowing before editing it. Committing no
test never fails the run (the fix is already pushed by the time it runs, so a failure would throw
the work away rather than name the gap): it reports `outcome: 'uncovered'` with the reason, and an
unreadable reply degrades to the same value rather than to a claim it never made. And the gaps it
states are rendered even under a `covered` verdict, because the reported behaviour being covered
says nothing about the neighbouring case that is not.

**Behaviour change: a marked BUG-FISHING finding now spawns onto this preset by default** instead of
`pl_bugfix`. A fished defect has no reporter to reproduce it with and no environment anybody is
watching it in, so the regression test committed beside the fix is the whole deliverable. Selection
is unchanged and was already there at two tiers: the board's `bugFishingFixPipelineId` overrides the
platform default for every spawn, and a single marking overrides both through the request's
`pipelineId`. A workspace that had set the board field is unaffected.

Existing workspaces pick the preset up the way every catalog addition arrives: the new-pipeline
advisory offers it, a reseed inserts it, and a run that pins it by id adopts it.
