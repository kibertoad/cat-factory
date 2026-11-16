---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A project opens from its frame on the board, whatever its kind: the pinned definition and version,
the reader its kind contributes, the outcome history with where each body lives (inline, in content
storage, or unavailable), and whether each credential the definition declares is stored for the
board. A kind's reader is contributed to the new `projectViews` app slot through
`registerAppModule`, keyed by the kind id; a kind with none shows its newest outcome per stream.
The research kind's reader shows coverage per topic, every question with its current answer,
evidence and caveats, and run-level learnings, and "Start follow-up" adds a `research` task with a
mode, ad-hoc questions and the questions to revisit, and starts it.

New app routes: `GET /workspaces/:workspaceId/projects/:projectId/view` and
`.../outcomes/:outcomeId` (member), and the outcome-storage tiers at
`GET`/`PUT /workspaces/:workspaceId/outcome-storage-policy` (`settings.manage`, the board's tier or
a project it mounts) and `/accounts/:accountId/outcome-storage-policy` (account members). An
offloaded outcome body the content storage cannot serve is reported as unavailable in the project
view instead of failing it. The research kind's view gains the text of the ad-hoc questions its
revisions answered.
