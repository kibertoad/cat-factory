---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': patch
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add a "Test environment creation" diagnostic to the service inspector. A developer can now
run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
provision → tear down → delete branch — and see the live stage plus the final success/failure
(and the stage it failed at), with guaranteed cleanup even on error.

Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

The always-cleans-up contract is enforced on every path: the branch is persisted before
dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
deploy job, and the run's synthetic environment-registry row is always reclaimed. The
provisioning config is pinned on the run record at dispatch, terminal writes are guarded
(`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
can never show `running` forever. The SPA store reconciles snapshots and live events by
`updatedAt` so a stale refresh can't regress or drop a run's state.

Schema change (no backwards-compatible migration, per project policy): a new
`environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
Postgres/Drizzle schemas.
