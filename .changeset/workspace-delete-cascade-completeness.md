---
'@cat-factory/kernel': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Complete the workspace-delete cascade so a board delete no longer orphans rows forever.
Both facades' `WorkspaceRepository.delete` previously cleared only ~7 tables
(blocks/pipelines/agent_runs/environments/services/mounts), leaving every other
workspace-scoped table (`notifications`, `requirement_reviews`, the review / session /
settings / connection / preset tables, the GitHub projection, …) permanently orphaned on
a normal board delete — invisible today, unbounded cost tomorrow.

The cascade is now driven by a single shared kernel list, `WORKSPACE_SCOPED_TABLES`, that
both the D1 (Cloudflare) and Drizzle (Node/local) facades iterate, so the two runtimes
cannot drift and a newly-added workspace-scoped table can't silently miss the cascade.
Per-facade static completeness guards make a new table impossible to forget: the Node guard
introspects the Drizzle/Postgres schema and the Worker guard introspects the real migrated
D1, each failing if any `workspace_id` table is neither listed nor explicitly acknowledged
as a special case (the D1 guard also covers the Cloudflare-only `live_containers` table the
Drizzle schema can't see). A cross-runtime conformance assertion proves a deleted board
leaves no rows behind on both D1 and Postgres.

Deliberately out of scope (unchanged): `binary_artifacts` (its blob bytes must be reclaimed
through the `BinaryBlobBackend` port at the service layer — a follow-up slice), the
bespoke `services` / mount re-home handling, and the isolated `telemetry` / `sandbox` /
`provisioning` schemas (separate stores reclaimed by their own retention sweeps; telemetry
is a physically separate D1 database on the Worker). (system-audit-improvements initiative,
item 2.)
