---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Agent kinds can now declare CAPABILITIES: the skills they apply (procedural playbooks — bundled in
the deployment's own package, or referenced from the account's repo-synced catalog) and the tool
servers they may call (MCP, stdio or HTTP). Both are registered on the same app-owned
`AgentKindRegistry` and referenced by id from any number of kinds, or attached to a BUILT-IN kind
with `assignSkills` / `assignToolServers`. Tool-server credentials are declared by name and
resolved at dispatch through the new kernel `ToolSecretResolver` port (both facades wire the
deployment-environment resolver by default), so a value never reaches a prompt or the run's
telemetry snapshot. See `backend/docs/adr/0029-agent-kind-capabilities.md`.

BREAKING (pre-1.0, no migration): `AgentRunContext.skill` is now `skills` (an array),
`PipelineStep.skillVersion` is now `skillVersions`, and the harness job body's `skill` field is now
`skills` alongside the new `mcpServers`.
