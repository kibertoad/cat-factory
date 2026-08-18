---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/app': patch
---

Publish the Kaizen entries as a public surface (`/api/v1/kaizen/entries`, spec 1.58.0): the
platform's post-run gradings of its own agent steps, as a backlog a consumer drains rather than a
screen a person browses.

The gradings already existed and were already rendered, so this is a shape change. What did not
exist was a way to read them without naming a run or a task first, which is exactly what a caller
asking "what has the platform learned about my agents" cannot supply, and a way to record that one
had been dealt with, without which every poll re-reports the same backlog. The list is
keyset-paginated and workspace-wide, filters (`acknowledged`, `settled`, `status`, `agentKind`,
`since`) compose in SQL, and an entry carries the run, step, agent kind, resolved model, prompt
version, combo streak, grade, recommendations and board task, so acting on one needs no second
lookup. `?acknowledged=false&settled=true` is the drainable backlog: `settled` reads the same
definition the acknowledge write is gated on, so every entry it returns is one that write accepts.

`KaizenGrading` gains `acknowledgedAt` / `acknowledgedBy` / `acknowledgementNote` on both runtimes
(D1 migration 0095 ⇄ a Drizzle migration). They are written ONLY by the new acknowledge route: the
grading sweep's upsert leaves them alone, so a re-graded row keeps its triage. Existing rows read as
unacknowledged, which is what they are. An acknowledgement moves the row's `updatedAt` with it, so
that field stays usable as a change watermark; a repeat acknowledgement, and a clear where nothing
was acknowledged, write nothing at all.

`KaizenVerifiedComboRepository` gains a batched `listByKeys` (both facades, `remote` for mothership
mode) so the entry join names the combo keys a page holds rather than reading the workspace's whole
combo library on every call, including single-entry point reads.
