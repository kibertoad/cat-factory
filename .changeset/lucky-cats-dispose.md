---
'@cat-factory/kernel': minor
---

Seed a terminal `disposer` step into the built-in `pl_bug_triage` pipeline, so a scheduled triage
run reclaims the ephemeral environment it stood up instead of leaving it to the TTL sweep. Version
bumped to 5, which offers the reseed to already-seeded workspaces.
