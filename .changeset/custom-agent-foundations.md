---
"@cat-factory/agents": minor
"@cat-factory/contracts": minor
"@cat-factory/kernel": minor
---

Add the foundations for manifest-driven custom agents (pre/agent/post-op model).

- `@cat-factory/agents`: new `repo-ops/render.ts` — the deterministic, container-free
  rendering + lenient coercion of the in-repo `blueprints/`/`spec/` artifacts
  (`renderBlueprintFiles`/`renderSpecFiles`/`renderSpecFeatureFiles`,
  `coerceBlueprintService`/`coerceSpecDoc`/`dedupeSpecIds`, the version manifests). This
  is the logic lifted out of the executor-harness image; the hash uses Web Crypto so it
  is runtime-neutral (so the hash + version helpers are async). The agent-kind registry
  (`AgentKindDefinition`) gains `agent` (execution surface), `preOps`/`postOps` (backend
  repo-op hooks) and `presentation` (frontend palette metadata), with matching accessors;
  `registeredKindRequiresContainer` now also derives from a container agent surface.
- `@cat-factory/kernel`: new `RepoFiles`/`ResolveRepoFiles` ports (a per-run,
  checkout-free facade over the `GitHubClient` Git Data API) and the agent-definition
  vocabulary (`AgentSurface`/`AgentStepSpec`/`AgentCloneSpec`/`AgentOutputSpec`,
  `RepoOp`/`RepoOpContext`).
- `@cat-factory/contracts`: new `AgentPresentation`/`AgentCategory`/`CustomAgentKind`
  wire shapes for the data-driven agent palette.
