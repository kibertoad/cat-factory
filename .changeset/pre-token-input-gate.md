---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Add the pre-token input gate: a deterministic structural check of a task's own authored fields,
run before a run's first agent step is dispatched. A task that states nothing an agent could act
on now parks having spent nothing, where the cheapest refusal previously cost one requirements-
review call to report an absence a string comparison already knew about.

Six V1 findings, three of them blocking: no description, a placeholder-only description
(`TBD`/`n/a`/`fix it`), a `bug` with no reproduction context, and a `review` task naming no pull
request; a very short description and a `spike` with no success criteria ride as advisories. The
check never judges quality or infers intent, which is the reviewer's job.

**Behaviour change on upgrade.** The gate ships ON (`inputGateMode: 'standard'`), so a run
started against a title-only task parks on a notice instead of dispatching. Every blocking
finding names an input a model could not have acted on either, so the gate only replaces a call
that would have reported the same gap. A workspace can turn it down to `advisory` (record the
findings, never park) or `off` in Workspace settings. Resolve a parked run by fixing the task and
re-checking (the fix is re-evaluated, not taken on trust) or by proceeding anyway, which records
an `overridden` verdict that keeps the waived findings on the run.

Persistence: a new `input_gate_mode` column on `workspace_settings` (D1 migration `0080` and the
matching Drizzle migration); the verdict itself rides the run's existing `detail` JSON.
