---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
---

Add a first-class `frontend`-frame configuration. A frontend frame now carries a
`frontendConfig` (package manager, install/build/serve knobs, WireMock mappings path,
preview toggle) plus `backendBindings` that map each env var the frontend reads to an
upstream: a bound service frame's ephemeral environment, or a WireMock stub. The bindings
double as board links, drawn as frontend→service edges on the canvas. New inspector panel
(`FrontendConfig.vue`), the `frontend_config` JSON column mirrored across D1 and Drizzle
with a cross-runtime conformance round-trip, and `frontendConfig` on the update-block input.

Second slice of the frontend-preview + in-context UI-testing initiative
(docs/initiatives/frontend-preview-ui-testing.md).
