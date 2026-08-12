# Visual Confirmation gate, UI tester & binary-artifact storage: handover

Status of the work on `claude/visual-confirmation-gate-gsmh1i`. This feature adds a pipeline
gate where a human reviews **screenshots of new UI functionality** against **reference design
screenshots** they supply, can dispatch a **Fixer** to make changes, and is fed by a new
browser-driven **UI tester**, all on top of a new runtime-neutral **binary-artifact storage**
abstraction.

It landed in three coherent, independently-verified slices plus the image definition. One
piece (routing a job into the dedicated UI-tester image) is intentionally left as a
deploy-time follow-up (see "What's left").

---

## Architecture at a glance

```
tester-ui (browser, Playwright)         visual-confirmation gate (park-on-decision)
  ├─ captures 1 screenshot per view  →    ├─ pairs actual screenshots vs reference designs
  ├─ uploads PNGs to the artifact store    ├─ parks for a human: approve / request-fix / recapture
  └─ reports TestReport.screenshots[]      └─ request-fix → Fixer → re-park (approve → advance)

binary-artifact storage (the substrate both rely on)
  BinaryArtifactStore = metadata store (D1 ⇄ Postgres) + pluggable BinaryBlobBackend (R2 / S3 / Postgres-bytea / custom)
```

- The gate is modelled on the existing **`human-test`** gate (`HumanTestController`): a non-LLM,
  human-verdict, park-on-decision engine step, NOT a polling `GateDefinition` (it has no
  programmatic precheck).
- The UI tester is the browser sibling of the (renamed) API tester; both share the Tester→Fixer
  loop via `isTesterKind`.
- The gate's REFERENCE side has two producers: images a person uploaded against the task, and the
  frames an import retained for the designs the task links. See "Design references" below.

---

## What's DONE (and how it's verified)

### Part A: Binary-artifact storage abstraction ✅ verified on both runtimes

- Kernel port `backend/packages/kernel/src/ports/binary-artifacts.ts`:
  `BinaryArtifactStore` composed by `createBinaryArtifactStore(metadata, blob, …)` from a
  per-runtime `BinaryArtifactMetadataStore` + a pluggable `BinaryBlobBackend` (the "custom
  adapter interface": `put`/`get`/`delete` by key).
- Adapters:
  - **R2** blob backend (`runtimes/cloudflare/.../storage/R2BinaryBlobBackend.ts`) + **D1**
    metadata (`D1BinaryArtifactMetadataStore.ts`). On Cloudflare blobs ALWAYS go to R2: there
    is **no D1 blob adapter** (D1's ~1MB value limit).
  - **Postgres `bytea`** blob backend (`runtimes/node/src/storage/PostgresBinaryBlobBackend.ts`,
    size-guarded) + Drizzle metadata.
  - **S3** blob backend: opt-in package `backend/packages/provider-s3` (modelled on
    `provider-bedrock`); accepts explicit UI-entered credentials. **Node/local only**: S3 is
    deliberately not offered on the Worker (the AWS SDK does not belong in the Worker bundle).
  - **Filesystem** blob backend (`runtimes/node/src/storage/FilesystemBinaryBlobBackend.ts`):
    on-disk under a base path (default `.file-storage`, git-ignored). Node/local only, and
    local-disk only, not for a scaled/ephemeral deployment (use `s3` there).
- Metadata table `binary_artifacts` mirrored D1 (`migrations/0017_binary_artifacts.sql`) ⇄
  Drizzle (`db/schema.ts` + generated migration); Node-only `binary_artifact_blobs` `bytea`
  table for the `db` backend. `pnpm db:check` is green.
- The backend is configured **per ACCOUNT in the UI** (no env vars): it lives in the
  `account_settings` `config.contentStorage` (S3 keys sealed in `secrets_cipher`). The store is
  resolved per workspace→account via `makeResolveBinaryArtifactStore` (`@cat-factory/server`),
  wired in all three facades (default backend: `off` on Node, `fs` in local mode, `r2` on
  Cloudflare when bound). API: `POST /workspaces/:ws/artifacts` (multipart upload),
  `GET …/artifacts/:id/blob`, `GET …/executions/:id/artifacts`, `GET …/blocks/:id/artifacts`;
  configured via `GET|PUT /accounts/:id/settings`.
- Conformance `defineBinaryArtifactsSuite` (store/get/list/listByBlock/delete + DB size-guard).
- **Verified:** Cloudflare suite (workerd + real D1) and Node suite (real Postgres) both pass.

### Part B: Tester split (tester-api + tester-ui) ✅ code verified

- `tester` renamed to **`tester-api`**; new **`tester-ui`** kind. Constants + helper
  `isTesterKind`/`TESTER_KINDS` in `orchestration/.../ci.logic.ts`; both share the Tester→Fixer
  loop, the `tester.environment` infra choice, and the env projection.
- `TestReport.screenshots[]` added (`contracts/testing.ts`). `ContainerAgentExecutor` builds a
  `tester-ui` body (structured output incl. screenshots) and dispatches with the
  **`image: 'ui'`** option (`RunnerDispatchOptions.image`). Result coercion passes screenshots
  through.
- New `TESTER_UI_SYSTEM_PROMPT` (`agents/prompts/testing.ts`): drive Playwright, capture one
  non-redundant screenshot per distinct view, pair against `.cat-context/reference-screenshots/`,
  and upload each via the run's `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`.
- Renamed everywhere: seed pipelines, configs/traits, the SPA palette (API Tester + UI Tester),
  and all tests/snapshots.
- `Dockerfile.ui` (Playwright + Chromium on the slim base image) added: see "What's left" for
  routing.
- **Verified:** Node execution conformance (38 tests) passes with the renamed kind.

### Part C: Visual Confirmation gate + SPA ✅ backend verified, SPA typechecked

- Step state `visualConfirmStepStateSchema` + `pipelineStepSchema.visualConfirm`
  (`contracts/entities.ts`). Kind `VISUAL_CONFIRM_AGENT_KIND = 'visual-confirmation'`.
- `VisualConfirmationController` (`orchestration/.../VisualConfirmationController.ts`), cloned
  from `HumanTestController`: gathers the latest `tester-ui` step's screenshots + the block's
  uploaded reference images (paired by view), parks; actions **approve** (advance),
  **request-fix** (dispatch the `fixer`, then re-park), **recapture** (refresh pairs). Passes
  through (auto-advances) when no binary-artifact store is wired.
- Engine delegation in `ExecutionService` (evaluate / re-entrant action / `onHelperComplete` /
  the action methods); `binaryArtifactStore` threaded through `CoreDependencies` on both facades.
- Notification `visual_confirmation_ready` (+ Slack routing). HTTP action endpoints
  (`/blocks/:id/visual-confirmation/{approve,request-fix,recapture}`). New `pl_visual` pipeline
  (`… tester-ui → visual-confirmation → merger`).
- SPA: `VisualConfirmationWindow.vue` (actual-vs-reference gallery + approve/request-fix/recapture
  - reference upload), `stores/visualConfirm.ts`, `composables/api/visualConfirm.ts`, the
    `visual-confirm` result-view registration, notification reveal + Slack panel entries.
- **Verified:** Node conformance incl. a new gate pass-through test (59 tests total); frontend
  `nuxt typecheck` + catalog tests pass.

### Design references: a linked design populates the gallery itself ✅

A designer who links a Figma/Zeplin frame to a task gets screenshot-vs-design comparison with no
manual upload. When the gate gathers its pairs it reads the task's linked DESIGN documents
(`documentRepository.listByBlock`, filtered by contracts' `isDesignSource`) and the frames their
last import retained (`BinaryArtifactStore.listByDocuments`, one batched read however many designs
are attached), and folds those in beside the hand-uploaded set. The fold itself lives in
`orchestration/.../visual-confirm-design-references.ts`; four rules bind it.

- **An EXPLICITLY CHOSEN reference outranks a design frame for the same view.** An upload is a
  deliberate act against this one task and survives every re-import; a design render is a
  projection of a live document that the next body-changing import replaces wholesale. So the
  design fold runs FIRST and the uploads assign over it, and the fold skips a view whose reference
  the capture itself named: the fold cannot tell which choice it would be overwriting, and once the
  container half lands the tester will be naming the design files it was handed.
- **A view name two designs both claim is qualified on BOTH sides** (`Summary (Checkout flow)`),
  the same rule the Figma import applies to a frame name repeated across pages. Leaving the first
  occurrence bare would hand the plain name to whichever design is listed first, so re-ordering the
  links would silently re-point a reviewed view at a different screen.
- **Each pair carries `referenceOrigin`**, so the surface can say whether a reviewer is looking at
  the design's own frame or at somebody's attachment. It is ABSENT when the capture named its own
  reference: the gate did not source that one and can only guess at its provenance, which is a
  different answer from "an upload".
- **`designReferences` states what the designs contributed, gaps included.** Present whenever a
  design is linked, so a reviewer can tell "no design is attached" from "one is attached and gave
  nothing", with a per-design reason (`partial` / `failed` / `none` / `storage_unavailable` /
  `not_retained`) because each asks for a different fix. `not_retained` covers any status CLAIMING
  retention over an empty shelf (`stored` and `partial` alike) as well as a document whose import
  recorded no render outcome: left to speak for itself, "only part of its frames were retained"
  above an empty gallery reads as a design that is merely short.
- **The 12-view ceiling is SHARED, and what it cuts is named per design.** Slots go round-robin, so
  every linked design is represented before any gets a second one and re-ordering the links does
  not move the split; taking the first twelve in read order would let the design linked longest ago
  fill the gallery while one linked this morning contributed nothing, indistinguishable to a
  reviewer from a design with no frames. Each short design carries its own `dropped` count beside
  its `reason`, since the two are independent (a design can be short at its source, at the ceiling,
  or both). Emission stays grouped by design: the allocation decides how many, never the order.

The reads are LIVE at gather time, like the hand-uploaded ones: **recapture** is the action a person
takes after attaching something mid-review, and linking a design is that same act.

### Reference designs on disk: what the container is handed ✅

The gate's reference SET (which artifact is the reference for each view) is now read by two callers,
so it lives in one module (`orchestration/.../block-reference-set.ts`) rather than being derived
twice: the gate pairs captures against it, and a dispatch of a CAPTURING kind hands the same set to
the container. A second derivation would let the two disagree about a view name, and the view name is
exactly the join the gate performs, so the pairing would fall apart with both halves still looking
correct on their own.

- **The gate is the kind's declared `ui` image**, the same fact the transport routes the job by, not
  a kind-name list: a deployment's own browser-driven kind is served without registering anywhere
  else, and every other kind never pays the two reads.
- **The job body carries a MANIFEST, never the bytes.** A design frame is a full-page PNG and a job
  body is JSON that crosses every transport and is persisted with the dispatch, so only
  `{ artifactId, fileName, view }` travels. The harness fetches the bytes from
  `GET ${proxyBaseUrl}/artifacts/reference/:id` with the SAME container session token it already
  holds for the LLM proxy: no new credential, no publicly reachable URL, and the mirror image of the
  ingest route beside it. That route serves `kind:'reference'` only, within the token's workspace,
  so it cannot become a way to read another run's captured screenshots (`security-model.md`).
- **The file NAME is chosen by the engine, not the container.** The name is how the agent learns the
  view name; derived in the harness, a sanitiser change in an image a deployment has not rolled out
  yet would rename every view a run reports. Two views that slug to one name are suffixed rather
  than deduped: dropping one hands the agent a directory quietly missing a screen it was asked to
  compare.
- **A reference that is not on disk is NAMED in the prompt.** On disk an absent file and a screen the
  design does not have are identical, so the guidance lists the misses beside the files and tells the
  agent to capture those views anyway, under the same names. It covers both causes of that absence,
  because the agent's job is the same either way: a transfer that failed, and a view the cap below
  dropped before the container was asked for it. The "these are on disk" sentence is bound to the
  files that ARE, so a pass that wrote nothing does not send the agent after a path that may not
  exist.
- **The set is CAPPED, and the cap states what it dropped.** A task's references are unbounded (a
  block may carry a hundred uploads beside a design's frames) while the download pass is deliberately
  budgeted well under the inactivity watchdog, so an uncapped set spends the whole budget and
  delivers whatever finished. `capReferences` bounds it at `MAX_REFERENCE_SCREENSHOTS` and carries
  the dropped view names on the set's `omitted`. It drops DESIGN frames before uploads: the merge
  emits frames first and appends upload-only views, so a plain prefix would discard exactly the half
  the precedence rule calls more deliberate. The harness keeps a higher backstop against a malformed
  body, and it too names what it drops rather than truncating.
- **The download pass is IDEMPOTENT over the checkout.** An agent flow re-enters its workspace once
  per repair round, so this runs several times per job. A file already on disk (non-empty: a
  zero-length file is what a half-written transfer leaves) is counted and never re-fetched, so a
  later round costs a stat per reference and cannot downgrade a view an earlier round delivered to
  "NOT on disk". A view that MISSED is retried, which is the point: the next round is a fresh chance
  at a blob backend that was briefly down.
- **The per-image ceiling bounds the TRANSFER, not just the write.** The declared `content-length` is
  refused before a byte is read, and the body is counted as it streams and cancelled the moment it
  crosses the line, so a chunked or lying response cannot buffer past the ceiling (times the pass's
  concurrency) in a container that has not started working yet.
- **An empty set sends no manifest at all.** The engine resolving no files (the task has no reference)
  and a kind that captures nothing are different facts, but neither should produce an empty
  directory: that reads to the agent as designs that gave nothing. A set the CAP emptied is the
  exception and does send one, carrying names and no files: those views still have to be captured.

---

## What's LEFT (deploy-time, intentionally not landed)

### 1. Auto-capture: image routing + harness consumption

For `tester-ui` to auto-capture, three things have to be true. The backend seam (the third) is
now DONE; the two deploy-coupled / harness pieces remain (they couldn't be built/verified in the
dev container).

**1a. Route a job INTO the UI-tester image (deploy-coupled).** The image is defined
(`Dockerfile.ui`) and the dispatch seam (`RunnerDispatchOptions.image: 'ui'`, set for `tester-ui`
in `ContainerAgentExecutor.dispatchOptions`) is in place, but nothing maps that flag to the image
yet:

- **Cloudflare** reuses **one container per run** (one Durable Object per run id), so a `tester-ui`
  step needs its OWN container on the UI image. Add a second `[[containers]]` class (e.g.
  `UiTesterContainer`) pinned to `cat-factory-executor-ui:<tag>`, an env binding, and route on
  `options.image === 'ui'` in `CloudflareContainerTransport.dispatch` (currently ignores options).
- **Local / self-hosted pool** likewise reuse a per-run container; thread the UI image tag for
  `image: 'ui'` (a separate container for that step) in `LocalContainerRunnerTransport` /
  `RunnerPoolTransport`.
- Publish the UI image: `docker build -f Dockerfile.ui --build-arg BASE_TAG=<v> -t
cat-factory-executor-ui:<v> .` and wire the tag into `deploy/backend` (package.json + wrangler).

**1b. Harness consumption (executor-harness image, image-bumped): DONE.** The harness parses the
job body's `artifactUpload` (`{ url, token }`) and surfaces it to the agent as the
`ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN` the `tester-ui` prompt already references
(`src/artifact-upload.ts`), registering the token for redaction first. The seam is layered on for
every mode rather than gated on the kind: which kinds get it is the BACKEND's decision (it keys off
the kind's declared `ui` image), so a container-side kind list would be that decision made twice.
An unusable spec (either half missing, or a non-http transport) drops the WHOLE seam, because a URL
with no token is an endpoint nothing can call.

Deliberately NOT added to `HARNESS_BODY_CAPABILITIES`: that handshake's membership bar is "a
missing field would make the PROMPT lie", and this prompt is explicitly conditional ("If
`ARTIFACT_UPLOAD_URL` is NOT set, do not attempt any upload and omit `screenshots` … a human will
capture and review the screens manually"). An older image dropping the field therefore degrades
into exactly the manual mode described below, which is honest — so refusing the run would be a
false accusation. The Playwright driver ships in `Dockerfile.ui`.

**1c. Backend ingest seam: DONE.** `ContainerAgentExecutor` now injects `artifactUpload` into the
`tester-ui` job body (reusing the run's existing container session token + the proxy base URL, so
no extra credential or public-URL dependency), and `harnessArtifactController` mounts a
container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest` that stores the bytes as a
`screenshot` artifact scoped to the token's workspace + execution. Image-allow-list + size guard +
`nosniff` serving are shared with the workspace upload endpoint (`imageArtifacts.ts`).

Until 1a lands, the gate is fully usable against **manually-uploaded** reference + screenshots;
auto-capture lights up once the UI-image routing is wired (the harness half is done). The
`pl_visual` pipeline still parks for a human regardless (manual mode), so it is safe to expose: it
just won't have auto-captured shots until then.

### 2. Recapture-after-fix loop (enhancement)

Today `request-fix` dispatches the `fixer` and re-parks with the existing screenshots (the gate
flags them as predating the fix). Auto re-running `tester-ui` after a fix to refresh the gallery
needs the gate to dispatch a `tester-ui` job and consume its result back into the gate (a small
extension of `onHelperComplete` + the `pollAgentJob` capture-result path).

### 3. Reference screenshots INSIDE the container: DONE

The container half is wired (see "Reference designs on disk" below): a dispatch of a kind declaring
the `ui` image resolves the task's reference set, the job body carries it as a MANIFEST, and the
harness downloads the images into `.cat-context/reference-screenshots/` before the agent's first
turn. The tester is told each file's view name, so what it captures pairs with what the gate holds.

### 4. Design pictures for the BUILDING kinds: DONE

The same retained frames now also reach the kinds that build or plan a screen (the `design-images`
trait: implementer, architect, fixer), which is the other half of "the pixels reach somebody". It is
a separate delivery, not an extension of this one: `.cat-context/design-renders/`, capped far
tighter (an attached image costs input tokens every turn, where a capture reference costs one
transfer), and gated on the dispatch's harness AND model being able to carry an image at all. Model:
[`figma-design-support.md`](../../docs/initiatives/figma-design-support.md).

### 5. Non-redundant capture heuristic

The "one screenshot per distinct view" dedup is prompt-driven; it'll want iteration on real apps
(hash-based dedup of near-identical views).

---

## Verifying locally

```bash
# Backend (Node side needs Postgres):
pnpm -r build                       # or per-package: pnpm --filter @cat-factory/<pkg> build
cd backend/runtimes/node
DATABASE_URL=postgres://… pnpm exec vitest run test/binary-artifacts.spec.ts \
  test/conformance.execution.spec.ts            # storage parity + gate + tester rename
pnpm --filter @cat-factory/node-server run db:check   # "Everything's fine 🐶🔥"

# Cloudflare side (workerd + local D1, no external Postgres):
cd backend/runtimes/cloudflare
pnpm exec vitest run test/integration/binary-artifacts.spec.ts

# Frontend:
cd frontend/app && pnpm typecheck && pnpm exec vitest run app/utils/catalog.spec.ts
```

## Key files

- Storage: `kernel/src/ports/binary-artifacts.ts`, `provider-s3/`, the D1/Drizzle stores + blob
  backends, `migrations/0017_binary_artifacts.sql`.
- Tester: `orchestration/.../ci.logic.ts` (constants), `agents/prompts/testing.ts`,
  `server/.../ContainerAgentExecutor.ts`, `executor-harness/Dockerfile.ui`.
- Gate: `orchestration/.../VisualConfirmationController.ts`, `…/ExecutionService.ts` (delegation),
  `contracts/entities.ts` + `contracts/routes/visual-confirm.ts`, `kernel/domain/seed.ts`
  (`pl_visual`).
- SPA: `frontend/app/app/components/visualConfirm/VisualConfirmationWindow.vue`,
  `stores/visualConfirm.ts`, `composables/api/visualConfirm.ts`.
