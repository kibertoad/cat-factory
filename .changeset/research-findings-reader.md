---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A research project's findings reader on the board. The project frame opens it: the pinned
definition and version, coverage per topic, every question with its current answer, evidence and
caveats, run-level learnings, the revision history with where each body lives (inline, in content
storage, or unavailable), and whether each credential the definition declares is stored for the
board. "Start follow-up" adds a `research` task in the project with a mode, ad-hoc questions and
the questions to revisit, and starts it.

New app routes: `GET /workspaces/:workspaceId/projects/:projectId/research` and
`.../research/revisions/:revisionId` (member), and the findings-storage tiers at
`GET`/`PUT /workspaces/:workspaceId/findings-storage-policy` (`settings.manage`, the board's tier or
a project it mounts) and `/accounts/:accountId/findings-storage-policy` (account members). An
offloaded revision body the content storage cannot serve is reported as unavailable in the
project view instead of failing it.
