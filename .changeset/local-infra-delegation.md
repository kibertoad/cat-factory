---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Local-mode infrastructure delegation + native runner-adapter seam.

Local mode now lets a workspace opt, independently, into delegating its container agents
and/or its Tester ephemeral environments to an external service instead of running
everything on the host container runtime. Two new per-workspace settings drive it
(`delegateAgentsToRunnerPool`, `delegateTestEnvToProvider`, both default off), surfaced as
toggles on the Ephemeral environments screen (local mode only) and enabled only once the
respective provider — a self-hosted runner pool / an environment provider — is registered.

- **Agents**: when delegated, container jobs dispatch to the workspace's registered runner
  pool instead of host Docker (a clean 409 at start, and the existing dispatch error, when
  delegated with no pool registered).
- **Environments**: the toggle sets the local-mode default Tester environment — `local`
  (host Docker / DinD) by default, `ephemeral` (the provider) when on; per-service / per-task
  choices still win. An `ephemeral` run is refused at start when delegated with no provider
  connected.
- **Native runner-adapter seam**: an injected `runnerPoolProvider` now drives the actual
  dispatch transport on both the Cloudflare and Node facades (falling back to the generic
  `HttpRunnerPoolProvider`), fully symmetric with `environmentProvider`. A wrapper can thus
  ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. Kargo) to
  serve both concerns with native code on every runtime.

BREAKING (pre-1.0, internal): an un-pinned Tester task in local mode now defaults to the
`local` (DinD) environment instead of `ephemeral`. New `workspace_settings` columns are
added on both runtimes (D1 migration + Drizzle migration); local mode now defaults
`ENVIRONMENTS_ENABLED=true` so the env module assembles for the opt-in.
