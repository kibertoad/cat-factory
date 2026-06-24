---
"@cat-factory/executor-harness": minor
"@cat-factory/kernel": minor
"@cat-factory/server": minor
---

Add the generic, manifest-driven `agent` harness kind + its backend dispatch.

- `@cat-factory/executor-harness`: a single generic `agent` job kind (`parseAgentJob` +
  `handleAgent`) that runs an LLM over an optional checkout in one of two modes —
  `explore` (read-only; returns prose, or a parsed `custom` JSON object) or `coding`
  (clone/edit/commit/push, optionally open a PR), built on the existing
  `runAgentInWorkspace`/`runCodingAgent`/`resolveStructuredOutput` primitives. It holds no
  per-agent-kind logic; the bespoke kinds remain during migration. **Image bump** (the
  deploy tag moves to `1.9.0` so the new kind rolls out).
- `@cat-factory/kernel`: `RunnerDispatchKind` gains `'agent'`; `RunnerJobResult` and
  `AgentRunResult` gain a generic `custom` channel for a structured agent's output.
- `@cat-factory/server`: `ContainerAgentExecutor` dispatches any registered kind that
  declares an `agent` step through the generic `agent` kind (`buildRegisteredAgentBody`)
  and maps `custom` results; built-in kinds are unchanged. New `RepoFiles` implementation
  (`makeRepoFiles`/`makeResolveRepoFiles`, a checkout-free facade over the `GitHubClient`
  Git Data API) + a `runRepoOps` helper — the substrate the pre/post-op engine wiring will
  use next.
