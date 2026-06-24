---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Remove the standalone "scan repository" command — repository decomposition is now
only the `blueprints` pipeline agent.

The manual scan was a separate, UI-exposed operation backed by a synchronous
Cloudflare-Container-only `RepoScanner` (which had no live harness route) plus a
`repo_blueprints` persistence store. It duplicated what the `blueprints` agent kind
already does — decompose a repo into the canonical service → modules tree and
reconcile it onto the board — except the agent runs through the shared
`RunnerTransport`, so it already works identically on Cloudflare Containers and on a
self-hosted runner pool. Keeping the standalone command was the last
Cloudflare-vs-pool parity gap (and dead code on Cloudflare). Removing it closes the
gap by deletion.

Removed:

- **Ports:** `RepoScanner` (+ `ScanRepoRequest` / `ScannedBlueprint`) and
  `RepoBlueprintRepository` (+ `RepoBlueprintRecord`).
- **Contracts:** `scanRepoSchema` / `ScanRepoInput`, `scanRepoResultSchema` /
  `ScanRepoResult`, and `repoBlueprintSchema` / `RepoBlueprint`. The blueprint **tree**
  schemas (`BlueprintService` / `BlueprintModule` / `blueprintSource`), the in-repo
  `blueprints/` artifact constants, `parseBlueprintService`, and `BoardScanSpawnResult`
  stay — the `blueprints` pipeline uses them.
- **HTTP:** the entire `BoardScanController` — `POST /board-scan/scans` and the
  `GET|DELETE /board-scan/blueprints[/:id]` read endpoints.
- **Service:** `BoardScanService` is now purely the engine's `BlueprintReconciler`
  (`reconcileBlueprint` + its spawn fallback); `scan` / `canScan` / the blueprint
  CRUD / the persisted-blueprint deps are gone. It is wired unconditionally (it needs
  only the board service + block repository).
- **Persistence:** the `repo_blueprints` table (D1 `0001_init` + Drizzle schema, with
  a generated Postgres drop migration), `D1RepoBlueprintRepository`,
  `DrizzleRepoBlueprintRepository`, and `ContainerRepoScanner`.

No data migration is provided (pre-1.0; backwards compatibility is a non-goal): an
existing `repo_blueprints` table is simply orphaned/dropped. The executor harness is
unchanged — its self-contained blueprint coercion stays — so the runner image is not
affected.
