---
'@cat-factory/app': patch
---

Fix the "Create task from issue" window: it now reuses the same tracker-issue
picker as the add-task "context issues" flow. Search-by-title works (the search
is no longer wrongly scoped to an arbitrary board container, which made GitHub
searches fail), pasting an issue URL/key now actually creates a task instead of
silently importing it, and the tracker source (GitHub / Jira / Linear) is always
shown and selectable. The shared `ContextIssuePicker` also now recognises
Jira/Linear issue keys (e.g. `PROJ-123`) as attach-by-reference input.
