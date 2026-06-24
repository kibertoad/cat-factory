---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Improve the pipeline builder experience:

- **Grouped, collapsible agent palette** — archetypes are now organized into
  meaningful categories (Review & triage, Design & research, Implementation,
  Testing, Documentation, Gates & observability) that collapse/expand, with the
  collapsed state remembered across builder opens.
- **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
  free-form labels and an archived flag for organizing the library: filter by
  label, hide archived behind a toggle, and archive without deleting. Exposed via
  a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
  a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
  columns mirror across D1 and Drizzle/Postgres.
- **Dependent companions are now gated toggles on their producer** — the three
  companions (reviewer→coder, architect-companion→architect, spec-companion→
  spec-writer) leave the free palette and are attached to their producer step in
  the builder. Each can be optionally **gated on the task estimate** (run only when
  complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
  `gating` array; a gated step is transparently skipped at runtime when the
  estimate falls below the bar. A pipeline with any enabled gating **requires a
  `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
  additionally restricted to **companion steps** (skipping a producer would starve
  its downstream steps) and **requires at least one axis threshold** (an enabled gate
  with none would always skip); both are enforced by the shared `validatePipelineShape`
  at save, clone, and run start. A companion must now run **immediately after** an
  enabled producer it can review — `validatePipelineShape` enforces strict adjacency
  (over the enabled subset) on every facade, matching the builder, which surfaces
  companions as toggles attached to their producer. A pipeline that slips another step
  between a producer and its companion is rejected at save / clone / run start.

**Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
`gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
`skipped`. The built-in pipelines are unchanged in behaviour.
