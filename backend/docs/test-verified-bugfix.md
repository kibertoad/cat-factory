# Test-verified bug fix (`pl_bugfix_tested`)

A built-in bugfix preset that establishes the fix from the REPOSITORY: the mocks and integration
tests it commits, re-run by real CI. It still stands an ephemeral environment up, for one question
only, and reclaims it as soon as that question is answered.

```
bug-investigator → clarity-review (human gate) → spec-writer → architect → repro-test →
coder → reviewer → mocker → integration-test → deployer → disposer → conflicts → ci → merger
```

The front half is `pl_bugfix` ([the shipped catalog](../packages/kernel/src/domain/seed.ts)),
unchanged: investigate the report against the code, triage it with a human, fold the clarified
brief into the spec, design the fix, write a failing reproduction test, fix it, review it. What
this preset replaces is the VERIFICATION, and there are two halves to that replacement.

## The environment is a launch check, and nothing reads it

`deployer` then `disposer`, with no step between them. The deployer provisions the task's
pull-request branch and settles the frame on a reachability verdict
(`environment-reachability.logic.ts`), so a service that no longer starts, or starts unreachable,
fails the run here; a repo-fixable rejection still escalates to the `deploy-fixer` exactly as it
does anywhere else. A service that stands nothing up (`infraless`, or `docker-compose` with no
handler) records a clean no-op, so the preset covers every provision type like all the others.

That verdict is the ONLY thing this preset asks an environment for. Three consequences:

- **The reclaim is adjacent, not terminal.** Every other deploying preset keeps the environment
  alive to the end of the run because a later step may still read it (a tester, a human-test gate,
  a reviewer poking at the URL). Here nothing does, so holding it through the merge tail would bill
  for a URL no step is going to open. The lifecycle rule
  ([`pipeline-catalog-lifecycle.md`](./pipeline-catalog-lifecycle.md)) is satisfied by a `disposer`
  after the `deployer`, wherever the pair sits.
- **Adding an env consumer between them makes it a different pipeline.** A `tester-api` dropped in
  there reads as a tidy addition and quietly turns the launch check into the thing the run
  establishes the fix through, which is how every rung of the build ladder already verifies.
  `seed.test.ts` pins the absence, because an absence is not visible in a step list.
- **The order is load-bearing.** The deployer deploys the task's PR branch, so it has to sit after
  the coder to be checking the FIXED service at all. It also sits after the test-writing steps, and
  that is deliberate rather than incidental: at the time the tests are authored no environment
  exists for them to reach, so they cannot come to depend on one even by accident.

## The verification is committed, and CI is the enforcement

`mocker` then `integration-test`, both after the fix they cover and both before the `ci` gate.

- **`mocker`** is the platform's existing mock author: it stands the service's external
  dependencies up as WireMock stubs the repository owns, wires them into the compose file and the
  CI configuration, and commits them. Its prompt sizes the work to the change in flight rather than
  to the block's whole external surface, which matters more here than in a build preset: a one-line
  defect fix should not arrive under a WireMock estate for a dozen upstreams that have nothing to
  do with it. A repository that already answers every call the fix touches is a legitimate no-op
  (`noChangesTolerated`, and shared with every other preset carrying the step: an already-stubbed
  service is the ordinary state of a mature one, and the run's pull request is open by the time any
  mocker step runs, so failing there throws the fix away rather than reporting a gap).
- **`integration-test`** (`agents/src/agents/kinds/integration-test.ts`) is new. It drives the fix
  through the seam a caller uses, against those stubs, then commits the tests and reports
  `{ outcome, testPaths, mocks, uncovered, notes }`. A post-completion resolver folds a digest onto
  `step.output` (`integrationTest.logic.ts`), which is how the verdict reaches the merge assessment
  and the human at the merge gate.

Five rules hold that step together:

- **It is a `container-coding` kind, not a tester.** Only the tester family is handed environment
  coordinates (`runsAgainstEphemeralEnvironment`), so "write something that runs from the
  repository alone" is a fact about the dispatch rather than a request in a prompt. Its prompt says
  so as well, because an agent that is told nothing assumes a URL exists somewhere.
- **The `ci` gate is what makes the tests a check.** The step's own claim that the tests pass is a
  claim; the tests running on the pull request is the proof, which is also why the prompt asks it to
  add them to the project's CI configuration when they are not wired in.
- **Committing nothing never fails the run.** By the time this step runs, the fix is pushed. Failing
  the run over absent coverage would throw the work away instead of naming the gap, so a no-op is
  tolerated and reported as `outcome: 'uncovered'` with the reason. An unreadable reply degrades to
  the same value: a reader is told there is no coverage to rely on rather than handed a claim the
  step never made.
- **`uncovered` is rendered even under a `covered` verdict.** The two are not in tension (the
  reported behaviour can be covered while a neighbouring case is not), and a gap the agent stated is
  the one thing a reviewer cannot recover from anywhere else.
- **The verdict is READ against the commits behind it.** `outcome` is a claim about files, and
  tolerating a no-op is what makes that claim uncheckable by anything else: a run that read the
  code, concluded the behaviour was already covered and pushed nothing settles as clean as one that
  wrote a suite. So the kind's `mapStructuredResult` records `committed` on the step's own outcome,
  from the harness's push result (a peer pull request counts, since on a multi-repo fan-out the
  tests may land in a connected service's repo) and never off the reply. A `covered` or `partial`
  claim behind an empty push then renders as `uncovered` with the withdrawn claim NAMED, instead of
  putting "Covered by committed tests" in front of the merger over a diff containing none. A
  harness that reported no push outcome corrects nothing: unknown is a third fact.

### What the pull request says about it

The verification report the engine keeps on the pull request
([`pr-verification-report.md`](../../docs/initiatives/pr-verification-report.md)) has no tester
section to fill, and the note it used to render in place of one claimed that "no test run was
performed by the platform". That is a claim rather than an absence, and on this preset it is the
wrong one: a suite ran, and the tests it ran are in the diff the reviewer is reading. So the
absent note now branches, three ways. A run whose `integration-test` step reported coverage it
actually committed gets a note naming the outcome plus the counts COMPUTED from the step's own
stated lists. A run whose step committed nothing (its own `uncovered`, the value an unparseable
reply degrades to, or a claim the commits contradict) gets a note saying exactly that: opening with
"this run verified the change from the repository" over one of those would be a stronger overclaim
than the line it replaced. A run with neither step gets the plain absence, reworded to say only
what it knows. The closing clause naming CI as what runs the committed tests is conditional too, on
the pipeline carrying a `ci` gate, since nothing obliges one carrying this step to carry that gate.
The reproduction proof and the environment lifecycle sections render exactly as they do anywhere
else, which for a bugfix is the evidence that matters most: red before the fix, green after it.

The run OUTCOME summary reduces the same absence through the SAME selection
(`selectCommittedTestStep`, in contracts beside the other run-evidence rules) and answers
`gap: 'verified_by_committed_tests'` where it used to answer `no_tester_step`, whose translated copy
reads "nothing was exercised". So the two documents cannot describe one run in opposite terms, which
is the property that shared module exists for. The new gap value is additive on `/api/v1`
(surface version 1.71.0).

Requirement coverage deliberately keeps answering `no_tester_step` on the same runs. Committed
integration tests produce no per-requirement verdicts, so "no requirement was checked" is exactly
what happened there, and splitting it would state a distinction with nothing behind it.

## Who gets it

- Anyone picking it for a `bug` task: it sits beside "Triage & fix bug" in the picker, since both
  carry `purpose: 'bugfix'`.
- **Every marked BUG-FISHING finding, by default.** `BugFishingController.resolveDefaultFixPipelineId`
  answers this preset when the board has set no `bugFishingFixPipelineId`, because a fished defect
  has no reporter to reproduce it with and no environment anybody is watching it in. The board
  setting still overrides it for every spawn, and a single marking overrides both through the
  request's `pipelineId`. Design record:
  [`bug-fishing-expedition.md`](../../docs/initiatives/bug-fishing-expedition.md).

### What the default costs a bug-fishing board

Two consequences, both the launch check's, and worth knowing before a board leaves the setting
unset. `pl_bugfix` carries no deployer and reached neither, so both are new for a board that moves
onto this default:

- **Every marked finding provisions and reclaims an environment.** That is the cost of the one
  question the check answers. On an `infraless` service (or a `docker-compose` one with no handler)
  it is a recorded no-op and costs nothing.
- **A marking is REFUSED when the service declares provisioning it has not finished wiring.**
  `RunAdmission.assertDeployerConfigured` fires on any pipeline carrying an enabled `deployer`, so a
  service declaring `kubernetes` / `custom` / `docker-compose` with an incomplete config, no
  matching workspace handler, or a deployment integration failing its connection test refuses the
  run at start with `deployer_service_provisioning_incomplete`, `provision_type_unhandled` or
  `deployer_connection_test_failed`. The marking propagates that refusal rather than swallowing it
  (`BugFishingController.spawnFixTask`), which is deliberate: answering 200 over a fix task that is
  never going to appear leaves somebody waiting for it.

A board that wants neither pins `pl_bugfix` (or anything else) in `bugFishingFixPipelineId`, and a
single marking overrides both through the request's `pipelineId`.

## When to reach for the other one

`pl_bugfix` when there is no environment story worth paying for at all (it stands nothing up),
`pl_build` when the change is genuinely established by exercising a running system, and this one
when the fix should ship with the test that guards it and the environment is worth exactly one
question: does the thing still start.
