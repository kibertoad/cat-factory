---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/acceptance-kit': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Report what the platform tried about a failed environment, instead of reporting only that it failed

Both remediation loops a `deployer` step can run recorded everything on the step and nothing
reduced either into the verification report. So a run whose environment failed, was diagnosed as a
provider fault, was restarted in place and then came up served byte-for-byte what a run with no
remediation loop wired at all serves. Nothing outside the backend could establish that the loop
had run: a headless suite reading the report, the one provider-neutral surface it has, had no
observable to assert on, which made the feature unfalsifiable from outside the deployment.

`environments.entries[].remediation` now carries the DECISIONS, per frame. `deployFix` counts the
`deploy-fixer`'s repair rounds against the cause it was dispatched for and splits the rounds whose
job FINISHED from the ones that died having changed nothing in the checkout, because a bare round
count reads as the first. `investigation` carries the layer the last verdict blamed, the action it
asked for, every action the engine actually RAN, why a requested action was withheld, the
investigation's own failure when a round produced no verdict, and how many readiness-ceiling
extensions a `wait` verdict won: a granted `wait` is the one remedy that otherwise leaves no trace
anywhere, since the bring-up simply runs past the configured ceiling and the timeline beside it
cannot be reconciled without it. The investigator's summary paragraph and cited evidence stay on
the run's own record.

Three absences stay distinct: no `remediation` means neither loop ran, a null `faultLayer` means no
round produced a verdict (never the `unknown` LAYER, which is a verdict reached on evidence that did
not settle the question), and an empty `ranActions` means nothing ran, with `withheld` saying why.
There is no field for whether the remedy WORKED, on purpose: that is the deployer's next verdict,
which `entries[].status` already states. `@cat-factory/acceptance-kit` gains
`checkEnvironmentRemediation`, the reduction that asserts the loop ran and settled on a fault layer.

Fixes a defect the new section would otherwise have under-reported, and one bug beside it. A
loop-back to a `deployer` step (the `human-test` gate rebuilding the environment a person is
testing) dropped the whole of `step.deployFix`, so a frame whose deployment files the fixer had
machine-edited reported as one nothing was ever attempted on; and `step.environmentInvestigation`
had no reset at all, so the looped-back step carried a SPENT budget into its next failure, refused
the first round of the new cycle as "the budget is spent", and explained the terminal failure with
the verdict about the environment the re-provision had already superseded. The counters of both are
now re-armed per provisioning CYCLE and the attempt logs survive the RUN, which is what the report
reduces.

Internal break: an attempt log's `attempt` is now its ordinal in that run-long log rather than a
copy of the live cycle counter. The two are identical on any run that never loops back to its
deployer, and only a stored step carries the field.

Additive on `/api/v1` (spec `info.version` 1.66.0): a new optional field on an existing response
object, and the clients ignore unknown fields.
