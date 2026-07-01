---
'@cat-factory/integrations': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Wire the programmatic custom provision-type catalog (`CustomManifestTypeRegistry`)
into every facade so a code-registered `custom` manifest type is actually visible.
Previously a deployment/provider package could register a custom manifest type, but
no runtime constructed or injected the registry, so `listCustomTypes` always saw an
empty registered set — the type never appeared in the infrastructure custom-type
editor or the per-service provisioning picker.

`customManifestTypeRegistry` now belongs to `BackendRegistries` (built by
`createBackendRegistries()`), and the Cloudflare + Node facades thread it into
`createCore` (local inherits via `buildNodeContainer`). A deployment registers a
type by reference — `registries.customManifestTypeRegistry.register({ manifestId,
label, … })` — exactly like a custom environment/runner backend. The cross-runtime
conformance suite now asserts a registered type surfaces in the handlers bundle
(`source: 'registered'`) on both runtimes.
