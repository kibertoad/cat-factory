---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

feat(engine): batch the notification-escalation settings read (audit item 8)

The periodic notification-escalation sweep loaded every workspace's settings with a `get`
point-read inside the per-workspace loop — an N+1 that runs every couple of minutes on both
facades, and one the perf-item-9 settings cache can't fix (that slice is pass-through on the
Worker's own-mutable-D1-state profile). Adds a batched `listByWorkspaceIds` (chunked `IN`) to
the `WorkspaceSettingsRepository` port, mirrored in both the D1 and Drizzle repos, plus
`WorkspaceSettingsService.getMany` (defaults-filled) which `escalateStaleNotifications` now
calls ONCE before the loop. A `defineWorkspaceSettingsSuite` cross-runtime parity assertion
(seed → get → batched read, absent workspace absent, empty input → empty map) runs against
both facades' real stores; the batch read stays mothership-internal (a global sweeper read).
