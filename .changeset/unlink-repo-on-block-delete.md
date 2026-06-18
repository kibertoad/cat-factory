---
'@cat-factory/orchestration': patch
'@cat-factory/app': patch
---

Deleting a service from the board now unlinks its backing GitHub repo, so the
repo becomes addable again via "Add from existing repo" instead of dangling to a
deleted block (which left it invisible yet flagged "already on board").
`BoardService.removeBlock` clears `github_repos.block_id` for any doomed frame.
The inspector's delete control now names what it removes — "Delete task",
"Delete module" or "Delete service" — so deleting a selected task no longer reads
as removing its whole service.
