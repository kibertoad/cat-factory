---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
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
- **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
  gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
  `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
  scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
  `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
  re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
  carrying a `bug-intake` step must be `'recurring'` (validated at builder save + start).
- **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
  run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
  filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
  predicate.
