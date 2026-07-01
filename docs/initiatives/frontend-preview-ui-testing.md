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

| #   | Slice                                                                                | Status      | PR        |
| --- | ------------------------------------------------------------------------------------ | ----------- | --------- |
| 1   | Repo type selector + `library`/`document` types + task/pipeline gating               | in-progress | (this PR) |
| 2   | `frontend` block + `frontendConfig` + inspector + board links + persistence/symmetry | todo        | —         |
| 3   | Harness frontend infra + `ui` image bump + `testerInfraSpec` wiring + conformance    | todo        | —         |
| 4   | Mocker frontend awareness + `pl_frontend` pipeline                                   | todo        | —         |
| 5   | Browsable preview (local/node) + `frontendPreviewSupported` capability gate          | todo        | —         |

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
- Bootstrap retry with no existing frame currently defaults the frame type to `service` (the
  chosen type is not yet persisted on the `bootstrap_jobs` row). Persist it in slice 2 when the
  bootstrap persistence is touched.
- Keep the runtimes symmetric: the self-contained UI-test path is runtime-neutral and must land
  on Cloudflare + Node/local + pool together with a conformance assertion. The browsable preview
  is a genuine local/node differentiator, capability-gated (`frontendPreviewSupported`).
- Any change to the runner image (slice 3: WireMock + JRE + static server + pnpm in the `ui`
  variant) MUST bump `@cat-factory/executor-harness` and the image tag in `deploy/backend`.
