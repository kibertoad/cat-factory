---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Frontend for in-org shared services.

The board can now mount org services, shows which frames are shared, and lays them out
per-board.

- The workspace snapshot carries `mounts` (the services this board mounts, with the
  per-board frame layout) and `serviceCatalog` (the org's services it can mount from, each
  annotated with `mountCount`). `Service` gains a derived `mountCount`.
- SPA: a `services` Pinia store (mounts + catalog + mount/unmount/updateLayout), hydrated from
  the snapshot; an **"Add service"** menu on the board toolbar that mounts an org service; a
  **"Shared"** badge on a frame mounted on more than one board; and a frame drag now writes
  the **per-board mount layout** (so moving a shared frame doesn't move it on other boards).
