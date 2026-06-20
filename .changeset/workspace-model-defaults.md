---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add per-workspace, per-agent-kind default model selection. A workspace can choose
which model each agent kind defaults to (e.g. point `architect` at a strong model
and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`), the
selection surfaced on the workspace snapshot as `modelDefaults`, and the Worker's
container agent executor now resolves a step's model as block-pinned > workspace
per-kind default > env routing > env default. Persisted in
`workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
migration).
