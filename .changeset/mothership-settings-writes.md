---
'@cat-factory/server': patch
---

Mothership mode: allow-list the workspace-scoped settings / preset / recurring-schedule
management WRITE methods, so the settings panels are functional (not read-only) in a
no-Postgres mothership-mode local node.

Previously only the board-load READS of these repositories were remotely callable over
`/internal/persistence`, so a mothership-mode SPA could display settings but not save them
(every write came back `unknown_method`). Newly allow-listed — each takes the workspaceId as
arg0, reusing the existing `workspace` scope rule, and each is member-level (none is
admin-gated), matching the block/pipeline mutation policy already exposed:

- `workspaceSettingsRepository.upsert`, `trackerSettingsRepository.put`,
  `serviceFragmentDefaultsRepository.set` — the workspace settings panels' saves.
- `mergePresetRepository` / `modelPresetRepository` `get` + `remove` — completing both
  preset libraries' CRUD (`list`/`getDefault`/`upsert` were already exposed).
- `pipelineScheduleRepository` `get`/`upsert`/`remove`/`insertRun`/`updateRun`/`listRuns` —
  the recurring-pipeline management surface (`RecurringPipelineService` CRUD + `runNow`,
  which fires in-process). The sweeper-only `listDue`/`pruneRunsBefore` and the serviceId-keyed
  `listByService` stay mothership-internal.

Server-only allow-list change, symmetric by construction (the dispatcher reflects over each
facade's registry). Round-trip + cross-account-scope tests cover every new method; the static
allow-list drift guard moves them out of `pending`.
