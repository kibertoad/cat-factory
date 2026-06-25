---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
---

Migrate the `blueprints` built-in agent onto the generic, manifest-driven `agent` harness
kind, and add a checkout-free file-DELETION channel the migration needs.

`ContainerAgentExecutor` now routes `blueprints` through `buildMigratedBuiltInBody` →
`buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent (cloning the PR
branch when one is open, else the default branch — exactly its old `prBranch ?? baseBranch`
clone) instead of the bespoke `/blueprint` body. The agent now returns ONLY the service →
modules tree as JSON; `toRunResult` coerces that `custom` result into the `blueprintService`
channel (via `coerceBlueprintService`) the engine already reconciles onto the board.

The deterministic render + commit of the in-repo `blueprints/` artifact that used to live in
the executor-harness `/blueprint` handler now runs as a BACKEND built-in post-op
(`blueprintPostOp`, `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is
keyed by the engine's own built-in op map in `ExecutionService` — deliberately NOT the
agent-kind registry, so the built-ins never leak into `customAgentKinds` / the SPA palette.
The post-op is idempotent (the `version.json` content hash short-circuits an unchanged tree,
so a durable-driver replay re-commits nothing) and prunes a removed module's stale deep-dive
file — the checkout-free analogue of the harness wiping `blueprints/` before writing.

To support that prune, `commitFilesSchema` / `CommitFilesInput` (and the `RepoFiles` /
`GitHubClient` `commitFiles` impl in `FetchGitHubClient`) gain an optional `deletions:
string[]`: paths removed in the same commit, built into the Git Data tree as `sha: null`
entries against the base tree. Additive and non-breaking (absent ⇒ a pure add/update commit).

The already-shipped executor-harness image serves this via its generic `handleAgent`
explore-structured handler, so **no image bump is required**. One intentional, low-risk delta:
the blueprint explore body now carries the shared web-tools fields like every other explore
agent (gated by `webSearchProxyEnabled`), and the agent reads any existing blueprint from its
own checkout rather than the harness pre-injecting the baseline tree into the prompt.

The now-dead `/blueprint` harness handler is removed in a later step of the sweep (which
bumps the executor image), once parity is confirmed on CI. The cross-runtime conformance
suite gains an assertion that a `blueprints` step's post-op renders + commits the
`blueprints/` artifact via `RepoFiles`, identically on both runtimes.
