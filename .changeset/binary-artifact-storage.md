---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/provider-s3': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
visual-confirmation gate's UI screenshots + reference design images).

- New kernel port `BinaryArtifactStore` with a split, mix-and-match seam: a per-runtime
  `BinaryArtifactMetadataStore` (the queryable metadata) + a pluggable `BinaryBlobBackend`
  (the bytes — the "custom adapter interface"), composed by `createBinaryArtifactStore`.
- Adapters: D1 metadata + R2 blob backend (Cloudflare — D1 can't hold large values, so
  bytes always go to R2); Drizzle/Postgres metadata + a Postgres `bytea` blob backend
  (Node/local, size-guarded); and a new opt-in `@cat-factory/provider-s3` package
  implementing the blob backend over an S3 (or S3-compatible) bucket.
- Metadata table `binary_artifacts` mirrored D1 ⇄ Drizzle; a Node-only
  `binary_artifact_blobs` `bytea` table backs the `db` backend (no D1 equivalent).
- `AppConfig.binaryStorage` selects the backend (`db` | `r2` | `s3`); wired in all three
  facades and surfaced on the request container. New workspace-scoped artifact API
  (upload reference / stream blob / list a run's artifacts). Cross-runtime conformance
  suite `defineBinaryArtifactsSuite` asserts store parity on both runtimes.
