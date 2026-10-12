---
'@cat-factory/directory-sync': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/mcp-server': patch
---

The SDK packages no longer pin each other to an exact version. A dependency on a sibling publishes as a caret range, so a consumer a patch ahead on `@cat-factory/sdk` keeps one copy of it. `@cat-factory/directory-sync` takes `@cat-factory/sdk` as a peer (`>=0.57.0 <1.0.0`): the client it drives is the integrator's own, so it now uses their copy of the SDK and installs none of its own. Add `@cat-factory/sdk` to your dependencies if you did not already have it.
