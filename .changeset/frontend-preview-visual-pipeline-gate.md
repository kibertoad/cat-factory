---
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/contracts': patch
---

feat(frontend): gate visual pipelines to frames with a UI (slice 4c of the frontend-preview +
in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

A pipeline with a VISUAL step — `tester-ui` (drives a real browser against a running frontend) or
`visual-confirmation` (the human gate over its screenshots) — only makes sense where there is a UI
to exercise. Until now nothing stopped `pl_frontend` / `pl_visual` from being started on a bare
backend `service` (or a `library` / `document`) frame, where `tester-ui` has no app to drive.

The engine now refuses such a start unless the task's enclosing frame is a `frontend` frame (it
owns the app under test) OR a frame a `frontend` frame links to (its `frontendConfig.backendBindings`
name it as a `service` upstream — the linked frontend is the UI a change to that service is
validated through). The SPA surfaces the SAME rule so those pipelines are hidden from the pickers
where they can't run, and both sides share one predicate so the surface can't drift from the gate.

- **Shared predicates in `@cat-factory/contracts`** (`pipelineHasVisualStep`,
  `frameAllowsVisualPipeline`, and the canonical `UI_TESTER_AGENT_KIND` /
  `VISUAL_CONFIRM_AGENT_KIND` slugs, now re-exported by orchestration's `ci.logic` so the wire
  values can't drift). The link scan reads the workspace block list once — no per-frame point read.
- **Run-start gate** (`ExecutionService.assertPipelineFrameTypeAllowed`): a new
  `visual_pipeline_no_frontend` conflict reason, refused before any side effects, alongside the
  existing tester-infra / binary-storage start guards. A non-visual pipeline passes through.
- **SPA surface**: the task-create, run-settings, run-launcher (inspector + focus view) and
  recurring-schedule pipeline pickers filter out visual pipelines for a frame with no UI, keyed off
  the block's enclosing frame and the board's frontend→service links. The new conflict reason maps
  to a localized toast title across every locale.
- **Conformance**: a cross-runtime assertion refuses a visual pipeline on a bare service frame
  (`visual_pipeline_no_frontend`) and lets the same run START once a frontend links that service —
  pinning the D1 ⇄ Drizzle parity of reading `frontend_config` during the run-start gate.
