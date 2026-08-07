---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
---

Lay a service frame's tasks out in status swimlanes instead of at hand-placed coordinates.

Three lanes a reader works in (not started / in progress / needs you) plus a collapsed Done lane,
each derived from the task's status and its run's park, failure or spend-pause state. Every lane
orders itself by what is actionable for it, and one per-user preference overrides that ordering and
adds grouping by module, task type, initiative, epic or blocking reason.

Two internal breaks, both deliberate and both safe to let stale state break on:

- **A task's `position` is no longer read.** Existing coordinates stay in the database and are
  simply ignored; a task drag now only reparents. An initiative card loses its coordinates too:
  with the frame's free canvas gone there is nothing left for them to be relative to, so
  initiatives flow into a wrapping band above the lanes and are no longer dragged. Only a service
  frame is still positioned, on its `WorkspaceMount`.
- **Module sub-frames no longer render as boxes**, so a module block's `position` and `size` are
  ignored too. A module is still a structural parent: its tasks appear in the enclosing frame's
  lanes grouped by module name, a module group header is a drop target for reparenting into it, and
  the task inspector gained a module picker that works whatever the current grouping.

Moving a task between containers now re-stamps the module it declares, the same way it already
re-stamped the type it inherits from its frame: a task dragged out of a module no longer keeps
naming it, and one dragged into another service no longer carries a module name that service does
not own.

New persisted state: `blocks.completed_at` (both runtimes), stamped by the block repository when a
block enters `done` and cleared when it leaves, so the Done lane can age a task out of view. It is
NOT backfilled, and a task without it is exempt from the age cap rather than treated as ancient.
Two new workspace settings bound the lane: `doneLaneMaxItems` (default 20) and
`doneLaneRetentionDays` (default 14, nullable for no age cap). Both hide cards only; nothing is
deleted and the lane always states its true total plus what it withheld.
