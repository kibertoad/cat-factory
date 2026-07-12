---
'@cat-factory/kernel': patch
'@cat-factory/caching': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Route `AccountSettingsService.resolve` through the app cache seam (performance initiative item 8).
The service's legacy homebrew 30s `{ value, expiresAt }` `Map` — the anti-pattern CLAUDE.md names
explicitly — is replaced by a new `accountSettings` `AppCaches` slice (grouped and keyed by account
id, holding the decrypted `ResolvedAccountSettings`). `resolve` now reads through it and `write`
invalidates the account's entry after the upsert commits, so an integration-credential change is
coherent across replicas (the invalidation bus carries only keys, never the decrypted secrets, so
plaintext still never leaves the process). `ResolvedAccountSettings` moved to the kernel
account-settings port (the caching port now names it) and is re-exported from
`@cat-factory/integrations`, so its consumers are unchanged. Pass-through on the Worker's
isolate-safe profile (our own mutable D1 state, no cross-isolate bus); both facades wire the slice.
