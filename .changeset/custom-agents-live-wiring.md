---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Custom agents: live pre/post-op execution + data-driven palette + generic result view.

Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
`postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
(`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
`GitHubClient` + the executor's `resolveRepoTarget` via the new
`makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
`buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
orchestration engine drives the hooks without importing the server HTTP layer. New kernel
ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
container flag), which the SPA merges into its palette catalog
(`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
block + result view instead of the generic fallback. A `container-explore` structured
kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
rendered read-only by a new shared `generic-structured` result view — a custom agent gets
a usable result window with no bespoke UI.

The built-in agents are not yet migrated to this model (their rendering still lives in the
executor-harness); that strangler conversion is sequenced as follow-up work. See
`backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.
