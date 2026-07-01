---
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Make credential-decryption failures actionable and isolate them.

Previously, a stored secret sealed under a rotated/regenerated `ENCRYPTION_KEY` surfaced as
the opaque Web Crypto `OperationError` ("The operation failed for an operation-specific
reason") with no context — e.g. an inline requirements-review run failed at step 0 with that
bare message and no detail, because the reviewer leases + decrypts the workspace's provider
API keys before any LLM call (outside its own error-wrapping).

- `WebCryptoSecretCipher.decrypt` now rethrows an actionable error on an AES-GCM auth failure,
  naming `ENCRYPTION_KEY` and the likely key-rotation cause, preserving the original as `cause`.
- `ApiKeyService.lease` wraps a decrypt failure with the offending provider + key id.
- `createScopedModelProviderResolver.forScope` no longer lets ONE provider's undecryptable key
  sink the whole scoped provider: it registers a deferred-failure resolver for that provider, so
  calls targeting a different, healthy provider still resolve and only a call that actually needs
  the broken provider fails (with the real cause).
