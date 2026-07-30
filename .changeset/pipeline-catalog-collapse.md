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

The gatable-kind vocabulary is exported from `@cat-factory/contracts` (`BUILTIN_GATABLE_KINDS` /
`isBuiltinGatableKind`) because two surfaces in different packages must answer identically: the
engine's shape validation and the SPA's pipeline-health advisory, which re-derives the same verdict
client-side. `isGatableKind` in `@cat-factory/agents` remains the registry-aware form a deployment's
own kind overrides through.

Pickers are scoped to the task's use-case: a `feature`/`bug` task no longer offers the
document-authoring, PR-review or planning presets, and a new block-level rule keeps the planning
presets on initiative blocks (they were previously offered on every task and then refused at start).
An UNCLASSIFIED pipeline — one with no `purpose`, which the builder leaves unset by default — stays
visible on a `feature`/`bug` task, so a workspace's own hand-built pipelines are unaffected.

**Breaking:** six built-in pipelines are retired — `pl_quick`, `pl_dep_update`, `pl_pr_review`,
`pl_human_review`, `pl_fullstack` and `pl_integrate`. Each is tombstoned with a replacement, so an
already-seeded workspace gets the "retired — remove it" advisory naming where to go instead; a task
pinned to one will need repointing. `pl_simple` is redefined (`mocker` dropped) and `pl_full`
reshaped, both version-bumped, so existing workspaces are offered a reseed. `pl_integrate` is
removed rather than replaced because it carried no merge tail at all, which meant its coder-class
`integrator` committed straight to the base branch with no conflicts check and no CI.

Two further consequences worth knowing before upgrading. A retired pipeline that a recurring
SCHEDULE still points at cannot be deleted (that refusal is unchanged and deliberate), so acting on
its advisory means repointing the schedule first. And because a step may no longer carry both a human
approval gate and an estimate gate, a workspace pipeline that already carries both — only reachable
by having added estimate gating to a human-gated companion, as a `pl_fullstack` clone allowed — is
now refused at save and at run start until one of the two is dropped.

Retiring `pl_fullstack` also removes the last built-in preset carrying `playwright`, `researcher`,
`documenter`, `spec-companion`, `human-test` and the two brainstorm dialogues. All remain available
as steps in the pipeline builder; none is now in a shipped preset, so a task's agent-config catalog
surfaces a contributing kind's settings (e.g. `playwright.e2eTarget`) only once some pipeline in the
workspace actually uses that kind.

The `dep-update` recurring-schedule template is no longer inferred from a pipeline id (its pipeline
was the ordinary build tail under a recurring name); the template value remains for explicit API
callers.
