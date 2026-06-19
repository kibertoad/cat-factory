---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Board cleanup, resizable service frames, and an explicit container start-up phase.

- **No more sample services + no "reset to sample board".** New boards start
  empty: workspace creation no longer seeds the sample architecture blocks (the
  SPA passes `seed: false`), and the toolbar's "Reset board to sample" button (and
  the `workspace.reset()` action behind it) is gone. The built-in **pipeline
  catalog is still always provisioned** — it is product config, not sample data —
  so an empty board can still run pipelines. The `seed` flag (now sample _blocks_
  only, default true) remains for demo boards and the test fixtures.

- **Resizable service frames (Miro-style).** A frame can be resized by dragging
  its right / bottom edges or the bottom-right corner. `Block` gains an optional
  `size` (`{ w, h }`); when set it is the user's dragged size, used as a floor over
  the frame's content extent so a frame grows but is never dragged smaller than its
  tasks/modules. The size is persisted (new `width`/`height` columns on `blocks` —
  D1 migration `0027`, Drizzle migration for Postgres) and updated via the existing
  `PATCH /blocks/:id` (which now accepts `size`).

- **Explicit "Spinning up container…" phase.** Container-backed steps (`coder`,
  `mocker`, `playwright`, `blueprints`, `merger`, …) now surface an explicit
  cold-boot phase instead of a blank "working" state. `PipelineStep` gains
  `startingContainer`, set the moment the job is dispatched (the dispatch blocks
  until the per-run container is up and has accepted the job, so it covers the whole
  boot window) and cleared on the first successful poll, when the container is
  provably up. The board shows "Spinning up container…" during that window — an
  accurate signal that does not rely on the absence of subtasks. Steps persist as
  JSON, so this needs no migration.
