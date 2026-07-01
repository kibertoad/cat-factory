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

| #   | Slice                                                                                | Status | PR                                                        |
| --- | ------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------- |
| 1   | Repo type selector + `library`/`document` types + task/pipeline gating               | done   | [#605](https://github.com/kibertoad/cat-factory/pull/605) |
| 2   | `frontend` block + `frontendConfig` + inspector + board links + persistence/symmetry | done   | [#609](https://github.com/kibertoad/cat-factory/pull/609) |
| 3   | Harness frontend infra + `ui` image bump + `testerInfraSpec` wiring + conformance    | done   | (this PR)                                                 |
| 4   | Mocker frontend awareness + `pl_frontend` pipeline                                   | todo   | —                                                         |
| 5   | Browsable preview (local/node) + `frontendPreviewSupported` capability gate          | todo   | —                                                         |

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
    frontend branch: a `frontend` frame is refused (`frontend-no-live-service`) unless at least
    one bound service has a LIVE ephemeral env (the service under test). It is decided BEFORE the
    backend provision-type branch and passes through when the env seam is unwired (tests). The
    cross-runtime conformance asserts this refusal (a facade that dropped `frontend_config` would
    let the run start instead) — the D1 ⇄ Drizzle parity of reading the column during a run.
  - **Env keying (carried forward):** a binding's `service` source resolves the live env by the
    bound block id directly (the design's `getHandleForBlock(serviceBlockId)` semantics). Today a
    `deployer` keys the env under the block it ran on (a task, `block.id`), so wiring HOW a service
    frame's ephemeral env becomes resolvable by the FRAME id it's bound to is part of the
    end-to-end `pl_frontend` flow (slice 4) + manual verification. The happy-path binding→URL math
    is covered by the `resolveFrontendBindings` unit tests; the live-env e2e assertion lands with
    slice 4.
  - **`ui`-image routing is still the remaining deploy-time step** (unchanged by slice 3, see
    `Dockerfile.ui`). Both Cloudflare and local use a per-RUN container with a single image, so
    `image: 'ui'` per-step routing isn't wired (a run's first step fixes the image; later steps
    re-attach). Slice 3 added the frontend tooling to the `ui` variant and bumped the image
    (1.28.0) so it's ready; actually routing `tester-ui` to that image (a Cloudflare `[[containers]]`
    class + a per-step image seam on the transports) is a separate follow-up, tracked here.
  - **WireMock mappings convention:** `mockMappingsPath` (default `mocks/`) is WireMock's
    `--root-dir` (it reads `<root>/mappings` + `<root>/__files`). A missing dir is non-fatal —
    WireMock still binds its port (unmatched requests 404, gentler than ECONNREFUSED).
