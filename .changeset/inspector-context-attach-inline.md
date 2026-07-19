---
'@cat-factory/app': patch
---

Fix the task inspector's context attach: the "Context documents" and "Context
issues" sections now open the same inline picker used when creating a task
(source selector, in-repo browse/search, paste-by-reference) instead of a
dropdown that opened a second, page-level "Import a page…" / "Import an issue…"
modal on top of the inspector. Those stacked page-level modals didn't interact
with the inspector, so the menu appeared to open something with nothing
clickable. Because the block already exists, a picked item is imported (when
needed) then linked immediately via the shared context-linking flow, with
failures surfaced by their real cause.
