---
'@cat-factory/app': patch
---

UX quality-of-life pass (part 1): add a reusable confirmation dialog + `useConfirm()`
and gate every destructive action behind it (delete task/module/service, recurring
pipeline, custom pipeline, merge/model preset, and dependency edge), routed through a
shared `useBlockDeletion` so the inspector button and future keyboard shortcut can't
drift. Add a reusable `EmptyState` component and apply it to the context pickers, the
dependency list, and the (previously blank) execution history.
