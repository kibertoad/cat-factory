---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/app': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Internal refactor (lint complexity/size ratchet — `max-lines-per-function` step 1.5, 1000 → 632):
split the product functions above the new ceiling along cohesive seams, all behaviour-neutral. No
public API, wire shape, or runtime behaviour changes.

- `@cat-factory/kernel`: `seedPipelines` split into three module-level catalog builders it composes.
- `@cat-factory/server`: `publicApiController` / `authController` split into per-route-group registrars
  (mirroring `registerCoreControllers`'s mount groups).
- `@cat-factory/app`: the `board` Pinia store's write operations extracted into `stores/board/`
  factories (`createBoardMutations` / `createBoardRemoval`) over a shared `BoardWriteContext`.
- `@cat-factory/node-server`: `buildNodeContainer` split into `assembleNodeCoreDependencies` +
  `projectNodeServerContainer` (the `CoreDependencies` object and the `ServerContainer` projection).
- `@cat-factory/local-server`: `buildLocalContainer`'s `buildNodeContainer` options extracted into
  `buildLocalNodeOptions`.
