---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
long-lived compose stack a per-PR consumer environment attaches to over an external network
(the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
`SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
(+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
runtime symmetry; persistence stays fully symmetric.
