---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add per-workspace, per-agent-kind default model selection. A workspace can choose
which model each agent kind defaults to (e.g. point `architect` at a strong model
and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`) and the
selection surfaced on the workspace snapshot as `modelDefaults`. Persisted in
`workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
migration).

The defaults are applied uniformly through one shared resolver
(`resolveStepModelRef` in `@cat-factory/agents`) used by **every** executor — the
inline LLM executor, the container executor and the requirements reviewer, on both
the Worker and the Node service — so a step's model resolves as block-pinned >
workspace per-kind default > env routing for the kind > env default for every agent
kind, not just the container kinds. A stale/unresolvable block pin now falls
through to the workspace default instead of skipping it. Request keys (agent kinds)
and values (model ids) are validated as trimmed, non-empty strings.
