---
"@cat-factory/kernel": minor
"@cat-factory/integrations": minor
"@cat-factory/workspaces": minor
"@cat-factory/orchestration": minor
"@cat-factory/node-server": minor
"@cat-factory/local-server": minor
---

Let a deployment declare environment-handler seeds so infra handlers are registered programmatically instead of via the SPA.

A deployment can now pass `seedEnvironmentHandlers` (a list of `RegisterHandlerInput`) to `start()` / `startLocal()`. The server idempotently ensures each seed's `environment_connections` handler exists for **every existing workspace at boot** (a best-effort, fire-and-forget backfill over `workspaceService.list(null)`) and for **each newly-created workspace** (`WorkspaceService.create`), so a service's declared provision type resolves a handler with no manual Infrastructure → Test environments step. Seeding is idempotent (a handler already present for a `(provisionType, manifestId)` is skipped) and per-seed fault-tolerant (a bad seed is logged and skipped, never crashing boot or workspace creation).

New: the `EnvironmentHandlerSeeder` kernel port, the deployment-neutral `createEnvironmentHandlerSeeder` (`@cat-factory/integrations`), a late-bound `getEnvironmentHandlerSeeder` dependency on `WorkspaceService`, an `environmentHandlerSeeder` handle on the container, and the exported `backfillEnvironmentHandlerSeeds` runtime helper.
