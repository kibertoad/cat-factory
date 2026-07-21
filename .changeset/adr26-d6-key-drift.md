---
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Detect ENCRYPTION_KEY drift at boot via a master-key fingerprint (ADR 0026 D6.1), and make a
decrypt failure classifiable (D6.2 foundation).

- A non-secret `HKDF(masterKey, "cat-factory:key-fingerprint")[:8]` fingerprint is persisted
  once in a new `key_fingerprint` singleton table (D1 + Drizzle, mirrored per runtime) and
  recompared on every boot: the Node facade checks right after `migrate()`, and the Worker on
  its daily cron. A mismatch logs a definitive "the key changed since secrets were last
  sealed" signal before any request touches a stale secret, instead of the old stream of
  opaque per-request decrypt errors.
- `SecretCipher.decrypt` now throws a typed `SecretDecryptError` carrying a
  `reason: 'key-mismatch' | 'corrupt'` discriminant, so a drift sweep can bucket a failure
  without parsing message text.
