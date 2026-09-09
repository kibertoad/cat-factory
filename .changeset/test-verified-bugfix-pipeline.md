---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
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

Three things about the new step are deliberate and worth knowing before editing it. Committing no
test never fails the run (the fix is already pushed by the time it runs, so a failure would throw
the work away rather than name the gap): it reports `outcome: 'uncovered'` with the reason, and an
unreadable reply degrades to the same value rather than to a claim it never made. The gaps it
states are rendered even under a `covered` verdict, because the reported behaviour being covered
says nothing about the neighbouring case that is not. And its verdict is a claim about FILES, which
tolerating a no-op makes uncheckable by anything else, so the platform records on the step whether
the run committed anything and withdraws a `covered` claim an empty push contradicts, naming the
claim rather than quietly showing it.

`mocker` gains the same no-op tolerance, which is a fix to every preset that carries it rather than
a concession to this one. Its own prompt tells it to add stubs only for calls not yet mocked, so an
empty diff is the ordinary outcome on a repository whose upstreams are already stubbed, and the
harness cannot tell that apart from an agent that did nothing. Failing there was also late: every
preset runs the mocker after the coder has opened the pull request. That prompt now sizes the work
to the change in flight too, instead of treating the block's whole external surface as mandatory.

**Behaviour change: a marked BUG-FISHING finding now spawns onto this preset by default** instead of
`pl_bugfix`. A fished defect has no reporter to reproduce it with and no environment anybody is
watching it in, so the regression test committed beside the fix is the whole deliverable. Selection
is unchanged and was already there at two tiers: the board's `bugFishingFixPipelineId` overrides the
platform default for every spawn, and a single marking overrides both through the request's
`pipelineId`. A workspace that had set the board field is unaffected.

Two costs come with that default, both the launch check's, and both are documented rather than
worked around: every marked finding provisions and reclaims an environment (a recorded no-op on an
`infraless` service), and a marking is refused outright when the service declares provisioning it
has not finished wiring, because a pipeline carrying an enabled `deployer` meets
`RunAdmission.assertDeployerConfigured` and the marking propagates that refusal rather than
answering 200 over a fix task that will never appear. `pl_bugfix` reached neither. A board that
wants neither pins something else in `bugFishingFixPipelineId`.

Existing workspaces pick the preset up the way every catalog addition arrives: the new-pipeline
advisory offers it, a reseed inserts it, and a run that pins it by id adopts it. The bug-fishing
spawn resolves its fix pipeline through that same adoption seam rather than a point read at the
workspace's rows, which is what lets a board older than a built-in mark a finding at all.

The run outcome summary gains one additive `/api/v1` value for the same reason (surface version
1.71.0): `tests.gap: 'verified_by_committed_tests'`, so a run that verified through committed tests
stops being reported as one where "nothing was exercised" on the one surface a person reads, while
its pull request says the opposite.
