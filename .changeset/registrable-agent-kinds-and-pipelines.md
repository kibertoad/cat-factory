---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Let deployments mix in custom agent kinds and predefined pipelines programmatically —
the same installation-level extension pattern as opt-in model providers
(`registerModelRegistry` / `@cat-factory/provider-bedrock`).

`@cat-factory/agents` now exposes an agent-kind registry (`registerAgentKind` /
`registerAgentKinds`, `AgentKindDefinition`): a registered kind contributes its system
prompt (string or `(kind) => string`), an optional custom user prompt, and an optional
`requiresContainer` flag. `systemPromptFor` / `userPromptFor` consult the registry for
custom kinds — after the built-in tracks (so a registered kind never shadows a
standard-phase, acceptance, mock or business-logic kind) and before the generic
fallback. The Worker's `CompositeAgentExecutor` routes a registered
`requiresContainer: true` kind to the container executor (inline kinds need no harness
changes and work end-to-end).

`@cat-factory/kernel` now exposes a pipeline registry (`registerPipeline` /
`registerPipelines`): registered pipelines are merged into `seedPipelines()` by id
(appended, or replacing a built-in in place), so every new workspace is seeded with the
deployment's pipelines alongside the built-in catalog.

Both runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`) re-export
`registerAgentKind` / `registerPipeline` (and the test-only `clear*` helpers) next to the
existing model-provider seam, so a proprietary org package registers everything from one
place at deployment-assembly startup. The agent-kind id was already an open string
throughout (pipelines, steps, model defaults), so no schema change is required.
