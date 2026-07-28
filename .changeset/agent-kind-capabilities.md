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

OPERATORS — self-hosted runner pools must be moved to the `1.67.0` harness image. A pool still
running an older image parses the job body with the old singular `skill` field, so the new
`skills` array is dropped on the floor. On Pi/codex that degrades quietly (their prompt still
carries the folded-in instructions), but a leased-credential claude-code run is told in its prompt
that the skill "is installed for this step" while nothing was installed — a blind run rather than a
failed one. `mcpServers` is dropped the same way, which surfaces as an agent that was promised
tools it does not have.

SECURITY NOTE for a deployment that installs agent packages it did not author: a tool-server
definition names both the credential it wants and the endpoint it talks to, and the default
`createEnvToolSecretResolver` will resolve any key off the deployment environment. On the Worker
that is a real widening (`env` is not otherwise ambient to a registration). Pass
`createEnvToolSecretResolver(env, { allowKeys: [...] })` to confine it.
