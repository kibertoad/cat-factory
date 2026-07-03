---
'@cat-factory/app': patch
---

UX papercuts (undo & confirmation cluster): make destructive board actions recoverable.

- **Undo after delete (UX-01).** Deleting a block now defers the backend delete by a short
  window and shows a "Deleted X — Undo" toast that cancels it in place and restores the
  full subtree (blocks + dependency/epic/initiative edges). The pending subtree stays
  hidden across a coarse refresh or stray live event, and the deferred call targets the
  workspace the block was deleted from even after a workspace switch.
- **Delete confirmation states the cascade scope (UX-02).** A service/module delete confirm
  now names the exact number of items that will be removed with it, instead of the vague
  "and everything inside it".
- **Undo after drag-reparent (UX-03).** A drag that moves a block into a different container
  now offers a "Moved X — Undo" toast that returns it to its previous home — covering the
  easy overshoot-into-a-neighbour mistake.
- **i18n move-failure toast (UX-13).** The `moveBlock` failure toast is now translated
  instead of a hardcoded English string.
