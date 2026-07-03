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

| #   | Slice                                                                                             | Status | PR                                                        |
| --- | ------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| 1   | Repo type selector + `library`/`document` types + task/pipeline gating                            | done   | [#605](https://github.com/kibertoad/cat-factory/pull/605) |
| 2   | `frontend` block + `frontendConfig` + inspector + board links + persistence/symmetry              | done   | [#609](https://github.com/kibertoad/cat-factory/pull/609) |
| 3   | Harness frontend infra + `ui` image bump + `testerInfraSpec` wiring + conformance                 | done   | [#615](https://github.com/kibertoad/cat-factory/pull/615) |
| 4   | Mocker frontend awareness + `pl_frontend` pipeline                                                | done   | [#629](https://github.com/kibertoad/cat-factory/pull/629) |
| 4b  | Deployer service-frame env keying → live-service binding resolves + live-env e2e                  | done   | [#633](https://github.com/kibertoad/cat-factory/pull/633) |
| 4c  | Surface/gate visual pipelines (`tester-ui`/`visual-confirmation`) to frames with a UI             | done   | [#636](https://github.com/kibertoad/cat-factory/pull/636) |
| 5a  | `frontendPreview` infrastructure capability + SPA toggle gate (Worker unsupported)                | done   | [#638](https://github.com/kibertoad/cat-factory/pull/638) |
| 5b  | Harness `preview` mode — build+serve kept alive (the serve mechanic's container half)             | done   | [#641](https://github.com/kibertoad/cat-factory/pull/641) |
| 5c  | Transport preview dispatch (host-port publish) + `PreviewService`/controller + stop               | done   | [#641](https://github.com/kibertoad/cat-factory/pull/641) |
| 5d  | SPA preview surface (frame-inspector URL + start/stop) on the frame inspector                     | done   | [#641](https://github.com/kibertoad/cat-factory/pull/641) |
| 6a  | Reverse CORS origin injection (`{{input.frontendOrigins}}`) + binding dedup correctness           | done   | this PR                                                   |
| 6b  | Inspector resolved-binding visibility (envVar → service → live URL/mock) + run-detail + soft note | done   | this PR                                                   |
| 6c  | Pin local preview host port (deterministic preview origin) + fold into `frontendOrigins`          | todo   | (its own PR)                                              |

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
- Slice 5a conventions & gotchas:
  - **`frontendPreview.supported` is a NEW infrastructure-capability axis, not an `ExecutionService`
    dependency.** It rides the SAME `/auth/config` `infrastructureCapabilitiesSchema` descriptor as
    `execution`/`testEnv` (`contracts/routes/auth.ts`), built by the shared
    `buildInfrastructureCapabilities` (`server/config/infrastructure.ts`) so all three facades emit
    the same shape. It is a genuine per-facade **value** differentiator (Worker `false` — it only
    runs the self-contained UI-test container that is torn down with the run; Node + local `true` —
    they keep a built app served on a host-reachable URL). Deliberately NOT modelled like
    `localTestInfraSupported` (a `CoreDependencies` flag feeding a run-start gate): a browsable
    preview is a topology capability the SPA reads to gate the `previewEnabled` TOGGLE, not a
    per-run infra precondition — so there is no `assertTesterInfraConfigured`-style engine gate for
    it (adding a dead `CoreDependencies` field would be worse than the capability descriptor the
    SPA actually consumes). The cross-runtime conformance suite pins only that the axis is present +
    boolean (its value is a facade differentiator); the Worker `auth.spec` pins `false`, the Node
    `auth-gate.spec` pins `true`.
  - **The SPA gate is a disable-with-hint, not a hard removal.** `FrontendConfig.vue` reads
    `useAuthStore().infrastructure?.frontendPreview?.supported` (defaulting true until the auth
    handshake resolves so the toggle isn't briefly disabled on a runtime that DOES support it) and,
    when unsupported, disables the `previewEnabled` checkbox + swaps the hint for
    `inspector.frontendConfig.previewUnsupported`. `frontendConfig` is still persisted untouched, so
    a config authored on local/node and later served from the Worker keeps its `previewEnabled` flag
    (inert there) rather than being silently stripped — pre-1.0 breakage rules mean the flag just
    does nothing on the Worker, no migration.
  - **The deferred serve mechanic (originally "5b") is split into 5b/5c/5d.** 5a landed the
    capability + the honest toggle gate; the long-lived build+serve+mock kept ALIVE (vs
    `standUpFrontend`'s tear-down-with-the-run), the host-reachable URL surfaced to the SPA, and a
    stop control are the remaining work. It was split by layer so each slice is independently
    testable in this repo's toolchain (the harness runs pure vitest; the transport/backend need the
    Postgres/conformance harness; the SPA is a thin follow-up): **5b** = the harness `preview` mode
    (this PR); **5c** = the container-transport preview dispatch + the backend `PreviewService` +
    controller + persistence + server-side gate + conformance; **5d** = the SPA frame-inspector
    surface.
- Slice 5b conventions & gotchas:
  - **`preview` is a THIRD harness `mode`, not a new job kind.** It rides the same generic `agent`
    job (`server.ts` `KINDS.agent`) and the same `standUpFrontend` the `tester-ui` explore flow
    uses — the ONLY differences are (a) no agent runs and (b) the serve / WireMock processes are
    deliberately NOT torn down when the handler returns. Because the stand-up children are plain
    `spawn`ed children of the harness process (not tied to the run's abort signal) and the transport
    does not remove the container until an explicit stop, they keep serving after the job completes.
  - **A preview cannot use `withWorkspace`/`acquireRepoCheckout`.** Those remove the temp checkout in
    a `finally` the moment the handler returns, which would delete the files a `static`-mode server
    serves (and pull the cwd out from under a `command`-mode dev server). `runPreviewMode` clones
    into a bare `mkdtemp` dir it does NOT remove on success; the single-purpose preview container
    reclaims it on stop. A FAILED preview tears the partial stand-up down AND removes the dir, so a
    failed attempt leaks neither processes nor disk.
  - **A preview must actually come up — no "test what you can" fallback.** Unlike the tester (where a
    stand-up problem is a non-fatal prompt note), a preview with no reachable serve URL is a hard
    failure (`no-usable-output`), with the stand-up `note` folded into the reason. App-up-but-
    WireMock-down rides along as a soft warning on the success. The boundary is the pure
    `buildPreviewOutcome` (unit-tested), mirroring how `buildInfraNotes` is extracted + tested.
  - **The `preview.url` in the result is the IN-CONTAINER url** (e.g. `http://localhost:4173`), not
    host-reachable on its own. 5c's transport publishes the serve port to an ephemeral host port
    (reuse the docker adapter's `docker port` read, exactly as it does for the 8080 harness port) and
    forms the browsable URL from that; the harness url is echoed for logging/context only.
  - **Image bump (1.29.0):** the `src/**` change ships in the runner image, so the harness `version`
    - the three hand-maintained pins were re-synced via `pnpm sync:image-tags` (guard:
      `node scripts/check-runner-image-tag.mjs`). 5c/5d do not touch the harness and need no further bump.
  - **5c (transport + backend) design to pick up (do NOT re-derive):** drive `mode:'preview'` from a
    dedicated preview dispatch on the local/node container transport that (a) publishes the
    `servePort` to an ephemeral HOST port (local mode's `ContainerRuntimeAdapter` already does exactly
    this for the harness job port — reuse `docker port`; add a second published port + an
    `endpoint(id, port)` lookup) and (b) does NOT stop the container until an explicit stop. Persist
    the running preview like an ephemeral `environments` row (it already carries `url`/`status`/
    `frameId` + a stop path) keyed by the `frontend` frame — but note `EnvironmentTeardownService`
    calls a provisioning `provider.teardown`, which a preview has none of, so `PreviewService.stop`
    owns its stop (transport stop + registry `softDelete`) rather than reusing that service verbatim.
    Gate the whole flow on `frontendPreview.supported` server-side (a start/provision guard), since 5a
    only gates the SPA toggle. Keep it a local/node differentiator — the Worker never wires the
    preview dispatch. **5d** then surfaces the clickable URL + a stop button on the frame inspector.
- Slice 5c conventions & gotchas:
  - **The runtime-neutral half is symmetric; only the TRANSPORT is per-runtime.** `PreviewTransport`
    (`kernel/ports/preview-transport.ts`) is a NEW optional port — a runtime-specific mechanic
    (publish a served-app port to the host + keep the container alive), legitimately absent on
    runtimes without a host-port-publish primitive, exactly like the Cloudflare-Container-only
    execution path. Everything else IS runtime-neutral and lands on ALL facades: `PreviewService`
    (a `Core` module, `orchestration/modules/preview`), the `PreviewController` + the three
    `/workspaces/:ws/frames/:frameId/preview` routes (start/get/stop), and the capability gate. The
    cross-runtime conformance suite drives the full lifecycle on BOTH Postgres runtimes with a
    `FakePreviewTransport` + `fakeBuildPreviewJob` (the parallel of `FakeAgentExecutor` standing in
    for a real container), pinning the ephemeral-`environments`-row persistence parity.
  - **Reuse the `environments` table — NO new table/migration.** A running preview is persisted as an
    `environments` row (`provisionType: 'preview'`, `blockId === frameId ===` the `frontend` frame,
    `expiresAt: null` so the expiry cron never sweeps it). `getByBlock(ws, frameId)` finds it, guarded
    by the `provisionType === 'preview'` discriminator so it can't be confused with a deployer env (a
    deployer env keys `blockId` = the TASK, not the frame). `stop` owns its teardown — transport stop +
    registry `softDelete` — NOT `EnvironmentTeardownService` (which resolves a `provider.teardown` a
    preview has none of). No `frontend_config`-gating on the row; the module gates instead.
  - **`get` re-polls the transport ONLY while `provisioning`.** Once served, the persisted host URL is
    authoritative (the container keeps serving; a lost preview is simply re-started). This also spares
    the transport a serve-port lookup it can only satisfy within the starting process — the in-memory
    `frameId → { containerId, servePort }` cache (needed to read `docker port <id> <servePort>`) is not
    durable, which is fine for a dev-convenience preview.
  - **The adapter grew two symmetric knobs** (`ContainerRuntimeAdapter`): `RunContainerSpec.publishPorts`
    (Docker publishes each with a second `-p 127.0.0.1:0:<port>`; Apple ignores it — its per-container
    IP reaches any port directly) and `endpoint(exec, id, port?)` (Docker `docker port <id> <port>/tcp`;
    Apple returns `{ host: containerIP, port }`). The harness job id inside a preview container is the
    constant `PREVIEW_HARNESS_JOB_ID = 'preview'` (single-purpose container ⇒ no cross-layer id to
    thread). A preview container is labelled with a synthetic `preview-<frameId>` run id.
  - **The harness needs NO change (no image bump).** `runPreviewMode` (5b) already accepts the preview
    job absent the agent-only fields but STILL requires `proxyBaseUrl` + `sessionToken` (its auth parser
    runs before dispatch). No LLM runs, so `makePreviewJobBuilder` mints a benign, model-agnostic session
    token purely to satisfy the parser — never used for a call. The builder is the server-layer seam
    (`@cat-factory/server` `preview/previewJobBuilder`) reusing the SAME repo/token/session resolution
    the container executor uses; `buildNodeContainer` constructs it from those seams whenever a preview
    transport is injected (unless one is injected via `overrides` — the conformance fake).
  - **Node advertises `frontendPreview.supported: true` (5a) but the bare Node deployment wires no
    preview transport yet** (its runner is a self-hosted K8s pool with no host-port-publish primitive; a
    K8s-ingress-backed preview transport is a follow-up). So on a stock Node-with-pool deployment the
    preview module is unwired and the controller 503s despite the capability — consistent with the other
    "Node follow-up" gaps in this initiative. Local mode wires the real Docker/Apple transport today.
    The capability stays a topology statement per the landed 5a decision (not re-litigated here).
- Slice 5d conventions & gotchas:
  - **Live preview state is a store, NOT `frontendConfig`.** `frontendConfig.previewEnabled` is the
    persisted per-frame TOGGLE (saved via `board.updateBlock`); the LIVE preview (a running container +
    its host URL) is a separate runtime resource in `usePreviewStore` (`stores/preview.ts`), keyed by
    frame id, over the three preview endpoints (a new `previewApi` client group registered in `useApi`).
    The store self-polls (2.5s) while a preview is `starting` and stops on any terminal state.
  - **The surface lives INSIDE `FrontendConfig.vue`, under the `previewEnabled` toggle** — shown only
    when `previewSupported && previewEnabled` (so an unsupported runtime / a disabled toggle shows
    nothing). Start/stop buttons + a clickable "Open preview" external-link button on `ready`; the status
    label is a runtime-built key guarded by an exhaustive `Record<PreviewStatus, key>` (i18n tier-2, the
    keys read as "unused" by `vue-i18n-extract` exactly like the `errors.conflict.title.*` set — expected).
  - **All new copy is translated in every locale** (`inspector.frontendConfig.preview.*`, added to
    en/es/fr/he/ja/pl/tr/uk) to satisfy the locale-parity CI gate. `data-testid`s
    (`preview-panel`/`preview-status`/`preview-url`/`preview-start`/`preview-stop`) are in place for a
    future e2e — none was added here (the e2e backend runs GitHub + Docker OFF, so a real preview can't
    stand up there; the conformance suite is the runtime-neutral proof).
- Slice 6a conventions & gotchas (reverse CORS origin injection + binding correctness):
  - **Forward binding resolution is per-binding-correct and now deterministic.** Each operator-named
    `envVar` independently resolves its bound service FRAME's live env URL
    (`indexLiveServiceEnvUrls`, newest-wins, one `listByWorkspace` read — no N+1). Two bindings sharing
    a (non-empty) `envVar` now resolve to the LAST one (`resolveFrontendBindings` maps by `envVar`), not
    left to insertion order; `duplicateBindingEnvVars` (`@cat-factory/contracts`) surfaces the collision
    for the inspector + a run-start note (slice 6b). NOT a `frontendConfigSchema` `v.check` — bindings
    persist per-blur and allow empty `envVar`, so a schema reject would 422 a mid-edit PATCH.
  - **`frontendOriginsForService` is the REVERSE of `backendBindings`, mirroring
    `frameAllowsVisualPipeline`.** It scans the workspace block list once for `frontend` frames that
    bind a service (non-empty `envVar`) and emits each one's tester origin `http://localhost:<servePort
?? DEFAULT_FRONTEND_SERVE_PORT>`. A deployer step passes the comma-joined result as
    `inputs.frontendOrigins` (`RunDispatcher.frontendOriginsInput`, keyed by the service frame id it
    already resolves), so the backend's provisioning can fold the origins into its CORS allow-list.
  - **TWO template syntaxes depending on the provider — document both.** The HTTP-manifest provider
    interpolates `{{input.frontendOrigins}}` (the `{{input.*}}` namespace); the Kubernetes native
    adapter renders `{{frontendOrigins}}` FLAT (its `templateVars` spreads all provision inputs, like
    `{{branch}}`/`{{namespace}}`). Same value, different placeholder — an operator authoring a
    `secretInjections.valueTemplate` / helm `--set` uses `{{frontendOrigins}}`.
  - **Deployer-path only; the operator still authors the mapping and must re-provision.** Injection is
    wired into `deployerProvisionArgs` (the frame-keyed env a frontend binds), NOT the HumanTest
    controller manual env (which isn't frame-keyed, so a frontend can't bind it anyway — a separate
    change if ever needed). Automated: origin derivation + the `frontendOrigins` input. Manual: the
    operator maps `{{…frontendOrigins}}` into their CORS (and any OAuth-callback) env var in their
    manifest, and re-provisions the backend to pick up a newly-linked frontend or a changed servePort
    (CORS is baked at provision time). For zero-config local dev, a `localhost`-wildcard CORS default
    avoids re-provision; exact-origin injection is the recommended path.
  - **Deferred to 6b/6c (do NOT re-derive):** 6b surfaces the resolved `envVar → service frame → live
URL | mocked` mapping in `FrontendConfig.vue` (one workspace-environments read indexed by frameId, a
    SPA mirror of `indexLiveServiceEnvUrls`) + the `duplicateBindingEnvVars` warning, projects the
    resolved bindings into the run/step detail, and adds a non-fatal run-start note (mirror the harness
    `buildInfraNotes`) for the partial-live / duplicate-envVar cases. 6c pins the LOCAL preview to a
    deterministic host port (widen `RunContainerSpec.publishPorts` to `{ container, host }`; Docker
    emits `-p 127.0.0.1:<host>:<container>`; `LocalPreviewTransport` forms the URL from it) so the
    browsable-preview origin is knowable ahead of provision, then extends `frontendOriginsForService` to
    emit it when `previewEnabled`. **Apple asymmetry:** Apple reaches the container IP directly, so its
    preview origin is `http://<containerIP>:<servePort>`, not `localhost` — only the Docker adapter
    yields a pinnable localhost origin.
  - **Follow-up conformance:** a full provision-with-request-capture assertion (a manifest whose
    `bodyTemplate`/`secretInjections` renders `frontendOrigins`, with a frontend frame bound, asserting
    the captured value on both Postgres runtimes) lands with 6b. 6a pins the operator contract with unit
    tests on `frontendOriginsForService` + both render syntaxes (`interpolateTemplate` /
    `renderTemplate`∘`templateVars`).
- Slice 6b conventions & gotchas (resolved-binding visibility + run-detail projection + run-start note):
  - **The pure binding-resolution helpers now live in `@cat-factory/contracts`, NOT orchestration.**
    `resolveFrontendBindings` / `indexLiveServiceEnvUrls` / `boundServiceFrameIds` / the
    `ResolvedFrontendBinding` + `LiveEnvHandle` types / the new `buildFrontendRunNotes` moved next to
    `frontendOriginsForService` so the SPA and the backend import the SAME resolution (they can't drift on
    which env a live `service` binding resolves to). `frontend-infra.logic.ts` (orchestration) now just
    RE-EXPORTS them + keeps the two gate-only predicates (`hasLiveServiceBinding` / `hasServiceBinding`),
    so every existing importer is unchanged. A new SPA consumer imports from `@cat-factory/contracts`
    directly, not from orchestration.
  - **Both the resolved bindings AND the run-start note are persisted on the RUN, in the `detail` JSON — no
    migration.** `ExecutionInstance.notes?: string[]` and `ExecutionInstance.frontendBindings?:
ResolvedFrontendBinding[]` ride in `agent_runs.detail` (like `failureHistory`), so both stores round-trip
    them through the shared `@cat-factory/server` mapper (`executionToDetail` / `rowToExecution`) with ZERO
    schema change (`frontendBindings` is parsed with a tolerant `is(resolvedFrontendBindingSchema, …)` filter,
    like the failure parsers). Computed ONCE at start (`ExecutionService.start` →
    `AgentContextBuilder.resolveFrontendRunInfo`), gated on `pipelineHasVisualStep` so only a visual pipeline
    pays the extra env read; a non-frontend run carries neither. Both reflect the START-time resolution (they
    don't re-derive when envs later change) — the honest historical advisory, mirroring the harness's own
    `buildInfraNotes`. Note cases: duplicate env vars, and a partial-live set (some bound services live, others
    fall back to WireMock). A frontend with NO live bound service is refused at the gate, so that case never
    produces a note.
  - **`resolveFrontendConfig` and `resolveFrontendRunInfo` share ONE resolution** (`resolveFrontendResolution`),
    so the agent-context path and the run-info path read `listHandles` the same way (still one query, no N+1).
    `resolveFrontendRunInfo` returns `{ bindings, notes }` and BOTH are stamped on the run — the resolved-binding
    TABLE in the `tester-ui` run/step detail projects the FROZEN `instance.frontendBindings` (what the run
    actually drove against), so a completed run's detail stays truthful after its envs are torn down instead of
    silently disagreeing with the co-located start-time note. (The frame INSPECTOR still resolves LIVE — it's
    showing current state, not a past run.)
  - **The SPA resolved-binding view is one shared component with two modes.** `FrontendBindingsResolved.vue`
    takes an optional `resolved?: ResolvedFrontendBinding[]` prop: when OMITTED (the `FrontendConfig.vue`
    inspector) it resolves LIVE against the workspace env handles via the new lightweight `useEnvironmentsStore`
    (`GET /workspaces/:ws/environments`, load-on-open, no snapshot delivery / no self-poll) and shows the
    duplicate-envVar warning (`duplicateBindingEnvVars`); when PROVIDED (a `tester-ui` step's `AgentStepDetail.vue`,
    fed `instance.frontendBindings`) it renders those FROZEN bindings and leaves the duplicate advisory to the
    run-start note. Both modes feed the SAME `resolveFrontendBindings` / `indexLiveServiceEnvUrls` the backend
    uses, and join off the LAST config binding per envVar (matching the last-wins dedup) purely to LABEL a mocked
    upstream as `mock` vs `service-offline`. The run-start note itself renders on ANY step detail of a
    frontend-frame run (it's a whole-run fact), not only the `tester-ui` step.
  - **Conformance uses a capturing FAKE provider, not a real fetch.** The 6b conformance test injects an
    `environmentProvider` whose `provision(req)` captures `req.inputs.frontendOrigins` (the manifest carries a
    `bodyTemplate` documenting where the operator folds it in; the render itself is unit-tested in 6a). This is
    the runtime-neutral proof that BOTH stores read `frontend_config` to DERIVE the origins — stubbing global
    `fetch` across workerd + node was avoided deliberately. The same test then starts a UI-tester run and asserts
    both the duplicate-env-var `notes` AND the frozen `frontendBindings` (the live `service` binding resolved to
    the auth env URL) round-trip through a fresh snapshot read (`agent_runs.detail` D1 ⇄ Drizzle).
    Skipped on `mothership` (its env connect/provision write surface is unproxied), like the sibling 4b test.
  - **6c is unaffected.** The local-preview host-port pinning + folding the preview origin into
    `frontendOriginsForService` remains the last open slice; nothing here touches the preview transport.
