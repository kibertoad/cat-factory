---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Bug-triage pipeline, Phase A — pipeline `availability` (one-off / recurring / both).

A library pipeline can now declare HOW it may be launched, so a recurring-only pipeline (the
upcoming `pl_bug_triage`) can't be started as a manual one-off, and a one-off-only pipeline can't
be attached to a schedule. Absent means `'both'` (unrestricted) — pre-1.0, no migration/back-fill,
existing rows read unchanged.

- **Contract**: `pipelineSchema` gains `availability?: 'one-off' | 'recurring' | 'both'` (+ the
  `PipelineAvailability` type, re-exported from kernel); `createPipeline`/`updatePipeline` accept
  and persist it.
- **Persistence** (both runtimes, kept symmetric): `availability` is a new `pipelines.availability`
  column — D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle schema + generated migration —
  read/written by the shared `rowToPipeline` mapper and both repos, so the field round-trips
  instead of being silently dropped on save.
- **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
  gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
  `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
  scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
  `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
  re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
  carrying an ENABLED `bug-intake` step must be `'recurring'` (validated at builder save + start;
  a disabled step imposes no requirement). The schedule-attach check delegates to the same gate
  (one rule, one `ValidationError`), and `clone` re-runs it so an un-launchable copy can't be
  minted. Editing a pipeline to `'one-off'` while a schedule still references it is rejected
  (`ConflictError`) rather than silently breaking every future fire.
- **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
  run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
  filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
  predicate.
