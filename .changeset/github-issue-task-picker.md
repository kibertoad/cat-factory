---
'@cat-factory/app': minor
---

Make creating a task from a tracker issue (GitHub Issues / Jira) discoverable, and
fix attaching a context issue during manual task creation.

- The import modal now searches the tracker by title (using the existing search
  endpoint), so you can find an issue and "Create task" from it directly — the new
  task is seeded from the issue's title/description and linked back for writeback,
  without having to know the issue key.
- The "Add a task" form attaches context issues through a new inline search picker
  (`ContextIssuePicker`) instead of opening a second modal on top of the form.
  Stacked page-level modals didn't interact, which is why the old "Import an issue…"
  path appeared to open something but nothing was clickable. The picker searches,
  lists already-imported issues, and accepts a pasted URL/key, staging the choice so
  it links once the task is created.
