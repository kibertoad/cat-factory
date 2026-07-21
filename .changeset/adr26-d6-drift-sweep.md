---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Surface + remediate ENCRYPTION_KEY drift (ADR 0026 D6.2/D6.3), building on the D6.1 fingerprint
and typed `SecretDecryptError`.

- A new `SealedSecretInventory` kernel port (`listSealed` + `drop`) is implemented per runtime
  (D1 + Drizzle, asserted by `defineSealedSecretInventorySuite`) over `environment_connections`
  and `observability_connections`. Adding a source is a change to the inventory pair, never the
  sweep.
- `sweepKeyDriftAndRaise` (runtime-neutral) attempts a decrypt of every sealed secret, buckets by
  `reason`, and raises ONE `key_drift` notification per affected workspace — listing the affected
  credentials by source / id / label / reason / seal time (never the value), de-duped on that set
  and auto-cleared when a workspace recovers. It runs at Node boot and on the Worker's daily cron.
- Remediation (D6.3) is explicit + per-secret: the `key_drift` card's action drops every credential
  it lists, and a `pnpm --filter @cat-factory/node-server key-drift:drop` operator CLI drops one.
  Both flip the owning connection to needs-re-entry (env → soft-delete, observability → row delete)
  and state that restoring the previous ENCRYPTION_KEY recovers the values instead — never automatic.
- Adds the `key_drift` notification type (contracts) + its inbox card copy across all locales.
