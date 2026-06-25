---
"@cat-factory/contracts": patch
"@cat-factory/integrations": patch
"@cat-factory/orchestration": patch
"@cat-factory/app": patch
---

Review fixes for the declutter/observability pass:

- **Board no longer crashes on `external`/`environment` blocks.** Those types stay
  user-uncreatable, but the backend still emits them (the seeded third-party service and
  the environments integration), so they are restored to the frontend `BlockType` union +
  `BLOCK_TYPE_META` for display parity with the contracts `blockTypeSchema`. `blockTypeMeta()`
  adds a safe fallback so an unknown/legacy block type degrades instead of throwing on the board.
- **Integrations hub gates the Observability row on availability.** The `releaseHealth` store
  now probes an `available` flag (mirroring the other integration stores); the hub hides the
  "Post-release health" entry when `OBSERVABILITY_ENABLED` is off, instead of showing a dead
  row that only 503s.
- **De-duplicated release-health loads.** `ensureLoaded()` coalesces repeated hub opens /
  frame-inspector mounts so they reuse the resolved connection + configs rather than re-fetching
  the whole configs list on every service selection.
- **Vendor-neutral gate message.** The post-release-health pipeline guard now says "Connect an
  observability provider" instead of the leftover "Connect Datadog".
- **Validated credentials at the registry boundary.** `parseDatadogCredentials` validates the
  decrypted blob in the observability registry, so a drifted/corrupted row fails with a clear
  error instead of deep inside the Datadog client during a live probe.
