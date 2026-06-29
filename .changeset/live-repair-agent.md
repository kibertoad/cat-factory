---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

feat(environments): durable, asynchronous environment-provider config-repair agent

When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
"bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

- The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
  migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
  (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
  re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
  pg-boss driver via `buildNodeContainer`.
- `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
  `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
  immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
  block, no PR, no force-push), distinct from the repo-bootstrap flow.
- `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
  `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
  on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
  manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
  the config PR branch, not the target branch.
- The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
  carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
  store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
  retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
  surfaced only on the infrastructure-providers surface that triggered it.
- Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
  conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
  to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
  container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
  deployment running the generic manifest provider is unchanged.

Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
`CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
`EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
in-flight synchronous repair shape is obsolete.
