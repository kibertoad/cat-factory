---
'@cat-factory/app': minor
---

Monorepo import can mark one selected directory as the frontend for the rest: it is created as a `frontend` frame pinned to its subdirectory and bound to every backend service added beside it, so the frontend to service board links exist the moment the import finishes. Every frontend frame a monorepo import creates now records its subdirectory on `frontendConfig`, marked or not, so the harness builds that tree instead of the repo root.
