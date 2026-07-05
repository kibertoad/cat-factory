---
'@cat-factory/local-server': minor
---

Add an optional `backendRegistries` seam to `startLocal()`, threaded into `buildLocalContainer`
on both the Postgres and mothership boot paths (mirroring the existing `agentKindRegistry` seam).

This lets a deployment that registers a custom environment/runner backend by reference (e.g. a
Kargo ephemeral-environment provider) call `startLocal()` — and inherit its boot preflights
(harness-image refresh, container-runtime probe, PAT/auth warnings) — instead of re-implementing
the boot path with `start()` + `buildLocalContainer` by hand, which silently forgoes those
preflights (notably the recommended-executor-image pull at boot). Absent → unchanged (the
built-in-only default `manifest` + `kubernetes`).
