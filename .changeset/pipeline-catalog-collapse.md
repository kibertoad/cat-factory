---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/app': minor
---

Replace the seven near-identical build presets with a three-rung build ladder, and generalise
estimate gating past companions so one pipeline can cover the range that used to need several.

The ladder varies the one axis anyone actually chose a build pipeline on — how much design a task
gets. **Standard build** (`pl_build`, the new default) is design → challenge the design → implement
→ review → verify → guards → merge, every step unconditional. **Simple build** (`pl_simple`) drops
the design phase for trivial work. **Adaptive build** (`pl_full`) runs a `task-estimator` first and
switches its own `architect` / `tester-api` / `human-review` steps on from the estimate.

Estimate gating is now a declared per-kind capability (`isGatableKind`) rather than a
companion-only special case: any step whose output later steps read as context may be gated, while
one some other mechanism reads structurally (`merger`, `deployer`, `conflicts`/`ci`, `bug-intake`)
may not. A skipped producer cascades onto its review companion, and a step may no longer carry both
a human approval gate and an estimate gate — the estimate may add a human checkpoint, never cancel
one.

Pickers are scoped to the task's use-case: a `feature`/`bug` task is offered only build + research
pipelines, and a new block-level rule keeps the planning presets on initiative blocks (they were
previously offered on every task and then refused at start).

**Breaking:** six built-in pipelines are retired — `pl_quick`, `pl_dep_update`, `pl_pr_review`,
`pl_human_review`, `pl_fullstack` and `pl_integrate`. Each is tombstoned with a replacement, so an
already-seeded workspace gets the "retired — remove it" advisory naming where to go instead; a task
pinned to one will need repointing. `pl_simple` is redefined (`mocker` dropped) and `pl_full`
reshaped, both version-bumped, so existing workspaces are offered a reseed. `pl_integrate` is
removed rather than replaced because it carried no merge tail at all, which meant its coder-class
`integrator` committed straight to the base branch with no conflicts check and no CI.

The `dep-update` recurring-schedule template is no longer inferred from a pipeline id (its pipeline
was the ordinary build tail under a recurring name); the template value remains for explicit API
callers.
