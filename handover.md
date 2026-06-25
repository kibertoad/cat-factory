# Handover — manifest-driven custom agents

This is the working handover for the multi-PR effort to make cat-factory extensible for
**company-authored agents** without forking the platform. Read this top-to-bottom before
continuing; it captures the vision, what's merged, what's in-flight, and exactly what to do next.

> Full approved plan (same machine): `C:\Users\IgorSavin\.claude\plans\revise-provided-extension-points-jolly-shannon.md`. This doc is self-contained; the plan has extra prose.

---

## 1. The goal & the governing principle

Companies want to ship their own agents (compliance auditor, security scanner, custom migrator,
bespoke reviewer) without forking. The end state: an agent decomposes into **three stages**, and
the container runs only the middle one:

1. **`preOps`** — deterministic backend TypeScript. Reads/writes a **targeted, known subset** of
   the repo with **no checkout**, via the `GitHubClient` Git Data API.
2. **`agent`** — optional LLM step: `inline` (no repo), `container-explore` (read-only; returns
   prose or structured JSON), or `container-coding` (edits + commits + pushes a working tree).
3. **`postOps`** — deterministic backend TypeScript. Parses the agent's structured output, runs
   the mechanical transforms (Gherkin/dedupe/render), commits files via `RepoFiles`, ingests.

**Governing principle (do not violate):** _zero `switch(agentKind)` in the container._ The harness
is a generic LLM-over-a-checkout runner. All mechanical/deterministic work is backend TypeScript.
Closing a gap = adding a backend repo-op function (plain TS, reusable), **never** per-agent
container code, **never** an image rebuild for a new agent.

Why it's feasible with no new infra: the `GitHubClient` port already exposes `getFileContent`,
`listDirectory`, `createBranch`, `commitFiles` ("blob → tree → commit → ref"), `openPullRequest`,
etc. over pure `fetch` — the SAME `FetchGitHubClient` is wired on Cloudflare Worker, Node, and
local. So backend repo-ops are runtime-symmetric and need no clone; the Worker's lack of a
filesystem stops mattering.

The mandate also includes **converting every existing built-in agent** to this model (dogfooding →
100% coverage) and proving it with parity tests. The bespoke harness handlers get deleted once
each kind is migrated.

---

## 2. Status of the 7 tasks

| #   | Task                                                       | Status                                               |
| --- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Backend transform library + `RepoFiles` port               | ✅ DONE — merged in **PR #166**                      |
| 2   | `AgentDefinition` + pre/post-op model                      | ✅ DONE — merged in **PR #166**                      |
| 3   | Harness: generic `agent` kind (explore/coding)             | ✅ DONE — merged in **PR #169**                      |
| 4   | Backend engine: pre/post-op hooks + dispatch (live wiring) | ✅ DONE — merged in **PR #177**                      |
| 5   | Convert each built-in agent, parity-gated (strangler)      | ◐ IN PROGRESS — read-only kinds rerouted (see below) |
| 6   | Frontend data-driven palette + generic result view         | ✅ DONE — merged in **PR #177**                      |
| 7   | Example package + docs + conformance + changesets          | ✅ DONE — merged in **PR #177**                      |

- PR #166: `custom-agent-foundations` (merged, released).
- PR #169: generic manifest-driven `agent` harness kind + backend dispatch (merged).
- PR #177: live pre/post-op execution + data-driven palette + generic result view +
  `@cat-factory/example-custom-agent` + `backend/docs/custom-agents.md` (merged).

**The framework is fully in place.** All that remains is Task 5: the strangler that
migrates each built-in agent onto the manifest-driven `agent` model, one at a time,
parity-gated, then deletes the bespoke harness handlers. CLAUDE.md's "Custom agents"
section + `backend/docs/custom-agents.md` are the current source of truth for the model.

### Task 5 progress (the strangler) — FULL-SWEEP in progress

> **Mandate (user, explicit):** migrate ALL remaining built-ins onto the generic `agent`
> kind in ONE sweep (incl. harness changes + executor image bump), then open ONE PR. Work
> is on branch `migrate-remaining-agents-generic-kind`. Do NOT open the PR until the whole
> sweep compiles + Windows-safe tests pass. This is a large, multi-turn build (~40 files
> across harness/server/orchestration/kernel/contracts/worker/node/frontend + conformance +
> image bump). The list below is the authoritative checklist — keep it updated as you go.

**Sweep checklist (ordered):**

1. ✅ **read-only** (`architect`/`analysis`/`bug-investigator`) — merged in PR #187 (no image bump).
2. ✅ **merger / on-call / ci-fixer / fixer** — rerouted onto the generic `agent` kind in
   `ContainerAgentExecutor` (this branch, **server package builds clean**). `merger`/`on-call`
   are `container-explore` structured (full clone; bespoke prompt via `mergerUserPrompt`/
   `onCallUserPrompt`); their conservative JSON coercion moved BACKEND-side into
   `toRunResult` (now kind-aware: `custom`→`mergeAssessment`/`onCallAssessment` via
   `coerceMergeAssessment`/`coerceOnCallAssessment`). `ci-fixer`/`fixer` are
   `container-coding` clone-`pr`. All routed through `buildMigratedBuiltInBody` →
   `buildRegisteredAgentBody` (which gained an optional `userPrompt` override). The
   `diffExaminable` container guard the harness merger had is NOT reproduced backend-side
   (documented in `coerceMergeAssessment`); conservative-on-garbage defaults cover the risk.
   NO image bump yet (handleAgent 1.9.0 already serves explore-structured + coding-on-PR).
   **TODO before PR:** update `containerAgentJobBody.spec.ts` snapshot + the
   `container-agent-executor.spec.ts` for the new `kind:'agent'` bodies of these 4 kinds.
3. ✅ **coder** — default case now dispatches `buildRegisteredAgentBody` `container-coding`
   clone-`work` (opens PR). `runCodingAgent` ALREADY does branch-resume + checkpoint, so the
   generic coding path is behaviour-equivalent to `/run` (server builds clean). `/run`/
   `handleRun` is deleted in the harness-cleanup step (→ image bump).
4a. ✅ **blueprints** — DONE this branch (`migrate-blueprints-spec-generic-kind`, PR pending).
   `blueprints` dispatches `kind:'agent'` `mode:'explore'` structured (clone `pr` →
   `prBranch ?? baseBranch`) via `buildMigratedBuiltInBody`; `toRunResult` coerces
   `custom`→`blueprintService` (`coerceBlueprintService`). The render+commit is a BUILT-IN
   backend post-op `blueprintPostOp` (`@cat-factory/agents` `repo-ops/builtin.ts`) over
   `RepoFiles` — idempotent (version.json hash short-circuit, replay-safe) + orphan-prunes
   removed module deep-dives via the new **deletions** channel. The post-op is keyed by a
   small built-in map in `ExecutionService.builtInPostOps` (+ `builtInRepoOpBranch` =
   `prBranch ?? baseBranch`, matching dispatch — NOT `resolveRepoOpBranch`'s `pr` case which
   ensures a work branch and is wrong for the no-PR bootstrap blueprint). **deletions infra**:
   `commitFilesSchema`/`CommitFilesInput` gained `deletions?: string[]`, wired through
   `FetchGitHubClient.commitFiles` (tree entries with `sha:null`). NO image bump (handleAgent
   explore-structured already serves it). Tests: `containerAgentJobBody.spec.ts` snapshot +
   blueprints pollJob coercion; `agents` `repo-ops/builtin.test.ts` (render/idempotency/prune);
   conformance assertion (post-op commits via RepoFiles, both runtimes). Changeset
   `migrate-blueprints-generic-kind.md`. **The `FakeGitHubClient.commitFiles` impls capture
   the whole input so `deletions` passes through transparently — no fake change needed.**

4b. ✅ **spec-writer** — DONE this branch (`migrate-spec-writer-generic-kind`, PR pending).
   `spec-writer` dispatches `kind:'agent'` `mode:'explore'` structured, clone `work` (the
   per-block `cat-factory/<blockId>`) via `buildMigratedBuiltInBody`; `toRunResult` coerces
   `custom`→`spec` (`coerceSpecDoc`). The SHARD+commit is a BUILT-IN backend post-op
   `specPostOp` (`@cat-factory/agents` `repo-ops/builtin.ts`) over `RepoFiles`, keyed by the
   engine's built-in map (`builtInPostOps`). It reproduces the harness `spec.ts` reconcile:
   (a) ORPHAN-PRUNE removed canonical `modules/**` shards (recursive `listDirectory` →
   deletions channel); (b) SEED-ONCE Gherkin (only commit a `features/<m>/<g>.feature` that
   is ABSENT, never overwrite); (c) drop the legacy monolithic files (`spec/spec.json`/
   `rules.md`/`version.json` + flat `features/*.feature`) on sight. Idempotent: no
   version.json, so it byte-compares each rendered shard via `getFile` and skips the commit
   when ALL match + nothing to seed/prune (replay-safe). Branch resolution: `builtInRepoOpBranch`
   is now kind-aware/async — spec-writer reuses `resolveRepoOpBranch({clone:'work'})` (ensure
   work branch, matching dispatch); blueprints keeps `prBranch ?? baseBranch`. **Prompt
   redesign (still wants a real-model smoketest as the rollout gate):** the explore agent now
   READS the baseline from its own checkout — `SPEC_WRITER_SYSTEM_PROMPT` updated to point at
   `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt(context)`
   carries the task increment + read-the-baseline + reuse-the-taxonomy guidance the harness
   `buildUserPrompt`/`renderTaxonomyInventory` used to inject. NO image bump (handleAgent
   explore-structured already serves it). Tests: `containerAgentJobBody.spec.ts` snapshot +
   spec pollJob coercion; `agents` `repo-ops/builtin.test.ts` (shard/seed-once/prune/legacy/
   idempotency); conformance assertion (post-op shards+commits onto the work branch, both
   runtimes). Changeset `migrate-spec-writer-generic-kind.md`. The dead `/spec` harness handler
   is deleted in the harness-cleanup step (§8, image bump); `result.spec` in `toRunResult` is
   now dead (removed when the kernel `RunnerJobResult.spec` is slimmed, §9).
5. ⬜ **tester** — `container-explore` structured + INFRA stand-up. Grow the harness AgentJob
   with `infra?: {environment, noInfraDependencies?, composePath?, environmentUrl?}` and have
   `runExploreMode` run `standUpInfra`/`tearDownInfra` (lift from `tester.ts`) + fold the
   run-mode guidance into the prompt. Executor: route via `buildRegisteredAgentBody` with the
   infra spec; `toRunResult` `custom`→`testReport` (move `coerceReport`'s conservative
   greenlight/blocking logic backend-side — TesterController re-applies it anyway). Image bump.
6. ⬜ **conflict-resolver** — `container-coding` + `mergeBase`. Grow AgentJob with
   `mergeBase?: string`; `runCodingMode` does full clone + `mergeBranch(base)` + surface
   conflict hunks into the prompt (lift `buildConflictPrompt`/`unmergedPaths`/`conflictDiff`
   from `conflict-resolver.ts`) + refuse to push a half-resolved tree + the clean/no-op
   handling. `result.resolved` maps as today. Image bump.
7. ⬜ **bootstrap** — `ContainerRepoBootstrapper.startBootstrap` dispatches `kind:'agent'`
   `container-coding` with new fields `reinit?: true` (reset history to one commit) +
   `forcePush?: true` + optional `reference?` clone source + from-scratch (empty dir) +
   pushes to `target.defaultBranch`. Grow `runCodingMode` accordingly (lift `reinitAndPush`
   from `bootstrap.ts`). The link post-op (`linkRepoToBlock`) already lives in
   `pollBootstrapJob`. Image bump.
8. ⬜ **harness cleanup (image bump)** — delete `blueprint.ts`/`spec.ts`/`explore.ts`/
   `merger.ts`/`on-call.ts`/`tester.ts`/`ci-fixer.ts`/`fixer.ts`/`conflict-resolver.ts`/
   `bootstrap.ts`/`handleRun` (in `runner.ts`?) once nothing dispatches them; collapse
   `server.ts` `KINDS` to `{ agent }`; strip the bespoke job types + parsers from `job.ts`
   (keep `parseAgentJob` + shared helpers); delete the bespoke handler tests; bump
   `@cat-factory/executor-harness` version + the tag in `deploy/backend/package.json` +
   `deploy/backend/wrangler.toml` (current 1.9.0 → next). Drop the `'explore'` line in
   `LocalContainerRunnerTransport.test.ts`.
9. ⬜ **kernel** — collapse `RunnerDispatchKind` to just `'agent'`; slim `RunnerJobResult`
   (drop `service`/`spec`/`assessment`/`onCallAssessment`/`report`/`resolved`; keep `custom`/
   `prUrl`/`branch`/`pushed`/`defaultBranch`/`summary`/`error`/`usage`). Fix all
   referencing call sites (executor `toRunResult`, transports).
10. ⬜ **frontend** — built-in palette is unaffected (AGENT_ARCHETYPES). Verify merger/on-call/
    tester result views still render (engine still sets `mergeAssessment`/`onCallAssessment`/
    `testReport`; `step.custom` is also set now — confirm no double-render). `generic-structured`
    already handles `step.custom`.
11. ⬜ **conformance** — extend `defineConformanceSuite` to assert a migrated built-in (e.g.
    `blueprints`) dispatches `kind:'agent'` and its post-op commits via the `FakeGitHubClient`
    on BOTH runtimes. Update worker/node specs.
12. ⬜ **changeset** — one changeset covering server/orchestration/kernel/contracts/agents +
    executor-harness (versioned-private) + worker/node. Note the breaking `RunnerDispatchKind`
    collapse (pre-1.0, no compat).

**Verification:** `pnpm --filter @cat-factory/server build`, `pnpm --filter @cat-factory/orchestration test:run`, `pnpm --filter @cat-factory/agents test:run`, harness `pnpm test` (Windows-safe except 4 pre-existing `writeAgentsContext` failures), `pnpm build` (full graph). workerd/Postgres conformance + container behaviour (infra/merge-base/bootstrap force-push/render byte-parity) verify on Linux CI + the `smoketest` skill — that is the designed image-rollout gate, not a Windows step.

---

#### (historical) Original Step 1/Step 2 notes

**Step 1 — read-only kinds rerouted (DONE, merged #187):** `architect`, `analysis`
and `bug-investigator` now dispatch through the generic `agent` kind in `mode:'explore'`
instead of the bespoke `explore` dispatch kind. `ContainerAgentExecutor.buildKindBody`'s
`isReadOnlyAgentKind` branch routes through `buildRegisteredAgentBody` with a synthesized
`{ surface: 'container-explore' }` step — the body is byte-identical to the old `/explore`
body (verified by the `containerAgentJobBody.spec.ts` snapshot: only `kind` explore→agent,
`label`→`mode`) and the prose result maps to `output` unchanged. The deployed harness image
(1.9.0) already serves this via `handleAgent`, so **no image bump**. Prompt parity is
automatic: `architect` resolves its prompt via the `design` phase track and `analysis`/
`bug-investigator` via the `roleSystemPrompt` fallback — neither path was touched. (Note:
`bug-investigator` is in `READ_ONLY_AGENT_KINDS` but NOT in `CompositeAgentExecutor`'s
`CONTAINER_KINDS`, so it actually runs INLINE today — a pre-existing inconsistency, out of
scope here; the reroute only affects `architect`/`analysis` at runtime.) Files: `server`
`ContainerAgentExecutor.ts`, `agents` `read-only.ts` (comment), the worker integration spec

- the server snapshot, changeset `read-only-agents-generic-kind.md`.

**Step 2 — delete the dead `/explore` handler (NEXT, image bump):** nothing dispatches
`kind:'explore'` any more, so once Step 1's reroute is confirmed on CI + a smoketest,
delete the harness `handleExplore` / `parseExploreJob` / the `explore` `KINDS` entry and
remove `'explore'` from `RunnerDispatchKind`. That changes the harness `src/**` ⇒ **bump
`@cat-factory/executor-harness`** + the matching tag in `deploy/backend/package.json` +
`deploy/backend/wrangler.toml` (see §6). Also drop the `LocalContainerRunnerTransport.test.ts`
line that dispatches `'explore'`.

Then continue the order in §5: the render kinds (`blueprints`/`spec-writer`), the coding
kinds (`coder`/`ci-fixer`/`fixer`/`conflict-resolver`), then `bootstrap`.

---

## 3. What exists now (the seams you build on)

### From PR #166 (merged)

- **`@cat-factory/agents` `src/repo-ops/render.ts`** — the deterministic, container-free render +
  lenient coercion of the in-repo `blueprints/`/`spec/` artifacts, lifted out of the harness.
  Exported from the package index. Functions: `coerceBlueprintService`, `renderBlueprintFiles`,
  `renderBlueprintVersionFile`, `nextBlueprintVersion`, `moduleSlug`, `canonicalBlueprintJson`,
  `hashBlueprint`; `coerceSpecDoc`, `dedupeSpecIds`, `renderSpecFiles`, `renderSpecFeatureFiles`
  (Gherkin), `renderSpecVersionFile`, `nextSpecVersion`, `canonicalSpecJson`, `hashSpec`.
  **The hash + version helpers are ASYNC** (Web Crypto, runtime-neutral). 11 golden-file tests in
  `render.test.ts` lock byte-identical output to the old harness. The canonical schemas
  (`blueprintServiceSchema`/`specDocSchema`, path constants, version schemas, `parseBlueprintService`/
  `parseSpecDoc`) already live in `@cat-factory/contracts` — reuse them, don't re-create.

- **`@cat-factory/agents` registry** (`src/agents/kinds/registry.ts`) — `AgentKindDefinition` now
  carries `agent` (an `AgentStepSpec`), `preOps`/`postOps` (`RepoOp[]`), and `presentation`
  (`AgentPresentation`). Accessors: `registeredAgentStep`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`. `registeredKindRequiresContainer` now also returns true for a
  container `agent.surface`. Tests in `src/agents/kinds/registry.test.ts`.

- **`@cat-factory/kernel`**:
  - `ports/repo-files.ts` — `RepoFiles` (per-run, checkout-free facade: `getFile`, `listDirectory`,
    `headSha`, `createBranch`, `commitFiles`, `openPullRequest`) + `ResolveRepoFiles` factory type.
  - `ports/agent-definition.ts` — `AgentSurface` (`inline`|`container-explore`|`container-coding`),
    `AgentStepSpec` (`surface`, `output`, `clone`, `infra`), `AgentCloneSpec`, `AgentOutputSpec`,
    `RepoOp`, `RepoOpContext` (`{ repo, context, branch, result? }`).

- **`@cat-factory/contracts` `src/agent-presentation.ts`** — `AgentPresentation`, `AgentCategory`
  (`review`|`design`|`build`|`test`|`docs`|`gates`), `CustomAgentKind` (`{ kind, presentation,
container }`) — the wire shapes for the data-driven palette (Task 6).

### From PR #169 (open)

- **Harness `src/agent.ts`** — `handleAgent(job, opts)` dispatching on `mode`:
  - `explore` → clone `branch` read-only, return prose or (for `output.kind==='structured'`) a
    parsed `custom` JSON object (with the one-shot `resolveStructuredOutput` repair, honoring
    `output.repair === false` via a direct parse).
  - `coding` → `runCodingAgent` (clone `branch`/resume `newBranch`, push `pushBranch`), open `pr`
    when set + pushed; `noChangesIsError:false` makes a no-op non-fatal (fixer-like).
  - Built on existing primitives (`withWorkspace`, `runAgentInWorkspace`, `runCodingAgent`,
    `resolveStructuredOutput`, `cloneRepo`, `openPullRequest`). No per-kind logic.
- **Harness `src/job.ts`** — `AgentJob`/`AgentResult` + `parseAgentJob` (mode, prompts, repo,
  branch, output spec, coding fields, host allowlist). **Harness `src/server.ts`** — `agent` entry
  in `KINDS`. Tests: `test/agent.test.ts` (parser).
- **Kernel** — `RunnerDispatchKind` gains `'agent'`; `RunnerJobResult` + `AgentRunResult` gain a
  generic `custom?: unknown` channel.
- **`@cat-factory/server`**:
  - `src/agents/repoFiles.ts` — `makeRepoFiles(client, installationId, ref)` /
    `makeResolveRepoFiles(client)` (the `RepoFiles` impl over `GitHubClient`) + `runRepoOps(ops, ctx)`.
    Tests: `src/agents/repoFiles.test.ts` (9, against a fake `GitHubClient`).
  - `ContainerAgentExecutor` — `buildKindBody` now short-circuits to `buildRegisteredAgentBody`
    when `registeredAgentStep(kind)` is set, dispatching `kind:'agent'` (mapping `base`/`pr`/`work`
    clone targets like the built-in bodies). `toRunResult` maps `result.custom`. Built-ins unchanged.
- **Image**: `@cat-factory/executor-harness` bumped (minor → 1.9.0); deploy tag set to `1.9.0` in
  `deploy/backend/package.json` (`image:publish`) and `deploy/backend/wrangler.toml`.

---

## 4. (HISTORICAL) Task 4: live pre/post-op execution wiring — DONE in PR #177

> Kept for context. This was completed in PR #177 exactly as planned below — `ExecutionService`
> runs a registered kind's `preOps`/`postOps` over a per-run `RepoFiles` via the
> `resolveRunRepoContext` engine dep, wired symmetrically across all three facades, with a
> cross-runtime conformance assertion. See CLAUDE.md "Custom agents" for the as-built shape.
> The **active** next step is Task 5 (§2 "Task 5 progress" + §5).

This was the deliberately-deferred half of PR #169. It's the part that makes a registered kind's
`preOps`/`postOps` actually RUN. It was deferred because it needs the engine's run _context_ +
_result_ and per-facade wiring, and is only verifiable on Linux CI (workerd / Postgres), not Windows.

**Where it goes (decided):** `ExecutionService` (`@cat-factory/orchestration`), NOT the executor.
The harness `pollJob` site has only a job handle (no block/task/result-with-context), so post-ops
can't run there. `ExecutionService.recordStepResult` already has the full context + the
`AgentRunResult` and already hosts the analogous deterministic post-completion logic
(`StepCompletionResolver` registry → merger merge, blueprint reconcile). Generalize that.

Concretely:

1. **Thread `ResolveRepoFiles` into the engine.** `ExecutionService` (or the `ServerContainer`
   it's built from) needs a `resolveRepoFiles?: ResolveRepoFiles` dep + a way to resolve the run's
   `installationId` + repo `{owner, repo}` (the same `resolveRepoTarget` the executor uses — see
   `ContainerAgentExecutor` `RepoTarget`/`ResolveRepoTarget`, and each facade's `container.ts`
   `resolveRepoTarget`). Build a `RepoFiles` bound to that installation+repo for the run.

2. **Run pre-ops before dispatch, post-ops after the result.** In `ExecutionService`:
   - before an agent step dispatches: `await runRepoOps(registeredPreOps(kind), ctx)` where
     `ctx = { repo, context, branch }` (branch = the resolved work/pr/base branch for the step).
   - after the step's `AgentRunResult` is recorded (in `recordStepResult`, alongside the existing
     resolver logic): `await runRepoOps(registeredPostOps(kind), { repo, context, branch, result })`.
   - Gate on `resolveRepoFiles` being wired AND the kind having ops; otherwise no-op (tests / no GitHub).
   - `runRepoOps` is already exported from `@cat-factory/server` — but orchestration must not depend
     on server (layering). Either move `runRepoOps` to kernel/agents, or inline the trivial loop in
     orchestration. **Check the import direction** (`@cat-factory/orchestration` does NOT import
     `@cat-factory/server`; server imports orchestration). Likely move `runRepoOps` to
     `@cat-factory/agents` (it already owns the render lib + registry) or kernel.

3. **Wire `resolveRepoFiles` in ALL THREE facades** (parity is mandatory — CLAUDE.md "Keep the
   runtimes symmetric"): `backend/runtimes/cloudflare/src/infrastructure/container.ts`,
   `backend/runtimes/node/src/container.ts`, `backend/runtimes/local/src/container.ts`. Each already
   builds a `FetchGitHubClient` (worker: GitHub App; node: App when configured; local: PAT-backed
   `createLocalGitHubClient`). Pass `makeResolveRepoFiles(githubClient)` into the engine. When no
   GitHub client is wired (tests), leave it undefined → pre/post-ops skip.

4. **Conformance assertion** (`@cat-factory/conformance`, `defineConformanceSuite`): register a
   custom container kind with a `postOp` that calls `ctx.repo.commitFiles(...)`; assert it routes to
   the container executor (via `FakeAgentExecutor`) and the post-op commits via a `FakeGitHubClient`,
   identically on both runtimes. Both `runtimes/cloudflare/test/integration/conformance.spec.ts` and
   `runtimes/node/test/conformance.spec.ts` invoke the suite.

5. Add a changeset (orchestration + any facade packages + kernel/agents if `runRepoOps` moves).

**Verify on CI** (you cannot run workerd or the Postgres conformance suite on Windows — see §6).
Push and let CI run; or run `pnpm --filter @cat-factory/orchestration test:run` for the pure-logic
parts locally.

---

## 5. Then Tasks 5–7

- **Task 5 — convert built-ins, parity-gated (strangler):** Register each built-in kind as an
  `AgentKindDefinition` with an `agent` step (+ pre/postOps) so it dispatches the generic `agent`
  kind, ONE at a time, behind the harness acceptance suite + the `smoketest` skill. Order:
  explore-only first (`architect`/`analysis`/`bug-investigator`/`merger`/`on-call`/`tester`), then
  the render kinds (`blueprints`/`spec-writer` — model step = `container-explore` structured;
  rendering = a **post-op** using PR-#166's `renderBlueprintFiles`/`renderSpecFiles`/
  `renderSpecFeatureFiles` + `coerce*` + `commitFiles`; spec's baseline read = a **pre-op** via
  `getFile('spec/spec.json')`; the merger's conservative-1/1/1 override + real merge stay as
  backend logic/post-op; tester infra stand-up stays a container concern via `agent.infra`), then
  the coding kinds (`coder`/`ci-fixer`/`fixer`/`conflict-resolver`), then `bootstrap`
  (`ContainerRepoBootstrapper` → generic `coding` agent + a link post-op). **Delete each bespoke
  harness handler only after its kind passes parity.** Delete the bespoke `RunnerDispatchKind`
  members + the harness render/transform code LAST. Each built-in conversion that changes the runner
  image = a harness image bump (see §6).
  - **Golden-file safety net:** the render library already has byte-parity tests; lean on them. The
    `blueprint.ts`/`spec.ts` seed-once Gherkin (write feature files only when absent) must be
    reproduced in the post-op via `listDirectory('spec/features')` before `commitFiles`.

- **Task 6 — data-driven frontend palette + generic result view:** Serialize `registeredAgentKinds()`
  → `customAgentKinds: AgentPresentation[]` (kind + presentation + container) into the workspace
  snapshot (contract in `@cat-factory/contracts` `snapshot.ts`; populate in `@cat-factory/server`
  snapshot assembly). In `frontend/app/app/utils/catalog.ts` add `registerCustomArchetypes(...)`
  merged into `AGENT_BY_KIND`/`agentKindMeta`/the palette source; the SPA snapshot/bootstrap store
  calls it on load. Add a `'generic-structured'` entry to `STEP_RESULT_VIEWS` in
  `frontend/app/app/components/panels/StepResultViewHost.vue` → a new `GenericStructuredResultView.vue`
  (read-only JSON/markdown viewer of the step's `custom` output). NOTE the frontend hand-synced
  mirrors (`AGENT_ARCHETYPES`, `COMPANION_FOR_PRODUCER`, `CONSENSUS_ELIGIBLE_KINDS`) — data-driving
  built-ins is a stretch goal; at minimum make CUSTOM kinds first-class.

- **Task 7 — example package + docs:** `backend/internal/example-custom-agent`
  (`@cat-factory/example-custom-agent`, changeset-`ignore`d, mixed in like
  `@cat-factory/provider-bedrock`): an inline `org-reviewer` + a container `security-auditor`
  (`container-explore` structured, a postOp rendering `compliance/REPORT.md` via `commitFiles`,
  presentation `resultView: 'generic-structured'`) + `registerPipeline({id:'pl_org_audit', …})`.
  Proves a brand-new repo-writing agent ships with ZERO harness changes. Then
  `backend/docs/custom-agents.md` (link from CLAUDE.md + CONTRIBUTING.md) + rewrite CLAUDE.md's
  executor-harness / blueprint / spec / merge-lifecycle sections (rendering now lives backend-side).
  End-to-end smoke on `deploy/local` (`import '@cat-factory/example-custom-agent'`, `linkRepo`, run
  `pl_org_audit`).

---

## 6. Gotchas / house rules (learned the hard way)

- **Windows test limits (this machine):** Worker/vitest-pool-workers tests fail on Windows
  (pre-existing, per CLAUDE.md). The Node conformance suite needs `DATABASE_URL` (Postgres). The
  harness `writeAgentsContext` tests (4) fail on Windows with a `$HOME` short-path quirk — **this is
  pre-existing on `main`** (confirm by stashing), NOT your change. Verify pure-logic via
  `pnpm --filter <pkg> test:run`; rely on CI for workerd/Postgres.
- **Runtime-neutral code:** `@cat-factory/agents`/`contracts`/`kernel`/`server` run on workerd too.
  Use **Web Crypto** (`crypto.subtle`), never `node:crypto`. The agents tsconfig needed
  `"lib": ["ES2022","DOM","DOM.Iterable"]` for the `crypto`/`TextEncoder` globals (mirrors
  `@cat-factory/workspaces`). `@cat-factory/contracts` is browser-safe + Valibot-only — keep
  `node:*` and hashing OUT of it.
- **Image bumps (CLAUDE.md, strict):** ANY change to the harness `src/**`/`Dockerfile`/`tsconfig`/
  pinned `PI_*` args MUST bump `@cat-factory/executor-harness` (changeset) AND the matching tag in
  BOTH `deploy/backend/package.json` (`image:publish`) and `deploy/backend/wrangler.toml`
  (`[[containers]] image`). A fresh immutable tag is what forces the rollout. (Current: 1.9.0.)
- **Changesets:** every change to a versioned package needs one (`changeset status` is CI-gated).
  `deploy/*` + `benchmark-harness` + `smoketest-harness` are `ignore`d; `executor-harness` is
  versioned-but-private. Use `pnpm changeset --empty` for docs/test-only changes.
- **Parity is a showstopper, not a follow-up:** a shared behaviour wired into one facade and not the
  others is a bug. Land all runtimes + a conformance assertion in the SAME change.
- **oxfmt on Windows** rewrites line endings tree-wide — format ONLY your touched files
  (`pnpm exec oxfmt <files>`) to keep diffs clean; CI normalizes CRLF anyway.
- **No backwards compat** (pre-1.0): don't add migrations/shims/legacy fallbacks. Collapsing
  `RunnerDispatchKind` to just `'agent'` (after Task 5) is fine to break.
- **oxlint `unicorn/no-thenable`** fires on a literal `then:` key (the spec coercion accepts a
  model-emitted `then`); in tests use `// eslint-disable-next-line unicorn/no-thenable`.

---

## 7. Verification commands

```bash
# Full backend graph build (definitive typecheck across packages)
pnpm build

# Per-package unit tests (Windows-safe)
pnpm --filter @cat-factory/agents test:run        # render golden files + registry
pnpm --filter @cat-factory/server test:run        # repoFiles + everything else
pnpm --filter @cat-factory/kernel run build
pnpm --filter @cat-factory/orchestration test:run # engine logic + extension-registries

# Harness (Windows-safe except the 4 pre-existing writeAgentsContext failures)
cd backend/internal/executor-harness && pnpm test

# Lint / format / changeset (CI gates)
pnpm exec oxlint <changed files>
pnpm exec oxfmt <changed files>
pnpm changeset status

# Full suite (needs Postgres for Node conformance; run on CI/Linux)
pnpm test:run
```

## 8. Workflow notes

- Branch off `main` (don't commit to `main`). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. PR body trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Keep PRs additive + reviewable; the strangler sequence (Task 5) means many small parity-gated PRs.
- The `extension-registries.test.ts` (orchestration) is the canonical place to assert new
  registration seams (`registerAgentKind`/`registerPipeline`/future `registerGate`/`registerStepResolver`).
