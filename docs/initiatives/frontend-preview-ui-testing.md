# Frontend preview + in-context UI testing

## Goal & rationale

Today cat-factory can spin up an ephemeral backend environment for a service under test (the
`deployer` step → `EnvironmentProvisioningService` → `environments` table → a live URL) and run
agent-driven UI tests (`tester-ui` on the `ui` image). What is missing is the frontend half:
declaring that a backend has a frontend counterpart, building and serving that frontend pointed
at the ephemeral backend, mocking the frontend's OTHER backend dependencies, and running the UI
tests against the two running together.

This initiative adds a first-class **frontend** board block that links to one or more backend
services, plus a **self-contained UI-test flow** (one `ui` container builds the frontend from
its branch, injects the ephemeral backend URL(s), stands up WireMock for every other upstream,
serves the built app, and runs `tester-ui` against it). It also generalizes repo onboarding so
import/bootstrap picks a repository type (backend / frontend / library / document-repository)
and makes the Mocker agent aware of frontend testing.

End state: a frontend frame on the board, linked to backend service frames via per-env-var
bindings, that can build+serve itself pointed at a bound service's ephemeral env with all other
upstreams mocked, and be UI-tested by the existing `tester-ui` agent — on all three runtimes
for the self-contained path, plus an optional browsable preview on local/node.

Locked decisions:

- Serve topology: both self-contained and a browsable preview, but Cloudflare supports ONLY
  the self-contained container; local/node support both behind a toggle.
- Test driver: agent-driven `tester-ui` (reuse the kind, image, result view).
- Mocking: WireMock seeded from a mappings directory in the frontend repo.
- Onboarding gains a type selector; document-repository allows only spike/document tasks.

Full design: `~/.claude/plans/we-need-to-design-wiggly-pie.md` (the approved plan).

## Target pattern

The pilot is slice 1 (this PR): the repo-type selector + `library`/`document` block types +
per-type task gating. It establishes the frame-type-is-behavioural convention that later slices
build on. Link the merged pilot PR here once it lands.

## Per-slice status

| #   | Slice                                                                                 | Status | PR                                                        |
| --- | ------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| 1   | Repo type selector + `library`/`document` types + task/pipeline gating                | done   | [#605](https://github.com/kibertoad/cat-factory/pull/605) |
| 2   | `frontend` block + `frontendConfig` + inspector + board links + persistence/symmetry  | done   | [#609](https://github.com/kibertoad/cat-factory/pull/609) |
| 3   | Harness frontend infra + `ui` image bump + `testerInfraSpec` wiring + conformance     | done   | [#615](https://github.com/kibertoad/cat-factory/pull/615) |
| 4   | Mocker frontend awareness + `pl_frontend` pipeline                                    | done   | [#629](https://github.com/kibertoad/cat-factory/pull/629) |
| 4b  | Deployer service-frame env keying → live-service binding resolves + live-env e2e      | done   | [#633](https://github.com/kibertoad/cat-factory/pull/633) |
| 4c  | Surface/gate visual pipelines (`tester-ui`/`visual-confirmation`) to frames with a UI | done   | [#636](https://github.com/kibertoad/cat-factory/pull/636) |
| 5   | Browsable preview (local/node) + `frontendPreviewSupported` capability gate           | todo   | —                                                         |

## Conventions & gotchas carried between iterations

- `block.type` was cosmetic-only before this initiative; it is now BEHAVIOURAL for the four
  frame repo roles (`service`/`frontend`/`library`/`document`). Keep the cosmetic-only types
  (`api`/`database`/`queue`/…) working for manual `addFrame`.
- The onboardable roles live in `frameRepoTypeSchema` / `FRAME_REPO_TYPES`
  (`backend/packages/contracts/src/primitives.ts`) — the import + bootstrap selectors offer
  exactly this set; `service` is the default so existing callers are unchanged.
- Any new frame-type meta must be added in BOTH `BLOCK_TYPE_LABEL`
  (`backend/packages/kernel/src/domain/catalog.ts`) and `BLOCK_TYPE_META`
  (`frontend/app/app/utils/catalog.ts`); `catalog.spec.ts`'s `BLOCK_TYPES` list gates coverage.
- The document-repo task gate must hold at EVERY way a task enters a frame, not just create:
  `BoardService.addTask` AND `BoardService.reparent` (drag-drop) AND
  `RecurringPipelineService.create` all reject a non-`document`/`spike` task under a `document`
  frame (shared via `BoardService.assertTaskTypeAllowed`). `reparent` also re-stamps a moved
  task's behavioural `type` to its new enclosing frame. A future frame-type-behavioural
  constraint should follow the same "gate all entry points" rule.
- Bootstrap retry with no existing frame currently defaults the frame type to `service` (the
  chosen type is not yet persisted on the `bootstrap_jobs` row). Persist it in slice 2 when the
  bootstrap persistence is touched.
- Keep the runtimes symmetric: the self-contained UI-test path is runtime-neutral and must land
  on Cloudflare + Node/local + pool together with a conformance assertion. The browsable preview
  is a genuine local/node differentiator, capability-gated (`frontendPreviewSupported`).
- Any change to the runner image (slice 3: WireMock + JRE + static server + pnpm in the `ui`
  variant) MUST bump `@cat-factory/executor-harness` and the image tag in `deploy/backend`.
- `frontendConfig` (slice 2) is stored serialized on the frame block via `optJsonField`, exactly
  like `provisioning` — a single `frontend_config` JSON column, mirrored D1 (`0029_frontend_config.sql`)
  ⇄ Drizzle (`blocks.frontend_config`) with a conformance round-trip. The backend does NOT gate it
  to `type: 'frontend'` frames (mirrors `provisioning`, which any frame may carry); only the inspector
  panel is type-gated. The whole config flows through the generic `updateBlock` PATCH.
- `FrontendConfig.backendBindings[].envVar` intentionally allows the EMPTY string (its schema has
  no `minLength`): a freshly-added inspector binding row starts blank and is persisted immediately,
  so a strict schema would 422 the PATCH mid-edit. Slice 3's infra/job-body builder MUST filter
  `envVar === ''` bindings so an unfinished row is inert (not injected as an empty env var).
- The board frontend→service edges (cyan, `TaskDependencyEdges.vue`) are derived from the
  `service`-sourced bindings, deduped per target service. A binding's `mock` source draws no edge.
- Slice 3 conventions & gotchas:
  - The harness `AgentInfraSpec` is now a discriminated union (`ServiceInfraSpec` |
    `FrontendInfraSpec`), keyed on `kind` (absent ⇒ `service`). The backend builds the
    `frontend` variant in `testerInfraSpec` (server `agents/prompts.ts`) from a new
    `AgentRunContext.frontend` slice; `AgentContextBuilder.resolveFrontendConfig` resolves it
    (walk to the frame → read `frontendConfig` → resolve each `service` binding to its live env
    URL via a SINGLE `listHandles` read indexed by block id, never a per-binding point read).
  - **servePort default is 4173, NOT 8080.** The harness's own job HTTP server owns 8080 in the
    same container, so a frontend served on 8080 would clash. The contract's default note was
    corrected to 4173; WireMock defaults to 8089. Both are backend-chosen in `testerInfraSpec`.
  - **The tester-infra start gate** (`decideTesterInfra` + `assertTesterInfraConfigured`) grew a
    frontend branch: a `frontend` frame is refused (`frontend-no-live-service`) only when it binds
    a live-backend `service` (`hasServiceBinding`) with none actually live (`hasLiveServiceBinding`).
    A mock-only / no-backend frontend PASSES — WireMock + the static server fully stand it up, so
    there is nothing to gate on. It is decided BEFORE the backend provision-type branch and passes
    through when the env seam is unwired (tests). The cross-runtime conformance asserts the refusal
    for a frontend that DOES bind a (non-live) service (a facade that dropped `frontend_config`
    would let the run start instead) — the D1 ⇄ Drizzle parity of reading the column during a run.
  - **Env keying (carried forward — the frame-id ⇄ task-id gap):** a binding's `service` source
    resolves the live env by the bound block id directly (the design's
    `getHandleForBlock(serviceBlockId)` semantics, where `serviceBlockId` is the service FRAME id).
    Today a `deployer` keys the env under the block it ran on (a task, `block.id`), NOT the frame,
    so `resolveFrontendConfig`'s `handle.blockId === serviceBlockId` match never hits and a frontend
    that binds a live service is still refused. Reconciling this (making a service frame's ephemeral
    env resolvable by the FRAME id it's bound to) is DELIBERATELY deferred — it's a deployer-keying
    change, not a reverse-walk hack bolted on here. Slice 4 (below) landed the `pl_frontend`
    pipeline + the frontend-aware mocker; this keying change was split out as **slice 4b**. The
    happy-path binding→URL math is covered by the `resolveFrontendBindings` unit tests; the
    live-env e2e assertion lands with slice 4b.
  - **Harness stand-up hardening (review follow-ups):** the WireMock / serve child processes each
    get an `'error'` listener (`guardProcess`) — a `ChildProcess` `'error'` with no listener is an
    UNCAUGHT exception that would crash the whole job server (matches the pattern in `pi.ts` /
    `agent-runner.ts`). WireMock is now health-checked (`/__admin/`) alongside the served app, so a
    dead mock becomes a prompt note instead of a test-time ECONNREFUSED. Reserved env-var names
    (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, …) are dropped in `parseFrontendInfraSpec` (they are
    spread over `process.env` at build time, so a binding named `PATH` would break the toolchain).
    A `servePort` colliding with 8080 (harness job server) or 8089 (WireMock) falls back to 4173 in
    `testerInfraSpec`. Shared `pathExists` (`fs-utils.ts`) + `captureRedactedOutput` (`redact.ts`)
    helpers replace the per-file copies.
  - **`ui`-image routing is still the remaining deploy-time step** (unchanged by slice 3, see
    `Dockerfile.ui`). Both Cloudflare and local use a per-RUN container with a single image, so
    `image: 'ui'` per-step routing isn't wired (a run's first step fixes the image; later steps
    re-attach). Slice 3 added the frontend tooling to the `ui` variant and bumped the image
    (1.28.0) so it's ready; actually routing `tester-ui` to that image (a Cloudflare `[[containers]]`
    class + a per-step image seam on the transports) is a separate follow-up, tracked here.
  - **WireMock mappings convention:** `mockMappingsPath` (default `mocks/`) is WireMock's
    `--root-dir` (it reads `<root>/mappings` + `<root>/__files`). A missing dir is non-fatal —
    WireMock still binds its port (unmatched requests 404, gentler than ECONNREFUSED).
- Slice 4 conventions & gotchas:
  - **`pl_frontend` is a step order, not new engine machinery.** Slice 3 wired all the frontend
    infra (`context.frontend` resolution, `testerInfraSpec` → the harness `frontend` spec, the
    tester-infra start gate). The pipeline (`coder → reviewer → mocker → tester-ui → conflicts →
ci → merger`, in `seed.ts`) just orders the steps that exercise it, so `pl_frontend` needed no
    facade/persistence changes and stays runtime-neutral by construction. It is labelled
    `experimental` for the same two reasons the pipeline comment names: the `ui`-image per-step
    routing (above) and the live-service env keying (slice 4b) both remain.
  - **The mocker is frontend-aware via the USER prompt, not a second system prompt.** `mocker`
    isn't a standard phase, so it flows through the generic `buildBaseUserPrompt`; the new
    `mockFrontendSection(context)` (agents `prompts/mock.js`) is appended there exactly like
    `testerEnvironmentSection`, keyed on `context.frontend` being present. The mocker's system
    prompt (`mock.ts` `SYSTEM_PROMPT`) is unchanged and is NOT under version control in
    `versions.ts`, so no prompt-version bump was needed. Keep the section in lock-step with
    `buildFrontendInfraSpec` (server): the upstreams to mock are the resolved bindings with **no**
    `serviceUrl` (a `mock` source, or a `service` with no live env); a binding WITH a `serviceUrl`
    is the real service under test and must NOT be mocked.
  - **Slice 4b (the deferred deployer-keying) is the live-binding enabler.** The frame-id ⇄
    task-id gap above still holds: a `deployer` keys the env under the task `block.id` it ran on,
    so `resolveFrontendConfig`'s `handle.blockId === serviceBlockId` (a service FRAME id) never
    hits and a live `service` binding resolves to WireMock. Making a service frame's ephemeral env
    resolvable by the FRAME id is a genuine cross-runtime change (it touches env keying + likely a
    D1 ⇄ Drizzle registry column + the mothership allow-list + a conformance/e2e assertion), so it
    was split OUT of this slice as **4b** rather than rushed in alongside the runtime-neutral
    pipeline + prompt. `pl_frontend` runs fully self-contained for a mock-only frontend today; the
    live-env e2e assertion lands with 4b. Do it as a deployer-keying change, NOT a reverse-walk
    hack in `resolveFrontendConfig`.
  - **Visual pipelines are frame-gated as of slice 4c (below).** `pl_frontend` / `pl_visual` (any
    pipeline with a `tester-ui` / `visual-confirmation` step) are now refused at run start unless
    the task's frame is a `frontend` frame or a frame a frontend links to.
  - **The frontend mocker default lives in one place.** `DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH`
    (`@cat-factory/contracts`) is the single backend source of truth for WireMock's default
    `--root-dir` (`mocks/`); the mocker prompt imports it instead of a private literal. The harness
    keeps its own literal copy (`frontend-infra.ts` `DEFAULTS`) because changing it is an image-tag
    bump — keep the two in lock-step.
- Slice 4b conventions & gotchas:
  - **An env is keyed by BOTH the task `block_id` AND the service `frame_id` — additive, not a
    re-key.** The `deployer` still records `block_id` (the task it ran on), so the same-block
    deployer→tester env projection (`RunDispatcher.attachEnvironmentProjection` /
    `getHandleForBlock(instance.blockId)`) and per-task env supersede semantics are UNCHANGED. The
    new `frame_id` column (`environments`, D1 `0030` ⇄ Drizzle `environments.frame_id`) is the
    cross-frame discovery key: `RunDispatcher.deployerProvisionArgs` walks the block to its service
    frame (`contextBuilder.resolveServiceFrameId`) and passes `ProvisionArgs.frameId`;
    `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read by
    `handle.frameId` (NOT `blockId`) so a `frontend` frame's `service` binding — whose
    `serviceBlockId` names a service FRAME — resolves to the live env. Do NOT re-key `block_id` to
    the frame: it would break the tester lookup and collapse per-task envs.
  - **`buildEnvironmentRecord` fans `frameId` in on BOTH the provisioned AND the failed-record
    paths** (`recordProvisioned` + `persistFailedEnvironment`), so a failed deploy still carries
    the frame it belonged to. Adding a required field to `EnvironmentRecord` makes every direct
    constructor (only the in-memory test fake today) supply it.
  - **The cross-runtime assertion is a positive mirror of the slice-3 refusal test.** Where slice
    3 asserted a frontend UI-tester with NO live service is refused (`frontend-no-live-service`),
    slice 4b asserts that provisioning the bound service's env (via a `deployer` on a task inside
    its frame) lets the same UI-tester run START — pinning both the `frame_id` D1 ⇄ Drizzle
    round-trip and the frame-keyed resolution. The happy-path binding→URL math stays covered by the
    `resolveFrontendBindings` unit tests. A full browser-driving live-env e2e (the assembled SPA
    round-trip) was NOT added here — the conformance start-gate assertion is the runtime-neutral
    proof; an e2e that stands a real live backend up is a heavier, separate add.
  - **`pl_frontend` stays `experimental` — but now for ONE reason, not two.** The live-service
    keying caveat in its `seed.ts` comment is resolved; only the `ui`-image per-step routing
    remains (still slice-3's deferred deploy-time step). Keep the label until that lands.
- Slice 4c conventions & gotchas:
  - **The gate keys off a "visual step", NOT a pipeline id or a frame `type` alone.** A pipeline is
    "visual" when it carries `tester-ui` OR `visual-confirmation` (`pipelineHasVisualStep`,
    `@cat-factory/contracts`) — so it captures `pl_frontend`, `pl_visual`, AND any custom pipeline
    that adds a UI-testing step, without an id allow-list. The allowed frames are a `frontend` frame
    OR a frame a frontend LINKS to (`frameAllowsVisualPipeline`): the manual visual-confirmation
    flow reviews reference designs + screenshots uploaded to the TASK, so it does NOT need the
    self-contained frontend infra — a backend `service` that a frontend binds is a legitimate host
    for it. Hence the rule is "has a UI to exercise", not "is a `frontend` frame".
  - **One shared predicate, two consumers.** The pure predicates live in `@cat-factory/contracts`
    (imported by the backend gate AND the SPA surface) so the "what's offered" and "what's allowed"
    can't drift. The canonical `UI_TESTER_AGENT_KIND` / `VISUAL_CONFIRM_AGENT_KIND` slugs moved to
    contracts too; `ci.logic` re-exports them (all existing importers unchanged).
  - **The gate is a run-start guard, not a save-time or task-create validation.** Pipelines stay
    frame-agnostic templates; `ExecutionService.assertPipelineFrameTypeAllowed` (a new
    `visual_pipeline_no_frontend` conflict) enforces it BEFORE any side effects, alongside the
    tester-infra / binary-storage guards, so it holds for manual starts, recurring fires, and
    direct API calls alike — the SPA picker filtering is only a hint. It reads the workspace block
    list ONCE for the frontend→service links (no per-frame point read). Ordered FIRST among the
    tester-related guards so a wrong-frame run gets the precise "no UI" error, not a downstream one.
  - **`frontend_config` is read during the gate, so it's a cross-runtime parity surface.** The
    conformance suite refuses a visual pipeline on a bare service frame and then, after a frontend
    binds that service, lets the same run START — a facade that dropped/mismapped `frontend_config`
    would find no link and refuse the allowed case. The three existing visual-confirmation
    conformance tests (which ran on `task_login` under the bare `blk_auth` service frame) now link
    the seeded `blk_frontend` frame to `blk_auth` first, so they satisfy the gate.
  - **Surface is applied at every pipeline picker**, keyed off the block's enclosing frame
    (`board.serviceOf`) + the board's frontend→service links: task-create (`AddTaskModal`),
    run-settings (`TaskRunSettings`), the run launchers (`InspectorPanel` / `BlockFocusView`), and
    the recurring schedule (`RecurringPipelineModal`). A new pipeline picker MUST reuse
    `pipelineAllowedForFrame` (`~/utils/pipeline`) so it stays consistent with the gate.
