---
'@cat-factory/server': patch
'@cat-factory/agents': patch
---

`GET /internal/agent-kinds` serves each distinct bundled skill once, in a top-level `bundledSkills`
list, and each kind references it by index in `skills.bundledRefs`. A playbook assigned to several
kinds no longer serialises once per kind (the Nuxt UI capability drops from ~300 KB to ~100 KB per
mothership-mode dispatch). Internal wire break: a mothership and a node on different sides of this
change refuse each other's reply as unreadable, so they must run the same build.
