# Visual Confirmation gate, UI tester & binary-artifact storage — handover

Status of the work on `claude/visual-confirmation-gate-gsmh1i`. This feature adds a pipeline
gate where a human reviews **screenshots of new UI functionality** against **reference design
screenshots** they supply, can dispatch a **Fixer** to make changes, and is fed by a new
browser-driven **UI tester** — all on top of a new runtime-neutral **binary-artifact storage**
abstraction.

It landed in three coherent, independently-verified slices plus the image definition. One
piece — routing a job into the dedicated UI-tester image — is intentionally left as a
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
  human-verdict, park-on-decision engine step — NOT a polling `GateDefinition` (it has no
  programmatic precheck).
- The UI tester is the browser sibling of the (renamed) API tester; both share the Tester→Fixer
  loop via `isTesterKind`.

---

## What's DONE (and how it's verified)

### Part A — Binary-artifact storage abstraction ✅ verified on both runtimes
- Kernel port `backend/packages/kernel/src/ports/binary-artifacts.ts`:
  `BinaryArtifactStore` composed by `createBinaryArtifactStore(metadata, blob, …)` from a
  per-runtime `BinaryArtifactMetadataStore` + a pluggable `BinaryBlobBackend` (the "custom
  adapter interface": `put`/`get`/`delete` by key).
- Adapters:
  - **R2** blob backend (`runtimes/cloudflare/.../storage/R2BinaryBlobBackend.ts`) + **D1**
    metadata (`D1BinaryArtifactMetadataStore.ts`). On Cloudflare blobs ALWAYS go to R2 — there
    is **no D1 blob adapter** (D1's ~1MB value limit).
  - **Postgres `bytea`** blob backend (`runtimes/node/src/storage/PostgresBinaryBlobBackend.ts`,
    size-guarded) + Drizzle metadata.
  - **S3** blob backend — new opt-in package `backend/packages/provider-s3` (modelled on
    `provider-bedrock`).
- Metadata table `binary_artifacts` mirrored D1 (`migrations/0017_binary_artifacts.sql`) ⇄
  Drizzle (`db/schema.ts` + generated migration); Node-only `binary_artifact_blobs` `bytea`
  table for the `db` backend. `pnpm db:check` is green.
- `AppConfig.binaryStorage` (`db|r2|s3`) selects the backend; wired in all three facades + the
  request `ServerContainer`. New API: `POST /workspaces/:ws/artifacts` (multipart upload),
  `GET …/artifacts/:id/blob`, `GET …/executions/:id/artifacts`, `GET …/blocks/:id/artifacts`.
- Conformance `defineBinaryArtifactsSuite` (store/get/list/listByBlock/delete + DB size-guard).
- **Verified:** Cloudflare suite (workerd + real D1) and Node suite (real Postgres) both pass.

### Part B — Tester split (tester-api + tester-ui) ✅ code verified
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
- `Dockerfile.ui` (Playwright + Chromium on the slim base image) added — see "What's left" for
  routing.
- **Verified:** Node execution conformance (38 tests) passes with the renamed kind.

### Part C — Visual Confirmation gate + SPA ✅ backend verified, SPA typechecked
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
  + reference upload), `stores/visualConfirm.ts`, `composables/api/visualConfirm.ts`, the
  `visual-confirm` result-view registration, notification reveal + Slack panel entries.
- **Verified:** Node conformance incl. a new gate pass-through test (59 tests total); frontend
  `nuxt typecheck` + catalog tests pass.

---

## What's LEFT (deploy-time, intentionally not landed)

### 1. Route a job INTO the UI-tester image (the one real gap)
The image is defined (`Dockerfile.ui`) and the dispatch seam (`RunnerDispatchOptions.image: 'ui'`)
is in place, but nothing maps that flag to the image yet. This is deploy-coupled and couldn't be
built/verified in the dev container:

- **Cloudflare** reuses **one container per run** (one Durable Object per run id), so a `tester-ui`
  step needs its OWN container on the UI image. Add a second `[[containers]]` class (e.g.
  `UiTesterContainer`) pinned to `cat-factory-executor-ui:<tag>`, an env binding, and route on
  `options.image === 'ui'` in `CloudflareContainerTransport.dispatch` (currently ignores options).
- **Local / self-hosted pool** likewise reuse a per-run container; thread the UI image tag for
  `image: 'ui'` (a separate container for that step) in `LocalContainerRunnerTransport` /
  `RunnerPoolTransport`.
- Publish the UI image: `docker build -f Dockerfile.ui --build-arg BASE_TAG=<v> -t
  cat-factory-executor-ui:<v> .` and wire the tag into `deploy/backend` (package.json + wrangler).
- Inject `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN` into the `tester-ui` job body (a
  per-run, scoped artifact-ingest credential — the prompt already tells the agent to use them),
  and add the container-token-authed ingest route the harness POSTs to.

Until this lands, the gate is fully usable against **manually-uploaded** reference + screenshots;
auto-capture lights up once routing is wired. (A stop-gap: `tester-ui` would otherwise run on the
base image with no browser — so don't enable `pl_visual` end-to-end in prod until routed.)

### 2. Recapture-after-fix loop (enhancement)
Today `request-fix` dispatches the `fixer` and re-parks with the existing screenshots (the gate
flags them as predating the fix). Auto re-running `tester-ui` after a fix to refresh the gallery
needs the gate to dispatch a `tester-ui` job and consume its result back into the gate (a small
extension of `onHelperComplete` + the `pollAgentJob` capture-result path).

### 3. Reference-screenshot pre-op injection
The UI-tester prompt references `.cat-context/reference-screenshots/`; a `preOps` that pulls the
block's `kind:'reference'` artifacts from the store and writes them into the container context is
not yet wired (the gate still pairs by view from the store, so the comparison works regardless).

### 4. Non-redundant capture heuristic
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
