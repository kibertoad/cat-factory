---
'@cat-factory/app': minor
---

Fix attaching a context document during manual task creation.

The "Add a task" form attaches context documents through a new inline search picker
(`ContextDocumentPicker`) instead of opening a second modal on top of the form.
Stacked page-level modals don't interact here, which is why the old "Import a page…"
entry appeared to open something but nothing was clickable — the same latent bug that
was fixed for context issues. The picker searches the connected source, lists
already-imported documents, and accepts a pasted URL/ID, staging the choice so it
imports + links once the task is created. This brings the Context documents section to
parity with the Context issues picker.
