---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Nested tasks (epics) + a first-class task dependency graph.

**Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
that may live under different services/modules via the tasks' new `epicId` membership
link (independent of `parentId`, so deleting an epic clears membership but never deletes
the member tasks). The board draws an epic node linked to all its members, and the epic
inspector shows the full member tree grouped service → module → task. Add one via
`POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

**Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
epic" button in the issue-import modal): an epic node, a board task per child issue
(joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
"depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
children (JQL); GitHub children come from native **sub-issues** and dependency links are
parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
`GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

**Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
(409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
close a **cycle** is rejected (422).

**Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
When it merges, the engine automatically starts every task that depends on it whose other
dependencies are also done — skipping any on an individual-usage model (which can't unlock
unattended).

**Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
also draws epic→member membership links.

Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
`epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
the epic + membership round-trip, the cycle rejection, and the dependency start gate on
each store.

Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
columns and the `level` enum gains `epic`; no migration shims.
