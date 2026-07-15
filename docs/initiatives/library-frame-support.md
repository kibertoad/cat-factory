# Initiative: Library frame support (build/test/merge — no deploy, no env, suite-focused testing)

## Goal & rationale

A **library** is a published package (or a monorepo of them): it has a clear public API
surface and deterministic behaviour, it is **never deployed** and needs **no ephemeral
environment**, it gains little from manual/exploratory testing, and its quality story is
**unit + integration tests** — which may still need real infrastructure (a Postgres, a
Redis) that the test suite expects **on localhost**, typically stood up from a repo-local
`docker-compose.yml` via an npm lifecycle convention. The platform already _names_ this
concept — and even documents its intended behaviour — but almost nothing enforces it:

- **`type: 'library'` is a first-class frame type with a documented behavioural contract
  that is not implemented.** `frameRepoTypeSchema`
  (`backend/packages/contracts/src/primitives.ts:27-41`) promises _"`library` — a published
  package (build/test/merge, no deploy/env, no tester infra)"_, and the import/bootstrap
  modals offer it (`useFrameRepoTypeItems.ts`, `AddServiceFromRepoModal.vue`,
  `BootstrapModal.vue`). But a grep for `'library'` across the backend finds exactly ONE
  behavioural branch: `frameAllowsVisualPipeline` (`contracts/src/visual-pipeline.ts:52-66`)
  refuses visual pipelines. Everything else — deployer, tester infra, pipeline defaults,
  provisioning — ignores the type entirely. Nothing even defaults a `library` frame's
  `provisioning` to `infraless` (`BoardService.addServiceFromRepo` at `BoardService.ts:407-412`
  and `BootstrapService.createFrame` just stamp `block.type`), so the documented "no
  deploy/env" behaviour only happens if the user separately, manually configures it.
- **Every default build pipeline is service-shaped.** All of them hard-code
  `… → deployer → tester-api → …` (`pl_full`/`pl_fullstack`/`pl_quick`/`pl_simple`, kernel
  `seed.ts:170-330`), and pipeline selection knows nothing of frame types —
  `defaultPipelineIdForTaskType` (`seed.ts:726`) special-cases only `document` tasks, else
  the workspace **positional-first** pipeline wins (`ExecutionService.ts:2891-2899`). A task
  on a library frame dispatches a deployer (a no-op at best) and an **exploratory** tester.
- **The Tester's posture is wrong for a library.** `TESTER_SYSTEM_PROMPT`
  (`agents/src/agents/prompts/testing.ts:36-43`) is _"meticulous test engineer doing
  EXPLORATORY testing… You actually run the software"_ — built around a running system and
  an environment to probe. A library wants the opposite: run the suite, assess coverage of
  the public API against the change, and **write the missing unit/integration tests**.
- **Tests that need infrastructure have no workable path.** The per-service provisioning
  model routes `docker-compose` through the **Deployer + a workspace handler to an ephemeral
  environment** (`tester-infra.logic.ts:12-20`, `testerInfraSpec` in
  `server/src/agents/prompts.ts:555-596`) — semantically wrong for a library, whose compose
  file is **test dependencies for the suite on localhost** (the suite's config hard-codes
  `localhost:5432`), not a deployable system. The harness's in-container
  `docker compose up -d --wait` path (`standUpInfra`, `executor-harness/src/agent.ts:85-136`,
  with rootless Docker + the compose plugin baked into the image, `Dockerfile:104-119`) is
  exactly the right mechanism — but it is **dormant**: the server never emits
  `{ environment: 'local', composePath }` any more (only `ephemeral`, or `local` +
  `noInfraDependencies: true`). And only tester kinds receive an `infra` spec at all
  (`jobBody.ts:914,940`) — the **coder**, whose delivery contract demands _"run … the tests
  relevant to your change, and get them passing locally"_
  (`prompts/delivery-contract.ts:21-32`), gets no infra and no hint, so it cannot validate a
  change to an infra-needing library.

**Intended end state:** picking `library` at import/bootstrap is sufficient. Any pipeline —
built-in or custom — behaves correctly on a library frame (deploy/env steps skip cleanly,
testers run in a suite-focused library posture), test infrastructure declared the way real
library repos declare it (repo/package-local compose + lifecycle scripts) is stood up
in-container for the agents that need it, and the UI stops offering library-irrelevant
knobs/steps on such frames.

## The reference bar: lokalise/shared-ts-libs

The canonical library-hosting repo this initiative must support end-to-end
(https://github.com/lokalise/shared-ts-libs):

- A **pnpm-workspace + turbo monorepo of ~32 packages** (`packages/app/*`,
  `packages/dev/*`), vitest + biome, releases via **changesets**. No Dockerfile, no k8s
  manifests, no deployable artifact anywhere.
- **Test infra is declared per-package**: 4 of the ~32 packages carry their own
  `docker-compose.yml` next to their source (`drizzle-utils` → Postgres + CockroachDB +
  MySQL; `background-jobs-common` + `healthcheck-utils` → Redis; `prisma-utils` →
  CockroachDB + a migrate-reset step). The suites connect to fixed **localhost** ports.
- **The lifecycle convention carries the infra contract**: `pretest:ci` =
  `docker compose up -d --wait` (+ optional seeding, e.g. prisma migrate), `test:ci` =
  `vitest run --coverage`, `posttest:ci` = `docker compose down`. Packages without infra
  simply run vitest. So `pnpm run test:ci` in a package directory is self-managing —
  **an agent with a Docker daemon needs zero platform-provisioned environment**.
- **CI is per-changed-package** (a changed-files matrix → install/build/lint/`test:ci` per
  Node version). The merge tail cat-factory already has (real GitHub CI gate → merge) works
  unchanged on this repo; it is the agent-side loop (coder validation, tester step) that
  breaks today.

"Support at least this much" therefore means: (1) no deploy/env machinery engaged, (2) the
tester + coder can run a **package-scoped** suite whose compose-declared infra comes up
locally in the job container, (3) monorepo tasks resolve the right package(s), and (4) the
release story is changesets/npm, not deployment.

## Design decision: dedicated pipeline vs smart adjustment

Three options were considered for HOW library behaviour should be delivered:

1. **Dedicated library pipelines auto-picked by default** (a `pl_library_full` /
   `pl_library_quick` family + a frame-type default). Rejected as the primary mechanism:
   it forks the pipeline catalog (every build pipeline needs a library twin that drifts),
   does nothing for user-authored/custom pipelines, and — because pipeline choice is
   per-task — a user picking `pl_full` on a library task would still get the wrong
   service-shaped behaviour. This is the "copy of the machinery" shape CLAUDE.md warns
   against.
2. **Smart adjustment of existing pipelines by frame type** — the engine and prompts adapt
   each step to the frame it runs on. **Chosen.** The engine already works exactly this way
   in three places: the deployer no-ops on `infraless` (`deployer.logic.ts:156-158`), gates
   pass through when unwired, and visual pipelines are refused on UI-less frames
   (`frameAllowsVisualPipeline`). Extending that pattern makes EVERY pipeline correct on a
   library frame, regardless of which one the user picks.
3. **A "capability profile" derived from the frame type** (library ⇒ `deployable: false`,
   `liveTestable: false`, `hasUi: false`, `testPosture: 'suite'`), consumed by the
   deployer/tester/picker predicates instead of scattering `type === 'library'` branches.
   This is the recommended _implementation shape_ of option 2 — one pure
   `frame-profile.ts` in contracts (next to `visual-pipeline.ts`), shared by SPA + engine,
   so the next behavioural frame kind (`document` repos already half-exist, a future
   `cli`/`infra` kind) is a table row, not another grep-for-branches hunt.

A single lean seeded `pl_library` (coder → reviewer → tester → conflicts → ci → merger) is
a **P2 nice-to-have** on top — a better positional default for library-only workspaces —
not the mechanism.

## Target pattern (reference implementations to copy)

- **Frame-type predicate shared by SPA + run-start gate**: `frameAllowsVisualPipeline`
  (`backend/packages/contracts/src/visual-pipeline.ts:52-66`) + its consumption in
  `frontend/app/app/utils/pipeline.ts` and the server-side run-start gate.
- **Step that no-ops cleanly when there is nothing to do**: the deployer's
  `infraless` branch (`orchestration/src/modules/execution/deployer.logic.ts:156-158`) and
  its conformance assertion ("runs an `infraless` deployer step as a no-op … on every
  facade", `internal/conformance/src/suite.ts`).
- **Hard frame-type gate**: `BoardService.assertTaskTypeAllowed`
  (`BoardService.ts:502-505`) — the `document`-frame task restriction.
- **In-container infra stand-up (dormant, to revive)**: `standUpInfra` / `manageInfra`
  (`backend/internal/executor-harness/src/agent.ts:85-176`) driven by
  `{ environment: 'local', composePath }`; the image already ships rootless Docker + the
  compose plugin (`executor-harness/Dockerfile:104-119`), gated by the runtime's
  `localDind` capability + `privilegedTestJobs` (`runtimes/local/src/runtimes/*`).
- **Prompt/spec lock-step pair**: `testerEnvironmentSection`
  (`agents/src/agents/prompts/testing.ts:184-196`) ⇄ `testerInfraSpec`
  (`server/src/agents/prompts.ts:555-596`) — any new run mode must land in both.
- **Deterministic repo detection**: `detectProvisioning`
  (`integrations/src/modules/environments/provision-detect.logic.ts`) — the
  checkout-free, budget-bounded scanner to extend with library signals.
- **Type→default-pipeline seam**: `defaultPipelineIdForTaskType` (kernel `seed.ts:726`).

## Prioritized gap register

Statuses: `todo` / `in-progress` / `done`. Update (+ PR link) at the end of each PR.

### P0 — picking "library" today changes almost nothing (showstoppers)

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Proposed direction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 1   | **`type: 'library'` has no behavioural profile.** The documented contract ("build/test/merge, no deploy/env, no tester infra") is enforced nowhere: no provisioning default, deployer/tester branch only on `provisioning.type`, engine and prompts never consult the frame type (sole exception: visual-pipeline refusal).                                                                                                                                                                                          | Add a pure **frame capability profile** in contracts (`frameProfile(type)` → `{ deployable, liveTestable, hasUi, testPosture }`, beside `visual-pipeline.ts`), consumed by the deployer decision, the tester infra gate, `testerInfraSpec`/`testerEnvironmentSection`, and the SPA pickers. On a `library` frame: deployer records a skip/no-op regardless of `provisioning`, env-consumer gating never demands a handler, tester runs in suite posture (#3).                                                                            | todo   |     |
| 2   | **No workable test-infra path for infra-needing libraries.** `docker-compose` provisioning means "Deployer → workspace handler → ephemeral env" — wrong semantics for compose-as-test-deps (the suite expects localhost). The harness's in-container `standUpInfra` DinD path is dormant (server only ever emits `ephemeral` or `local`+`noInfraDependencies`). Result: on a library frame the tester gets "no infra — just run the suite", and the suite fails on a missing DB.                                     | Introduce a first-class **local test-infra** semantic for library frames: the frame declares (or detection proposes, #6) a repo-relative compose path (+ optional setup command); `testerInfraSpec` emits `{ environment: 'local', composePath }` for library frames so `standUpInfra` runs again; additionally surface the repo's own lifecycle convention (`pretest:ci`/`test:ci`/`posttest:ci`) in the prompt so the agent can self-manage infra where DinD exists. See D1 for the declare-vs-convention split and the DinD caveat. | todo   |     |
| 3   | **Tester posture is exploratory/service-shaped.** `TESTER_SYSTEM_PROMPT` mandates exploratory testing of a running system; `testerEnvironmentSection` narrates run modes in service terms. For a library the correct posture is: install/build, stand up (or lifecycle-run) test deps, run the suite, evaluate unit/integration coverage of the **public API** against the change, author the missing tests on the PR branch.                                                                                        | Add a **library posture** to the tester prompts (a `testPosture: 'suite'` branch of the system prompt + `testerEnvironmentSection`), selected from the frame profile (#1). Same `tester-api` kind and report shape — no new agent kind; the report's greenlight/concern semantics carry over (suite red / coverage hole = blocking concern).                                                                                                                                                                                            | todo   |     |

### P1 — the full agent loop (coder validation, monorepos, detection, selection)

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                              | Proposed direction                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Status | PR  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 4   | **The coder (and ci-fixer) cannot validate an infra-needing library.** `PLATFORM_DELIVERY_CONTRACT` requires tests passing locally, but only tester kinds get an `infra` spec (`jobBody.ts:914,940`) — the coder job carries no compose stand-up and no infra hint, so `vitest` fails on a missing DB and the agent either flails or skips validation.                                                            | Thread the library frame's test-infra spec (#2) into the **coder / ci-fixer / conflict-resolver** job bodies too (same `infra` wire shape, same `standUpInfra`), or at minimum render the lifecycle-convention hint + DinD availability into their prompts so `pretest:ci` is used. Scope stand-up to the affected package(s) in monorepos (#5).                                                                                                                            | todo   |     |
| 5   | **Per-package infra in monorepos has no model.** `provisioning` is frame-level; shared-ts-libs declares compose per package (4 of ~32), with different services/ports. A frame-level compose path cannot express "stand up whatever THIS task's package needs". Detection (`COMPOSE_DIR_CANDIDATES`) also only scans the root + `deploy`/`docker`-style dirs — it never finds `packages/app/drizzle-utils/docker-compose.yml`. | Resolve test infra **package-relative**: locate the package(s) the task touches (module→directory via blueprint `references` / the monorepo service directory), prefer the compose file adjacent to that package, and fall back to the lifecycle convention (`pretest:ci` inside the package dir self-manages). Teach detection to surface per-package compose files on library frames as candidates, not as a deployable-env recommendation.                              | todo   |     |
| 6   | **No library detection or defaults at import/bootstrap/blueprint.** `detectProvisioning` proposes only `kubernetes`/`docker-compose` (a root compose in a library repo would be MIS-proposed as a deployable env); import defaults `type` to `service`; the blueprinter records the frame `type` but nothing about test posture/infra; nothing suggests "this looks like a library" (publishable `package.json`, changesets, no Dockerfile/k8s, workspace of packages).                                        | Add library signals to the deterministic detector (publish-shaped `package.json`(s) + `.changeset/` + absence of deploy artifacts ⇒ recommend `library` + the per-package compose candidates as **test infra**, not provisioning); pre-select the type in the import/bootstrap modals from the recommendation (user always confirms). Blueprint: record per-module test-infra references where present.                                                                     | todo   |     |
| 7   | **Pipeline selection ignores frame type.** `defaultPipelineIdForTaskType` handles only `document`; the positional-first fallback can hand a library task any service pipeline. With #1-#3 landed the damage is contained (steps adapt), but selection/pickers still offer misleading choices (e.g. `pl_fullstack` with playwright/UI steps).                                                                        | Extend the picker/run-start predicate (the `frameAllowsVisualPipeline` pattern, generalised over the frame profile) so pipelines whose steps cannot apply on a library frame are filtered/refused with an actionable message; optionally add a frame-type-aware default (task on a `library` frame with no pin ⇒ the leanest applicable build pipeline).                                                                                                                    | todo   |     |

### P2 — polish, release story, guard-rails, coverage

| #   | Gap                                                                                                                                                                                                                                                                                                                                        | Proposed direction                                                                                                                                                                                                                                                                                    | Status | PR  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- |
| 8   | **Library-irrelevant steps and panels are still offered.** `mocker` (WireMock env mocks) and `human-test` presuppose a running system; `post-release-health` is deployment-shaped (harmless pass-through, but noise); the inspector shows env-oriented panels (`ServiceTestConfig` provisioning, release-health) on library frames.        | Frame-profile-gate these: skip/no-op `mocker`/`human-test` on library frames with a recorded reason (deployer-style); hide or re-label the env-shaped inspector panels for `type: 'library'` (the `InspectorPanel.vue` sections are already `block.type`-conditioned — copy the `frontend`/`service` gating). | todo   |     |
| 9   | **The release story is npm/changesets, not deployment.** A library PR conventionally needs a changeset (shared-ts-libs CI enforces it); no prompt tells the coder that, and nothing maps "release" to publish for library frames.                                                                                                          | Detect a changesets setup (`.changeset/config.json`) and render a "add a changeset for released-package changes" directive into the coder prompt on library frames. Treat publish-pipeline support (npm provenance, release PR awareness) as a separate follow-up initiative — out of scope here.       | todo   |     |
| 10  | **Doc/prompt drift around the old local-infra model.** CLAUDE.md still describes `localTestInfraSupported`/"limited mode" steering in `tester-infra.logic.ts` (removed); `testerEnvironmentSection` narrates `docker-compose` as "stood up on localhost" while `testerInfraSpec` ships it as `ephemeral` — the lock-step comment notwithstanding, the wording and the wire spec tell different stories. | Fix CLAUDE.md's tester-infra paragraph while touching this area; reconcile the compose wording in `testerEnvironmentSection` with the actual spec (and with the new library-local mode from #2) so prompt and harness agree again.                                                                     | todo   |     |
| 11  | **No coverage.** Nothing asserts library-frame behaviour: no conformance case for "library frame ⇒ deployer skips, tester gets suite posture + local compose spec", no detection fixture shaped like shared-ts-libs, no e2e spec importing a library repo.                                                                                  | Conformance: drive a build pipeline on a `library` frame via `FakeAgentExecutor` on both runtimes — assert the deployer no-op reason, the tester `infra` spec (`local`+`composePath`), and prompt posture. Detection unit fixtures: a shared-ts-libs-shaped monorepo. E2e: import-as-library flow once the UI slices land.                                                                              | todo   |     |

## Suggested slicing (each ≈ one PR)

1. **Phase A — the frame profile + engine adjustment** (gaps 1, 3): `frameProfile()` in
   contracts, deployer/tester-gate/prompt-posture consumption, conformance assertions
   (backend half of gap 11). This alone makes `library` honest for no-infra libraries
   (the majority — 28 of 32 shared-ts-libs packages).
2. **Phase B — local test infra revival** (gap 2 + the tester half of 11): the library
   test-infra declaration, `testerInfraSpec` `local`+`composePath` emission, prompt
   lock-step, DinD-availability handling. Independent of A's prompt work but builds on the
   profile.
3. **Phase C — coder validation** (gap 4): thread the infra spec/hint into
   coder/ci-fixer/conflict-resolver job bodies (harness image bump if the wire shape
   grows).
4. **Phase D — monorepo + detection** (gaps 5, 6): package-relative resolution, detector
   library signals, import/bootstrap pre-selection.
5. **Phase E — selection + UI polish** (gaps 7, 8): picker predicate, optional lean
   `pl_library` + frame default, inspector panel gating.
6. **Phase F — release-story nudge + doc reconciliation + e2e** (gaps 9, 10, 11's e2e
   half).

## Open decisions

- **D1 — declared compose path vs lifecycle convention (or both).** Recommended: **both,
  convention-first**. The `pretest:ci`/`test:ci`/`posttest:ci` convention is how real
  library repos (the reference bar) already encode infra — an agent with DinD just runs
  the script, zero config; the prompt should teach it. The declared per-frame (or
  per-package-detected) compose path feeds the deterministic `standUpInfra` for repos
  without the convention, and doubles as the signal for the tester's run-mode narration.
  Avoid inventing a cat-factory-only manifest; the repo's own files are the contract.
- **D2 — where DinD is unavailable.** `localDind` is a runtime capability (Docker-family
  local adapters: yes; Apple `container`: no; Cloudflare Containers: no privileged
  nesting). An infra-needing library job on a non-DinD runtime cannot compose-up
  in-container. Options: (a) refuse at run start with an actionable message (the
  `TESTER_INFRA_MESSAGES` pattern — "run this on a Docker-capable runner pool / local
  mode"), (b) fall back to a workspace compose handler standing the deps up and rewriting
  connection env (complex, breaks the localhost contract), (c) let the suite fail and
  report. Recommended: (a) — an honest, early refusal mirroring the existing
  `provision-type-unhandled` shape; revisit (b) only on demand.
- **D3 — dedicated `pl_library` built-in?** Recommended: not in the first phases. With
  smart adjustment every existing pipeline is correct on library frames; a lean seeded
  `pl_library` is a discoverability nicety (Phase E) whose absence blocks nothing. If
  added, it must NOT become the mechanism (no library-only step semantics that other
  pipelines lack).
- **D4 — is `library` the profile key, or does `provisioning.type` grow a value?** The
  frame type is the user-facing classification and already exists — recommended as the
  single source (`frameProfile(block.type)`). Do NOT overload `provisioning.type` with a
  `library-local` value: provisioning models "how an environment is stood up", and a
  library's whole point is that there is no environment. Keep `provisioning` ignored (or
  UI-hidden, gap 8) on library frames rather than requiring `infraless` to be set.
- **D5 — module→package directory mapping source for monorepos (gap 5).** Candidates: the
  blueprint's per-module `references` (already file/dir-anchored), the monorepo service
  directory on the repo projection, or detection-time scanning of `pnpm-workspace.yaml`.
  Decide when Phase D starts; prefer whatever the multi-select-monorepo-services work
  (PR #1100) already persists.

## Conventions & gotchas (carry between iterations)

- **The tester prompt ⇄ infra spec lock-step**: `testerEnvironmentSection` (agents) and
  `testerInfraSpec` (server) must change together — they already drifted once on
  docker-compose wording (gap 10); don't widen the drift when adding the library mode.
- **Anything that grows the harness job wire shape or `standUpInfra` behaviour is an
  image-affecting change**: bump `@cat-factory/executor-harness` + the three pinned tags
  (see CLAUDE.md's image-tag rules).
- **Keep the runtimes symmetric**: any new persisted field (a frame test-infra declaration,
  if D1 lands one) mirrors D1 ⇄ Drizzle with a conformance assertion in the same change.
  The frame profile itself is pure contracts code — no persistence expected for Phases A-C.
- **`frameOf`/`resolveServiceFrameBlock`** (kernel `block-tree.ts`, orchestration
  `frame.logic.ts`) are the canonical task→frame walks — resolve the profile through them,
  never a hand-rolled parent loop.
- **The tester prompts are not in `PROMPT_VERSIONS`** (bespoke kinds, resolve to v1), so
  posture edits need no version bump; the coder/track prompts ARE versioned — bump
  `versions.ts` when gap 9's changeset directive lands there.
- **The deployer's no-op is load-bearing**: pipelines keep their `deployer` step on
  library frames (no pipeline surgery); the step must record WHY it skipped (frame
  profile) so the run timeline stays explainable — copy the `infraless` no-op's shape.
- **Detection must stay deterministic and budget-bounded** (`BudgetedRepoScanner`,
  `READ_BUDGET`): library signals are a few targeted reads (`package.json`,
  `.changeset/`, `pnpm-workspace.yaml`, per-package compose probes), not a repo crawl.
- **`frameRepoTypeSchema` ⊂ `blockTypeSchema`**: the behavioural profile keys off the
  full `BlockType` (a frame can be `api`/`database`/… via other paths); unlisted types
  default to the `service` profile so nothing changes for them.
