---
'@cat-factory/server': patch
'@cat-factory/agents': patch
---

`GET /internal/agent-kinds` serves each distinct bundled skill and tool server once, in top-level
`bundledSkills` and `toolServers` lists, and each kind references them by index
(`skills.bundledRefs`, `toolServers.serverRefs`). A definition assigned to several kinds no longer
serialises once per kind (the Nuxt UI capability drops from ~300 KB to ~100 KB per mothership-mode
dispatch).

Internal wire break, with no compatibility path: update mothership-mode nodes together with the
mothership. Until then, every container dispatch on a node whose build disagrees with its
mothership fails with `agent_kinds_unreachable`.
