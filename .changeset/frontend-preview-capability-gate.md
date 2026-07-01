---
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
on every runtime and read by nothing.

This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

- **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
  `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
  so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
  Node + local `true`.
- **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
  true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
  explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
  when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
  local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
- **Conformance** pins that the axis is present + boolean on every facade (its value is a
  differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.
