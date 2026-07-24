---
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Lint tightening: ratchet oxlint `max-lines-per-function` (product ceiling) from 632 to 400.

Split every product function above 400 lines along cohesive, behaviour-neutral seams, clearing
the entire >400 band. The offenders were the DI composition-root builders and other assembly
god-functions: the Worker `buildContainer`, `buildNodeContainer`, orchestration `createCore`,
local `buildLocalContainer`, the Worker `scheduled` cron handler, the server public-API
`registerTaskRoutes`, and the `pipelines` / `environmentWizard` Pinia store setups. Each was
carved into a cohesive collaborator (a sibling `container-*`/`stores/*` factory or an in-file
registrar), following the existing extraction precedents; the two tight-budget composition roots
(Worker + orchestration `container.ts`) used sibling-file moves so their `check-file-size`
allowances ratchet down rather than up. The test-glob override (2453) is unchanged.
