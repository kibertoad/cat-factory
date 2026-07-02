---
'@cat-factory/app': patch
---

Fix the "Create task from issue" window: it now reuses the same tracker-issue
picker as the add-task "context issues" flow. Search-by-title works and is scoped
to the repo of the container the task is being created in (so GitHub hits stay in
that service's repo), pasting an issue URL/key now actually creates a task instead
of silently importing it, and the tracker source (GitHub / Jira / Linear) is always
shown and selectable. The shared `ContextIssuePicker` also now recognises
Jira/Linear issue keys (e.g. `PROJ-123`) as attach-by-reference input and re-runs
its search when the scoped block changes.
