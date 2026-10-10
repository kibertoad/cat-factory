---
'@cat-factory/server': patch
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
---

`GET /internal/agent-kinds` serves each distinct bundled skill and tool server once, in top-level
`bundledSkills` and `toolServers` lists, and each kind references them by index
(`skills.bundledRefs`, `toolServers.serverRefs`). A definition assigned to several kinds no longer
serialises once per kind (the Nuxt UI capability drops from ~300 KB to ~100 KB per mothership-mode
dispatch). The reply now carries a `version`, and a node refuses any version but its own with
`details.cause: 'mothership_version_mismatch'`.

Boot validation refuses a bundled skill or tool server whose shape does not match its type
(`invalid_bundled_skill_definition`, `invalid_tool_server_definition`), naming the field.

Internal wire break, with no compatibility path: update mothership-mode nodes together with the
mothership. Until then, on a deployment with assigned capabilities, every container dispatch on a
node whose build differs from its mothership fails with `agent_kinds_unreachable`. A newer node
names the cause; an older node cannot. An empty layer (no assigned capabilities) keeps working in
both directions.
