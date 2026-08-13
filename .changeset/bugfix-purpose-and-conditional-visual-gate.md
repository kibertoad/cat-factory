---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/app': patch
---

Put the build ladder back in the pickers, and scope the bugfix preset to bug tasks.

Since the build presets adopted the conditional tester pair, each of them LISTS a `tester-ui` step
scoped to `serviceScope: 'frontend'`. The pickers' visual gate asked whether a pipeline lists a
visual step at all, so Standard / Simple / Adaptive / Complex build all read as UI pipelines and
vanished from every task picker on every non-frontend service, leaving a feature task with the
spike presets and Ralph. Run admission never agreed: it filters the chain through the run
conditions before its own frame gate, so the engine would have started any of them. The surface now
asks the same question through `pipelineRunsVisualStep`, and a pipeline whose visual step is
UNCONDITIONAL is still hidden where there is no UI.

`Pipeline.purpose` also gains a `bugfix` member, carried by `pl_bugfix` and `pl_bug_triage` (both
version-bumped, so an existing board is offered the reseed). It is `build` in everything the palette
and the save gate judge, and differs only in the task type it is offered to: "Triage & fix bug"
investigates a defect REPORT, triages it with a person and writes a failing reproduction test, none
of which a feature task can supply. A bug task keeps the whole build ladder beside it. Because every
kind that declares `purposes` predates the member, `build` satisfies `bugfix` one-way in
`purposeSuggestsAgentKind`, or a bugfix palette would open near-empty with the Bug Investigator
itself missing.
