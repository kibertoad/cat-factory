---
'@cat-factory/executor-harness': patch
'@cat-factory/server': patch
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/local-server': patch
---

Finish the Task-5 strangler: migrate the last two built-in agents (conflict-resolver and
repo bootstrap) onto the single, manifest-driven `agent` harness kind, then delete every
bespoke per-kind handler and collapse the dispatch surface. The harness is now a generic
LLM-over-a-checkout runner with **one** kind — WHAT each agent does is decided entirely by
the backend and carried as job data.

**conflict-resolver** now dispatches `kind: 'agent'` `mode: 'coding'` with a `mergeBase`
(full clone of the PR branch). `handleAgent`'s coding flow merges `origin/<mergeBase>` in to
surface the conflicts, leads the prompt with the actual conflict hunks it discovers, then
completes the merge commit and pushes back onto the same branch (no new PR) — refusing to
push a half-resolved tree. Routed through `buildMigratedBuiltInBody`; the bespoke
`/resolve-conflicts` body + handler are gone.

**bootstrap** now dispatches `kind: 'agent'` `mode: 'coding'` with a `bootstrap` spec
(`{ target, reference?, reinit, forcePush, fromScratch? }`). `handleAgent` clones the
reference architecture (or scaffolds from an empty dir), runs the agent, guards against a
no-op, then force-pushes a fresh single-commit history to the separate target repo's default
branch (lifted `reinitAndPush` / `producedRepoContent`). `ContainerRepoBootstrapper` builds
the generic body; its `linkRepoToBlock` post-op already lives in `pollBootstrapJob`.

**Harness cleanup (image bump).** Deleted the bespoke handlers (`blueprint`/`spec`/`explore`/
`merger`/`on-call`/`tester`/`ci-fixer`/`fixer`/`conflict-resolver`/`bootstrap`/`handleRun`),
collapsed `server.ts`'s `KINDS` to `{ agent }`, and stripped the bespoke job types + parsers
from `job.ts` (keeping `parseAgentJob` + the shared helpers + `BootstrapTargetSpec`). The
executor-harness image is bumped (1.13.0 → 1.14.0; deploy tag + `wrangler.toml`).

**Kernel (breaking, pre-1.0).** `RunnerDispatchKind` collapses to the single member
`'agent'`, and `RunnerJobResult` is slimmed to `prUrl` / `branch` / `summary` / `error` /
`defaultBranch` / `pushed` / `custom` / `usage` (the per-kind `service`/`spec`/`assessment`/
`onCallAssessment`/`report`/`resolved` channels are removed — every structured agent returns
its doc on `custom`, coerced kind-aware in `toRunResult`). The transports default to
`kind: 'agent'`; the runner-pool result coercion passes only `custom` through.

Two fixes ride along. (1) `toRunResult` now surfaces an opened PR (`prUrl`) **before** the
in-place-fixer `pushed` branch — the migrated coder returns BOTH `pushed: true` and `prUrl`,
so the previous ordering silently dropped its structured `pullRequest` (the worker test only
passed because its fake omitted `pushed`). (2) The local transport ran the per-run container
privileged off `kind === 'test'`, which never matched after the tester migration; the
container is per-RUN (created by the run's first step, not the tester), so it now runs
privileged whenever `privilegedTestJobs` is enabled (gated by the `localDind` capability).
