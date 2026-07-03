---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Mothership mode: widen the persistence-RPC allow-list to three more repository surfaces so
mothership-mode local nodes can drive them against a hosted mothership.

- `runnerPoolConnectionRepository` (whole repo) — the self-hosted runner-backend connection
  settings panel (`getByWorkspace`/`softDelete` via the `workspace` rule, the record-based
  `upsert` via `workspaceField`). Credentials ride a sealed `secretsCipher` blob, so no plaintext
  crosses the machine API (the observability/environment-connection precedent).
- `binaryArtifactMetadataStore` (metadata surface) — the visual-confirmation gate's artifact
  metadata (`insert` via `workspaceField`; `get`/`listByExecution`/`countByExecution`/`listByBlock`/
  `delete` via `workspace`). The blob BYTES stay per-account local; only the metadata is proxied,
  and the retention sweep stays mothership-internal. It is folded into both facades' reflected
  `repositories` registry (it isn't a `CoreDependencies` member).
- `serviceRepository.listByFrameBlocks` — the batched board-composition / frame-deletion read, via
  the `blockList` scope kind.
