---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Pipeline builder: clone pipelines, edit custom ones, and disable steps without
removing them.

- **Clone any pipeline** (built-in or custom) into a new, editable copy:
  `POST /workspaces/:ws/pipelines/:id/clone` (`PipelineService.clone`). The copy is
  never `builtin`, so this is how a read-only default template is "made editable".
  The builder shows a Clone action on every saved pipeline.
- **Edit a custom pipeline in place**: `PATCH /workspaces/:ws/pipelines/:id`
  (`PipelineService.update`, new `PipelineRepository.update` on both stores). The
  builder loads a custom pipeline into the draft and saves changes back to the same id
  (preserving its catalog position). Built-in catalog pipelines are **read-only** —
  the API rejects both editing and deleting them (422) and the UI offers Clone
  instead (no edit/delete affordance on a built-in); pipelines now carry a `builtin`
  flag (true for the `seedPipelines()` catalog) to drive this.
- **Disable a step without removing it**: a new per-step `enabled[]` array (parallel
  to `agentKinds`, like `gates`/`thresholds`). A step flagged `enabled[i] === false`
  is kept in the saved pipeline (and can be toggled back on) but skipped at run start —
  `ExecutionService` builds the run only from the enabled steps, reading gates/
  thresholds by each kind's original index so they stay aligned. A pipeline must keep
  at least one step enabled, and an enabled companion must still have an enabled
  producer to grade (disabling a producer while leaving its companion on is rejected).
  The builder adds an enable/disable toggle and dims disabled steps.

Persistence: new `enabled` + `builtin` columns on the `pipelines` table, mirrored on
both runtimes — folded into the squashed baselines (D1 `0001_init.sql` ⇄ the Drizzle
schema + a regenerated migration) rather than a standalone migration. Cross-runtime
conformance asserts a disabled step is skipped at run on every facade.
