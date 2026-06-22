---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': patch
---

Self-hosted runner pools: serve every harness kind and forward structured results.

Two fixes to the runtime-neutral runner-pool transport (used by both the Cloudflare
and Node facades for a workspace's self-hosted pool):

- **Forward the whole structured result.** `HttpRunnerPoolProvider.mapJobView`
  previously copied only `prUrl` / `branch` / `summary` / `error` off a finished job,
  silently dropping every structured product — so a pool-backed `tester` produced no
  `testReport`, a `merger` no assessment, a `blueprints`/`spec-writer` no tree/doc. The
  response mapping gains an optional `resultPath` pointing at the harness `result`
  envelope; when set, the provider coerces and forwards `report` / `service` / `spec` /
  `assessment` / `defaultBranch` / `pushed` / `resolved` / `usage` (type-guarded, with
  the structured products passed through for the engine to validate). The individual
  scalar paths still apply and override.
- **Serve every harness route, with no allow-list.** A pool runs the same
  executor-harness image as the Cloudflare backend, and runtime parity is the default
  (the "keep the runtimes symmetric" guideline), so `RunnerPoolTransport` dispatches
  every kind with no opt-in `POOL_SUPPORTED_KINDS` guard to gate them. A new harness kind
  reaches a pool automatically, exactly as it does a Cloudflare container, instead of
  silently diverging until it is added to a list.
