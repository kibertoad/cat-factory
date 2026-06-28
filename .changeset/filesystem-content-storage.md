---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/provider-s3': patch
---

Filesystem blob backend + UI-managed, per-account content storage.

- New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
  screenshots, reference designs) on disk under a base path (default `.file-storage`,
  git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
- Content-storage configuration moves entirely into the UI, scoped per **account**
  (Account → Deployment settings), stored in `account_settings` (no DB migration; the
  S3 access keys are sealed in the existing secrets blob). The blob backend is now
  resolved per request/run from the account's settings via the new
  `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
  `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
- Per-runtime defaults when an account hasn't configured storage: **local** defaults to
  the filesystem backend (works out of the box); **Node** defaults to off (storage requires
  explicit configuration); **Cloudflare** defaults to its R2 bucket and an account can switch
  to S3.

BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
`S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
Configure storage per-account in the UI instead. Switching an account's backend orphans its
previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.
