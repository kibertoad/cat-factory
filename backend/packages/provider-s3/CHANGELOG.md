# @cat-factory/provider-s3

## 0.2.31

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.2.30

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/kernel@0.57.0

## 0.2.29

### Patch Changes

- @cat-factory/kernel@0.56.1

## 0.2.28

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0

## 0.2.27

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.2.26

### Patch Changes

- @cat-factory/kernel@0.55.3

## 0.2.25

### Patch Changes

- @cat-factory/kernel@0.55.2

## 0.2.24

### Patch Changes

- @cat-factory/kernel@0.55.1

## 0.2.23

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0

## 0.2.22

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0

## 0.2.21

### Patch Changes

- @cat-factory/kernel@0.53.1

## 0.2.20

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0

## 0.2.19

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0

## 0.2.18

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0

## 0.2.17

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0

## 0.2.16

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0

## 0.2.15

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0

## 0.2.14

### Patch Changes

- @cat-factory/kernel@0.47.2

## 0.2.13

### Patch Changes

- @cat-factory/kernel@0.47.1

## 0.2.12

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0

## 0.2.11

### Patch Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0

## 0.2.10

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/kernel@0.45.5

## 0.2.9

### Patch Changes

- @cat-factory/kernel@0.45.4

## 0.2.8

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.2.7

### Patch Changes

- c11a0cc: Republish with the compiled `dist/` payload. A prior `pnpm publish` ran without a build
  step, so the tarball shipped as an empty shell (only `package.json`, no `dist/`) and the
  package could not be imported. A `prepublishOnly` build hook now guarantees the package is
  compiled before it is packed, regardless of how publish is invoked.
- Updated dependencies [c11a0cc]
  - @cat-factory/kernel@0.45.2

## 0.2.6

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.2.5

### Patch Changes

- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0

## 0.2.4

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0

## 0.2.3

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.2.2

### Patch Changes

- @cat-factory/kernel@0.42.2

## 0.2.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1

## 0.2.0

### Minor Changes

- 32c653f: Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
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

### Patch Changes

- 32c653f: Review round 4 (visual-confirmation gate / binary artifacts):

  - **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
    `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
    Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
    even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
  - **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
    window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
    enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
    landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
    click.
  - **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
    `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
    insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
  - **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
  - **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
    against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
    renders as "not captured" rather than a 404 image.
  - Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
    provided to the run (manual mode otherwise), and treats the reference-design directory as
    optional.

  The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
  asserted by the cross-runtime binary-artifacts conformance suite.

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
