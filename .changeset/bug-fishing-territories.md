---
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/integrations': patch
---

Bug-fishing expeditions now partition a large codebase into TERRITORIES and fish each angle over
each one, instead of telling every pass to decide for itself where an angle could bite.

The partition is computed by the platform from the repository tree (blueprint modules first, then
package and directory boundaries, sized by blob bytes), the expedition stays ONE run whose phase
list is territory x angle, each pass is handed its territory's manifest as a `.cat-context/` file
so it starts from a map rather than three greps, and what each pass reported reading becomes a
per-phase coverage record. A pass budget bounds the matrix and every cell it cuts is recorded as
unfished. A codebase small enough to fish whole runs exactly as before.

Internal wire break: `GitHubClient.listTree` and `VcsClient.listTree` now return
`{ entries, truncated }` rather than a bare array, so a caller building a manifest can tell a
truncated tree from a complete one. `bug-fisher` switches to `standardsDelivery: 'context-files'`,
so its standards are read once from `.cat-context/` instead of re-sent on every turn of every
pass.
