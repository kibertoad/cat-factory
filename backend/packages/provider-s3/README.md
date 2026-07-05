# @cat-factory/provider-s3

Opt-in **AWS S3** (or S3-compatible) blob backend for cat-factory's binary artifacts —
implements the kernel `BinaryBlobBackend` port over an S3 bucket.

## Why this is its own package

The blob backend is pluggable: artifact **metadata** always lives in the runtime's database, but
the **bytes** can go anywhere (Cloudflare R2, the local filesystem, Postgres, or S3). S3 pulls in
the heavy `@aws-sdk/client-s3`, so it ships as its own opt-in package that only a deployment
choosing S3 depends on. Even then, the SDK is imported **lazily on first I/O**, not at module
load: a facade statically imports `S3BinaryBlobBackend` to wire its container, but a deployment
that ends up running the `db`/`fs`/no blob backend never pays the SDK's load cost — the SDK is
pulled in only when an S3 `put`/`get`/`delete` actually executes.

## Enabling it

The package exports one class:

- `S3BinaryBlobBackend` — a `BinaryBlobBackend` (`put` / `get` / `delete`) constructed from an
  `S3BinaryBlobBackendConfig`.

### Node / local facade

The Node facade selects a blob backend by kind in its `BuildBlobBackend` switch (see
`backend/runtimes/node/src/container.ts`); the `s3` case builds this backend from the account's
content-storage config:

```ts
import { S3BinaryBlobBackend } from '@cat-factory/provider-s3'

case 's3':
  if (!opts.s3) return null
  return new S3BinaryBlobBackend({
    ...opts.s3,                                              // region, bucket, prefix, endpoint, forcePathStyle
    ...(opts.s3Credentials ? { credentials: opts.s3Credentials } : {}),
  })
```

An account picks the S3 backend (and supplies region / bucket + credentials) in the
**content-storage settings UI**; the facade builds the backend from that config. Omitting
`credentials` is intentional and falls back to the **ambient AWS credential chain** (instance
role, `AWS_*` env) — the right behaviour for a deployment running on AWS with an attached role.
(The UI requires explicit keys, so the keyless path is only reached by config written through
another channel.)

> **Runtime reach.** S3 is wired on the **Node / local** facades. The Cloudflare Worker uses
> **R2** as its native blob backend, so it does not pull in `@aws-sdk/client-s3`. Scaled
> (multi-replica) Node deployments should prefer `s3` over the `fs` backend, whose local-disk
> bytes are invisible to other replicas and lost on redeploy.

## S3-compatible stores

Point `endpoint` at a non-AWS S3 API (MinIO, Ceph, etc.) and set `forcePathStyle: true` (required
by most S3-compatible stores). An optional `prefix` (e.g. `artifacts/`) is joined to each
artifact's storage key.

## Config (`S3BinaryBlobBackendConfig`)

| Option           | Purpose                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `region`         | AWS region (required).                                                                                    |
| `bucket`         | Target bucket (required).                                                                                 |
| `prefix`         | Optional key prefix, e.g. `artifacts/`, joined to the artifact's storage key.                             |
| `endpoint`       | Optional custom endpoint for S3-compatible stores (MinIO, etc.).                                          |
| `forcePathStyle` | Force path-style addressing (needed by most S3-compatible stores).                                        |
| `credentials`    | Explicit `{ accessKeyId, secretAccessKey, sessionToken? }`; omit to use the default AWS credential chain. |

## Related

Part of cat-factory's opt-in **AWS stack** alongside
[`@cat-factory/provider-bedrock`](../provider-bedrock) (LLM models) and
[`@cat-factory/eks`](../eks) (runner + environment backends). Each is independent and registers
into its own seam — mix in only what you use.
