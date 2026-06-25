---
"@cat-factory/app": patch
---

fix: avoid DataCloneError when testing/saving an infrastructure provider connection

`buildManifestPayload` cloned the manifest base with `structuredClone`, but the base is a
Vue reactive proxy — `structuredClone` refuses proxies with a `DataCloneError`, so clicking
**Test connection** (or Save) in the ephemeral-environment / runner-pool provider window
threw immediately. Clone via a JSON round-trip instead, which unwraps the proxy and
deep-clones the plain-JSON manifest.
