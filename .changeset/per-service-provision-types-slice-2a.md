---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
---

Per-service provision types (slice 2a — resolver + registry engine metadata). Adds the
pure `resolveInfraHandler` resolution (service provision type → the workspace/user handler
that serves it, per-user override winning, `infraless` → the `none` engine, ambiguous bare
`custom` rejected), `engines()`/`acceptsManifestIds()` metadata + a `byEngine` lookup on the
environment-backend registry (the built-ins map kubernetes → `local-k3s`/`remote-kubernetes`,
compose → `local-docker`, manifest → `remote-custom`), and the app-owned
`CustomManifestTypeRegistry` + `aggregateCustomManifestTypes` catalog seam. Kernel re-exports
the new provision-type contract types. Pure/additive — the connection-table reshape, service
consumption, and tester collapse follow in slice 2b.
