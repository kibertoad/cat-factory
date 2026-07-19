# @cat-factory/agents

## 0.65.0

### Minor Changes

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/prompt-fragments@0.13.40

## 0.64.2

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.64.1

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.64.0

### Minor Changes

- 37c642f: Migrate the `blueprints` and `spec-writer` container agent kinds onto the public
  `registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven agent-kind
  strangler).

  Their role/system prompts, structured shape hints, and per-kind user-prompt builders
  (`blueprintUserPrompt` / `specWriterUserPrompt`) move from `@cat-factory/server`'s
  `agents/prompts.ts` down into `@cat-factory/agents` (`agents/kinds/spec-blueprints.ts`),
  where each is registered as a read-only structured `container-explore` kind (blueprints
  clones the PR branch; spec-writer clones the per-block work branch with
  `failOnUnusableFinal`). Their kind-id constants (`BLUEPRINTS_AGENT_KIND` /
  `SPEC_WRITER_AGENT_KIND`) now live next to the definitions and are re-exported by
  orchestration's `ci.logic.ts` for the engine's existing call sites — the same pattern the
  inline reviewer/brainstorm ids use.

  The generic `registry.agentStep(...)` dispatch path in the server's `buildKindBody` now
  renders their job body, so **both cases are deleted from `buildMigratedBuiltInBody`** and
  the pair are removed from `CompositeAgentExecutor`'s hard-coded `CONTAINER_KINDS` set
  (container routing now derives from `registry.requiresContainer()`). Their result coercion
  still keys off their id in `toRunResult` (`blueprintService` / `spec`), and their
  deterministic render/commit post-ops stay in the engine's built-in map (their commit branch
  is resolved specially), so engine behaviour is unchanged.

  Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
  registered kind, the surface-driven directives and declared traits are applied centrally
  rather than being bypassed by the old bespoke constant: the observable prompt change is that
  both kinds now carry the standard read-only guardrail (matching every other
  `container-explore` kind), `blueprints` now also carries its declared `spec-aware` guidance,
  and both fold in the block's selected best-practice fragments — the enrichment every other
  kind already received. Both the final-answer directive AND the read-only guardrail are now
  applied once from the surface (removed from the hand-written constants): `SPEC_WRITER_SYSTEM_PROMPT`
  no longer restates the write-prohibition the central `READ_ONLY_GUARDRAIL` owns, matching
  `BLUEPRINT_SYSTEM_PROMPT` (which never hand-embedded one) so read-only has a single source of truth.

## 0.63.0

### Minor Changes

- ea64461: Migrate the `initiative-analyst` and `initiative-planner` container agent kinds onto the
  public `registerAgentKind` seam (refactoring-candidates.md #5, the manifest-driven
  agent-kind strangler).

  Their role/system prompts, structured shape hint, and per-kind user-prompt builders
  (`initiativeAnalystUserPrompt` / `initiativePlannerUserPrompt`, now exported) move from
  `@cat-factory/server`'s `agents/prompts.ts` down into `@cat-factory/agents`
  (`agents/kinds/initiative.ts`), where each is registered with an `agent` `AgentStepSpec`
  (`container-explore`, base-branch clone; the planner structured with
  `failOnUnusableFinal`). The generic `registry.agentStep(...)` dispatch path in the server's
  `buildKindBody` now renders their job body, so **both cases are deleted from
  `buildMigratedBuiltInBody`** and the pair are removed from `CompositeAgentExecutor`'s
  hard-coded `CONTAINER_KINDS` set (container routing now derives from
  `registry.requiresContainer()`).

  Because their prompts now resolve through `systemPromptFor`/`userPromptFor` like any
  registered kind, the surface-driven directives (the read-only guardrail +
  final-answer-in-reply) are applied centrally rather than hand-embedded in the constants —
  the only observable prompt change is that the two read-only explore kinds now carry the
  standard read-only guardrail, matching every other `container-explore` kind. Behaviour is
  otherwise unchanged; the planner's result coercion still keys off its id in `toRunResult`
  (folding that onto the definition is the remaining slice).

## 0.62.13

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.62.12

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1
  - @cat-factory/prompt-fragments@0.13.39

## 0.62.11

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.62.10

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2
  - @cat-factory/prompt-fragments@0.13.38

## 0.62.9

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/prompt-fragments@0.13.37

## 0.62.8

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/prompt-fragments@0.13.36

## 0.62.7

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1
  - @cat-factory/prompt-fragments@0.13.35

## 0.62.6

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/prompt-fragments@0.13.34

## 0.62.5

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1
  - @cat-factory/prompt-fragments@0.13.33

## 0.62.4

### Patch Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.62.3

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/prompt-fragments@0.13.32

## 0.62.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/prompt-fragments@0.13.31

## 0.62.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1
  - @cat-factory/prompt-fragments@0.13.30

## 0.62.0

### Minor Changes

- 32a0720: feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

  Make a synced repo-sourced Claude Skill runnable as a pipeline step
  (docs/initiatives/repo-skills.md):

  - **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
    `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
    dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
    step that names no skill.
  - **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
    instructions from the account catalog plus the sibling resource bodies fetched at the
    skill's immutable pinned commit (per-file + total caps; oversized/binary files are
    referenced by repo path instead). The run never depends on a live GitHub fetch — a
    fetch failure degrades a resource to a path reference rather than failing the run.
    Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
    dispatched with the library unconfigured fails loudly rather than running blank), and
    the run step is pinned with `skillVersion: { skillId, commit, sha }`.
  - **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
    a dedicated top-level `skill` job-body field (never a context file). The
    executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
    the claude-code subscription harness (so the CLI loads it), and under
    `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
    instructions).
  - Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
    runner image tag in the Node/local facades.

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/prompt-fragments@0.13.29

## 0.61.2

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/prompt-fragments@0.13.28

## 0.61.1

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/prompt-fragments@0.13.27

## 0.61.0

### Minor Changes

- 5b1cbbf: feat: repo-sourced Claude Skills library — data + sync core (slice 1)

  Land the persistence + sync foundation for the repo-sourced Claude Skills
  initiative (docs/initiatives/repo-skills.md):

  - New account-tier tables `skill_sources` + `account_skills` (D1 migration 0052
    ⇄ Drizzle schema + migration), with matching kernel ports
    (`SkillSourceRepository`, `AccountSkillRepository`) and both D1 and Drizzle
    repositories, asserted by a new cross-runtime conformance suite.
  - A shared `repo-source-sync` helper extracted from the fragment library's sync
    mechanics (commit-pin-before-read, id-keyed tombstone sweep, invalidate-only-on-
    change, the status probe) plus a shared frontmatter parser; `FragmentSourceService`
    is refactored onto it, and the new `SkillSourceService` reuses it for the
    directory-per-skill (`<skill>/SKILL.md` + resources) sync unit.
  - `SkillCatalogService` (the account skill-catalog read) backed by a new
    `AppCaches.skillCatalog` cache slice (pass-through on the Worker, like
    `fragmentCatalog`).
  - Contracts + an account-scoped `SkillLibraryController` (list skills; link / list /
    sync / status / unlink sources), wired into all runtime facades. Opt-in behind the
    existing prompt-library flag.

  `RepoContentEntry` gains an optional `size` (populated from the GitHub contents API)
  so the skill resource manifest can record file sizes.

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/prompt-fragments@0.13.26

## 0.60.0

### Minor Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/prompt-fragments@0.13.25

## 0.59.2

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2
  - @cat-factory/prompt-fragments@0.13.24

## 0.59.1

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.59.0

### Minor Changes

- 995249b: feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

  Spike tasks now run as a real timeboxed investigation that produces a findings document
  instead of falling through to a full code-and-PR build:

  - A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
    `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
    findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
    checkout-free `RepoFiles` port — no harness change.
  - Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
    `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
    and opens a PR that the review/merge tail lands, so protected base branches are respected and
    review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
    pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
  - New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
    engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
    deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
    merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
    now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
  - A no-PR completion path in the engine: a task run that opened no pull requests now finishes
    `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
    notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
  - Spike creation collects research criteria (research question, success criteria, options to
    compare, target path) alongside the time-box; all are folded into the spike prompt (the
    time-box as a scope-discipline directive). New copy is translated across all locales.

  A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
  render is skipped rather than failing the run; a rejected direct commit is best-effort (the
  findings already live on the step), while a PR-mode open failure is surfaced.

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/prompt-fragments@0.13.23

## 0.58.1

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1
  - @cat-factory/prompt-fragments@0.13.22

## 0.58.0

### Minor Changes

- b414f34: PR deep-review: resolve a parked review by fixing or posting the selected findings.

  The `pr-review` window now offers two terminal resolutions alongside `Finish`, both acting on
  the human's curated finding selection:

  - **Fix** re-dispatches the `pr-reviewer` step as a Fixer (`FIXER_AGENT_KIND`) that clones the
    reviewed PR's head branch, commits fixes addressing the selected findings, and pushes back onto
    it (no new PR).
  - **Post** publishes the selected findings as a single advisory (`COMMENT`) inline PR review — each
    line-anchored finding as an inline comment, the rest folded into the review body.

  Two new optional VCS reads/writes back these resolutions — `getPullRequestHeadRef` and
  `createReview` on the neutral `VcsClient` + `GitHubClient` ports (GitHub-implemented, omitted on
  GitLab), surfaced to the engine through the checkout-free `RepoFiles` seam. All review state stays
  on `step.prReview` (no side table); a cross-runtime conformance assertion covers both resolutions.

  Scoped to a same-repo, non-fork PR (the reviewer's existing limitation); a cross-repo `prUrl` and
  fork PRs remain a tracked follow-up. See `backend/docs/adr/0023-pr-deep-review.md`.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/prompt-fragments@0.13.21

## 0.57.0

### Minor Changes

- a552283: PR deep-review: park a review run on its findings for a human to select which to act on.

  The read-only `pr-reviewer` no longer finishes a review task the moment it returns. Its
  sliced, prioritized findings are now recorded onto the run's `pr-reviewer` step
  (`step.prReview`) and the run PARKS for a human to visually SELECT which findings matter
  through a dedicated multi-select window (findings grouped by slice, severity badges), then
  resolve. A `pr_review_ready` inbox card (routable to Slack) is raised on park. A clean PR
  (no findings) passes through and finishes as before.

  All review state rides the step (no side table), so D1 ⇄ Drizzle parity is free; a
  cross-runtime conformance assertion covers the park → select → resolve loop. The two
  terminal resolutions — feed the selected findings to a Fixer, or post them as inline PR
  review comments — are the tracked follow-up; this ships the slicing → park → multi-select
  loop with a neutral `finish` resolution.

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/prompt-fragments@0.13.20

## 0.56.0

### Minor Changes

- 55cae97: Add a **Review** task type for deep-reviewing an existing open pull request.

  A `review` task defaults to the new `pl_review` pipeline, which runs a built-in read-only
  `pr-reviewer` agent: it slices the PR's diff into cohesive chunks, reviews each within a
  bounded context (so token usage scales on huge PRs), and returns prioritized findings
  rendered in the generic structured result view. The create-task form gains a Review type
  with a target-PR field and an optional review focus.

  Foundations for the tracked follow-ups (human finding-selection + fix/inline-comment
  resolutions): a new provider-neutral `VcsClient`/`GitHubClient.listChangedFiles` method
  (implemented for GitHub), and a no-PR terminal path so read-only pipelines that open no PR
  finish cleanly as `done` instead of stranding on a confirm-and-merge notification.

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/prompt-fragments@0.13.19

## 0.55.0

### Minor Changes

- f7e7139: Make `type: 'library'` frames behave correctly end-to-end (P0 of the library-frame-support
  initiative). Previously picking `library` at import/bootstrap changed almost nothing: build
  pipelines dispatched a deployer (a no-op at best) and an EXPLORATORY tester against a running
  system that a published package doesn't have, and an infra-needing library's suite failed on a
  missing DB because the harness's in-container compose stand-up was dormant.

  Behaviour now ADAPTS to the frame, not to a copy of the pipeline catalog — via a single pure
  capability profile shared by the engine + prompts:

  - **`frameProfile(type)` (contracts)** — a table beside `visual-pipeline.ts` mapping a frame's
    block `type` to `{ deployable, liveTestable, hasUi, testPosture }`. `library` ⇒ not deployable,
    not live-testable, no UI, `suite` posture; `frontend`/`service` keep their deployable/exploratory
    defaults; any other type defaults to the service profile. The resolved frame `type` is carried on
    `AgentRunContext.service.type` so the deployer/tester paths and prompts can consult it.
  - **Deployer no-ops on a library frame** regardless of its `provisioning` (a declared compose path
    on a library is repo-local TEST infra, not an environment): the runtime deploy loop records a
    library skip with an explanatory step output, and the run-start deployer-config /
    deployer-before-consumer / tester-infra gates pass through — so a library never demands a
    workspace environment handler.
  - **Tester runs in suite posture on a library frame** (`TESTER_SYSTEM_PROMPT` +
    `testerEnvironmentSection`): run the unit + integration suite, assess public-API coverage against
    the change, and author the missing tests — instead of exploratory testing of a running system.
  - **Local test infra revived for libraries** (`testerInfraSpec`): a library frame emits
    `{ environment: 'local', composePath }` when it declares a repo/package-local compose file — which
    brings the harness's dormant `standUpInfra` DinD path back to life on localhost — else
    `{ environment: 'local', noInfraDependencies }` and the tester self-manages test deps via the
    repo's `pretest:ci`/`test:ci`/`posttest:ci` lifecycle scripts. No harness image change (the
    `composePath` wire shape already exists).

  Cross-runtime conformance asserts the whole thing: a deploy+test pipeline on a task under a real
  `library` frame runs the deployer as a library no-op (provider never reached, no environment) and
  the tester to completion — even when the frame declares a `docker-compose` path.

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/prompt-fragments@0.13.18

## 0.54.12

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.54.11

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/prompt-fragments@0.13.17

## 0.54.10

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/prompt-fragments@0.13.16

## 0.54.9

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.54.8

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.54.7

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/prompt-fragments@0.13.15

## 0.54.6

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.54.5

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.54.4

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.54.3

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5
  - @cat-factory/prompt-fragments@0.13.14

## 0.54.2

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.54.1

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.54.0

### Minor Changes

- d1a4129: Complete the implementation-fork decision phase with grounded CHAT (PR 2 of the initiative).
  Before the Coder writes code, a human parked on the surfaced forks can now ask questions about
  them and get a grounded, comparative answer before deciding. Each human turn is answered by an
  inline LLM in the durable driver (no container re-dispatch) over the fixed proposal grounding +
  the thread; a `maxChatTurns` budget bounds spend, and with no chat model wired the chat degrades
  to a canned "chat unavailable" reply so pick / custom still work. Adds the
  `POST /executions/:id/fork-decision/chat` endpoint, the `fork-chat` prompt (v1), the
  `ForkChatService`, the `pendingForkChat` re-entry protocol, the window chat thread, and the
  cross-runtime + e2e coverage. The fork-decision initiative tracker is converted to ADR 0022.

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2
  - @cat-factory/prompt-fragments@0.13.13

## 0.53.6

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.53.5

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.53.4

### Patch Changes

- cc6d554: Elaborate the model-provisioning failure messages with cause + fix + doc links (error-message
  coverage initiative, items B1–B4). Each terse throw now names the condition, the likely cause,
  the exact remedy (UI-first where the setting is UI-configurable, the env var otherwise), and links
  `backend/docs/model-support.md` / `docs/environment-variables.md`.

  - **B1** — `Unsupported model provider: X` (`CompositeModelProvider.resolve`) now explains that the
    provider has no credentials configured, names the workspace AI provider key pool as the primary
    fix for the UI-configurable direct providers and the deployment env vars (`CLOUDFLARE_*`,
    `BEDROCK_REGION`) as the alternative, and lists the currently-registered providers as a diagnostic.
  - **B2** — `Unsupported Bedrock model: X` now names the `BEDROCK_MODELS` allow-list, echoes the
    models it currently permits, and tells the operator to add the id or pick an allowed one.
  - **B3** — LiteLLM selected without a base URL gets a dedicated remedy naming `LITELLM_BASE_URL`
    (an operator-hosted gateway has no public default), instead of the generic "no base URL" message.
  - **B4** — `No base URL configured for OpenAI-compatible provider 'X'` now names the
    `${PROVIDER}_BASE_URL` var and the workspace key pool. The inline model resolver and the container
    LLM proxy share one helper (`openAiCompatibleBaseUrlError`) so both surfaces read identically.

  Adds a small `providers/docs.ts` doc-URL module to `@cat-factory/agents` (it sits below the server
  layer, so it cannot use `@cat-factory/server`'s `config/docs.ts`); `@cat-factory/provider-bedrock`
  imports it. No behaviour changes beyond the message text.

## 0.53.3

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.53.2

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.53.1

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1
  - @cat-factory/prompt-fragments@0.13.12

## 0.53.0

### Minor Changes

- 4f936de: Add the optional implementation-fork decision phase on the Coder step. Before the Coder
  writes code, a read-only `fork-proposer` explore agent can aggressively surface the materially
  different ways to implement a task; the run parks for a human to pick a proposed fork or enter
  their own approach, and the chosen approach is folded into the Coder's prompt as a binding
  directive. The phase is gated per-task by a tri-state (`auto`/`always`/`off`) and, in `auto`,
  by an estimate gate on the workspace risk policy (`riskPolicy.forkDecision`, disabled by
  default). All state rides the run's coder step (`step.forkDecision`), so it is
  runtime-symmetric across the Cloudflare and Node facades (D1 ⇄ Drizzle: the new
  `merge_threshold_presets.fork_decision` column). This slice ships propose → park → choose →
  Coder plus the single-path auto-advance; grounded chat about the forks lands in a follow-up.

  Breaking: the built-in merge-threshold preset catalog version is bumped (Balanced /
  Manual review only → v3) to seed the new `forkDecision` gate; workspaces are advised to reseed.
  The `build` Coder prompt is bumped to v4 and a new `fork-proposer` v1 prompt is added.

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/prompt-fragments@0.13.11

## 0.52.9

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/prompt-fragments@0.13.10

## 0.52.8

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.52.7

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/prompt-fragments@0.13.9

## 0.52.6

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.52.5

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/prompt-fragments@0.13.8

## 0.52.4

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.52.3

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.52.2

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.52.1

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.52.0

### Minor Changes

- b83bcc8: Requirements review: auto-recommend answers for findings that don't need a business decision.

  The requirements reviewer now classifies each finding it raises as `autoAnswerable` — answerable
  confidently from universal engineering/product best practice or the context already provided
  (vs. needing a genuine business/product decision). For the `autoAnswerable` findings, the
  Requirement Writer AUTO-generates a grounded recommendation and it is auto-accepted as the
  finding's **default answer** (pre-filled, editable, dismissable), so the human only hand-answers
  the findings that genuinely need their input. Findings needing a business decision are left blank
  and flagged "needs your input"; the human still drives incorporation. The reviewer prompt is
  bumped to `requirement-review@v3`.

  The behaviour is configurable per pipeline step: a new **auto-recommendation** toggle on the
  `requirements-review` step in the pipeline builder (**on by default**). Disabling it reverts to
  the fully-manual flow (answer or request recommendations for every finding).

  This introduces the extensible per-step **`stepOptions`** seam — a single JSON bag
  (`pipelines.step_options`, parallel to `agentKinds`) that is the going-forward home for new
  per-step pipeline parameters, replacing the "one array + one column per knob" pattern
  (`autoRecommend` is its pilot field). See `docs/initiatives/pipeline-step-options.md` for
  folding the legacy per-step arrays (`gates`/`thresholds`/`enabled`/`consensus`/`gating`/
  `followUps`/`testerQuality`) into it.

  Persistence: a new nullable `step_options` column on `pipelines`, mirrored across the D1 and
  Drizzle stores (no data migration — absent ⇒ all defaults). Requirement-review items and
  recommendations gain optional `autoAnswerable` / `auto` fields (stored in the existing JSON
  columns, no migration).

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/prompt-fragments@0.13.7

## 0.51.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/prompt-fragments@0.13.6

## 0.50.0

### Minor Changes

- ed77be6: Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
  initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
  registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
  threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
  This removes the shared process state and the external-adapter module-identity gotcha: a deployment
  registers its own presets by reference on the instance the facade injects.

  BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
  `registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
  `initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
  `InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
  (`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
  instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
  / `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
  as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2
  - @cat-factory/prompt-fragments@0.13.5

## 0.49.3

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.49.2

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.49.1

### Patch Changes

- 9aa9e19: Initiatives: phases can now declare a `checkpoint` (slice 2 of the
  custom-initiative-definitions initiative). A checkpoint phase PAUSES the initiative for
  human review once every one of its items settles, before the next phase spawns — so a
  human can read the phase's committed output (e.g. a research doc + GO/NO_GO verdict) and
  then resume to continue or cancel to stop. The engine never interprets an LLM verdict:
  the pause is declarative phase data the loop reads, and resume is the acknowledgment.

  - Contracts: `checkpoint?` on the plan/entity/draft phase and the preset phase-template
    phase, plus `checkpointClearedAt?` bookkeeping on the entity phase; a new `checkpoint`
    reason on the `initiative` notification.
  - Ingest stamps a template-authored `checkpoint` onto the matched phase (forced on — the
    planner cannot unset it), honours a planner-authored one on any draft phase (generic,
    usable without a preset), and preserves `checkpointClearedAt` across a re-plan.
  - The execution loop pauses at a completed, uncleared checkpoint phase (checked before
    completion, so a last-phase checkpoint still pauses) and raises the notification;
    `InitiativeService.resume` clears the checkpoint in the same CAS transform it resumes in.
  - The in-repo tracker markdown annotates a checkpoint phase (pending vs cleared).

  Non-checkpoint phases are byte-for-byte unchanged — a plan with no `checkpoint` advances
  exactly as before.

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1
  - @cat-factory/prompt-fragments@0.13.4

## 0.49.0

### Minor Changes

- 63f7881: Code Commenter is now a business-as-usual step in the full build pipelines, keeping in-source
  comments relevant and up to date on every task instead of only on a dedicated standalone run.

  - **Full pipelines gain a `code-commenter` step** (`pl_full` and `pl_fullstack`, versions bumped
    for the reseed): it runs right after the `reviewer` clears the implementation and edits comments
    only — adding why-not-what comments, updating ones that have drifted from the code, and deleting
    noise comments that merely restate what the code already says — with no behaviour change. The
    existing `ci` step is the backstop that proves the comment-only diff is behaviour-neutral before
    `merger` ships it.
  - **One parametrized agent serves both use-cases.** A new adaptive clone mode `pr-or-work`
    (`AgentCloneSpec.branch`) makes the Code Commenter amend the block's existing PR in place when
    there is one (the BAU pipeline case — the well-commented code ships in the coder's own PR) and
    fall back to branching off base and opening its own PR when there is none (a standalone
    `pl_code_comments` run or an initiative-framed sweep of a legacy codebase). It is
    `noChangesTolerated`, so a run that finds the comments already in good shape is a clean
    non-event rather than a failure. No new agent kind, no executor-harness image change.
  - The Code Commenter's prompt now actively **maintains** existing comments (fix/remove stale ones,
    strip redundant ones) rather than only adding new ones, and scopes a BAU run to the files the
    pull request changes.
  - **Hardening:** `agentPresentationSchema.description` is now required and non-empty
    (`minLength(1)`, like `label`/`icon`/`color`). The SPA renders a registered kind's description
    verbatim in the pipeline builder palette with no fallback, so a blank one would have surfaced as
    an empty description on a first-class palette block; this makes that impossible at the wire
    boundary. Every existing agent kind already ships a description, so nothing changes for them.

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/prompt-fragments@0.13.3

## 0.48.5

### Patch Changes

- bcc843d: Initiatives: an initiative preset's per-agent-kind `promptAddition` now reaches the
  runs SPAWNED by that initiative (a task's coder / tester / custom kind), not only the
  initiative's own planning run. The `AgentContextBuilder` resolves the preset's steering
  for any block carrying `initiativeId` (gated on it, so plain tasks pay nothing), and a
  shared `initiativePresetSection` renderer folds the `## Initiative preset:` steering into
  the standard-phase, generic custom-kind, and planning prompts alike — including a custom
  kind that supplies its own user prompt (the steering is folded in ahead of it). This is the vehicle
  for an org to attach standing role/task methodology to built-in agents without forking
  them (slice 1 of the custom-initiative-definitions initiative). No behaviour changes for
  non-initiative runs — their prompts stay byte-for-byte identical.
- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.48.4

### Patch Changes

- a2db337: Fix initiative planning interview wedging after "Continue"/"Proceed", and surface a
  "Run planning" start control on the initiative board card.

  - **Engine:** the step re-park guard in `ExecutionService` never let a _resumed_
    interactive-interviewer step (initiative planning + document interviewer) fall through to
    its gate evaluation — it re-parked the run immediately, so pressing Continue/Proceed
    loaded briefly and then hung on the same questions. The guard, the generic approve/reject
    guard, AND the step-handler dispatch in `RunDispatcher` now all key off a new
    `interview-gate` agent **trait** carried by both interviewer kinds — the dispatch routes
    by trait to the controller registered for the step's `agentKind`, so a resumed interview
    (one carrying `pendingInterview`) re-runs the interviewer in the durable driver instead of
    wedging. Fully trait-based rather than kind-based, so a future interviewer just carries the
    trait and wires its controller — no engine branch.
  - **Board:** an initiative card now offers "Run planning" (and, while the interview is
    parked, "Answer planning questions") directly on the board, mirroring a task card's
    on-card Start affordance instead of hiding it behind selecting the block. The card and the
    inspector share a single `useInitiativePlanning` composable (no duplicated planning logic):
    the "Answer planning questions" affordance now keys on the interview's parked status alone
    (so it stays reachable once every question is answered but before the human resumes), and
    the optimistic start flag clears the moment the run takes over (so the button can't strand
    itself spinning after a cancel).

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/prompt-fragments@0.13.2

## 0.48.3

### Patch Changes

- 35636d5: Re-export the canonical migration phase-id constants (`MIGRATION_PHASE_IDS`,
  `MIGRATION_PHASE_ID_ORDER`, and the `MigrationPhaseId` type) from the package index. They are the
  contract shared by the tech-migration preset's `phaseTemplate`, its `promptAdditions`, and
  `seedMigrationPlan`; exporting them lets the migration end-to-end test reference the ids by import
  rather than retyping strings that could silently drift from the template the ingest normalizer
  matches on. Additive — no behaviour change.

## 0.48.2

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.48.1

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/prompt-fragments@0.13.1

## 0.48.0

### Minor Changes

- 4775c40: Register `preset_tech_migration`, the Technological-migration initiative preset (tech-migration slice
  T8) — the second real consumer of the initiative-preset primitives and the one that proves "preset as
  a mandated multi-phase methodology". It is pure WIRING that composes the already-landed migration
  pieces: a create-time FORM (which migration, from/to tech, stored-proc policy, compat posture,
  coverage bar, migration docs dir), the interviewer-driven `pl_initiative` planning pipeline
  (`interview: 'full'`, `humanReviewDefault: true`), a declarative five-phase `phaseTemplate`
  (blast-zone → coverage → transition-design → delivery → verify-decommission, all required, no extras)
  enforced by the generic ingest normalizer, the conservative execution policy (`maxConcurrent: 2`,
  `pl_quick` default escalating risky/complex items to `pl_full`, `onMissingEstimate: 'strongest'`),
  `seedMigrationPlan` (T7) as its `seedPlan` for per-item spawn decoration + the confidence-case
  control point, the T5 methodology `promptAdditions` for the interviewer/analyst/planner, and the
  full T4 `MIGRATION_FRAGMENT_IDS` as `defaultFragmentIds`. It registers as an import side effect (the
  docs-refresh / `@cat-factory/gates` pattern) so both runtimes pick it up with no per-facade wiring,
  and carries NO `detect` hook (its derived `probe` is false — a create-time probe could read only the
  FROM-side stack, which the analyst rediscovers far more thoroughly at planning time).

## 0.47.0

### Minor Changes

- f97d5d3: Add `seedMigrationPlan`, the `preset_tech_migration` plan post-processor (tech-migration slice T7),
  landed unwired ahead of the preset registration (T8). Running at ingest after the generic
  phase-template normalizer, it stamps per-item spawn DECORATION keyed off each item's migration phase:
  the blast-zone report + transition-design document(s) become `document` tasks with `.md` target paths
  under the frozen `migrationDocsDir` on the doc-quick pipeline; coverage/delivery/verify items stay
  ordinary coding tasks routed by the policy's estimate rules. It wires the phase-2 confidence case — a
  single human-gated `confidence-case.md` document that `dependsOn` every surviving coverage item,
  canonicalizing a planner-authored one or injecting it when omitted — caps phase-2 coverage at eight
  items (scrubbing dropped ids from every surviving `dependsOn`), and applies the human-review gate
  policy (confidence-case + transition-design are always gated as the coverage→delivery control points;
  `humanReview` additionally gates the informational blast-zone report). Every spawned item carries the
  `migration.*` fragments that APPLY to its primary producer — `coder` for coding items, `doc-writer`
  for documents — via the new `migrationFragmentIdsFor(agentKind)` from `@cat-factory/prompt-fragments`
  (alongside the full-set `MIGRATION_FRAGMENT_IDS` T8's `defaultFragmentIds` reuses), so a document
  task no longer receives the coding-only behaviour-preservation standard (manual `fragmentIds` pins
  bypass `appliesTo` at run time, so the scoping is applied at stamp time). The shared `seedPlan`
  primitives (`strInput`/`fileSlug`/`uniqueDocPath`/`mergeGateOverride`) are lifted into
  `presets/plan-helpers.ts` so docs-refresh and tech-migration share one implementation. Pure + total;
  no runtime behaviour changes until T8 registers the preset.

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/prompt-fragments@0.13.0

## 0.46.0

### Minor Changes

- cb088c7: Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
  can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
  (`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
  per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
  resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
  existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
  (`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
  until it ends — and a queued call whose request is aborted releases its slot instead of
  head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
  are capped; API-key vendors and Cloudflare pass through untouched.

  Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
  `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
  `<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
  per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
  The limiter is
  in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
  scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
  sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
  across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
  refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
  bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
  wired pass-through elsewhere.

## 0.45.0

### Minor Changes

- 09a1c85: Technological-migration initiative — slice T5: the methodology prompt pack + the interviewer
  promptAddition seam.

  Adds `backend/packages/agents/src/presets/tech-migration/`, the code-side methodology steering the
  upcoming `preset_tech_migration` registration (T8) will spread onto its `promptAdditions`. Kept OFF
  the wire descriptor per the parent's off-the-wire rule (the descriptor's `phaseTemplate` carries
  only the short phase ids/titles/goals; the deep methodology lives here):

  - **`phases.ts`** — `MIGRATION_PHASE_IDS` (+ `MIGRATION_PHASE_ID_ORDER`), the single canonical
    phase-id contract shared by the phase template, this prompt pack, the plan post-processor
    (`seedMigrationPlan`, T7) and the migration E2E (T10), so no consumer retypes a phase id (a typo
    would silently break the ingest normalizer's verbatim id match).
  - **`prompt-additions.ts`** — `MIGRATION_PROMPT_ADDITIONS` (keyed by the kernel initiative kind
    constants) with the interviewer / analyst / planner steering: the interviewer probes the fuzzy,
    form-uncapturable migration facts (downtime tolerance, data-migration constraints, compat posture)
    and never re-asks the seeded form; the analyst produces the direct + TRANSITIVE blast-zone
    inventory with per-touchpoint existing-test coverage; the planner authors per-phase item briefs
    (single-writer artifacts, the human-gated confidence-case item, coverage-before-delivery),
    referencing the canonical phase ids verbatim.

  Completes the interviewer half of the preset `promptAdditions` seam in
  `InitiativeInterviewService`: the analyst/planner already fold their steering via `AgentContextBuilder`
  → `initiativeContextLines`, but the interviewer is an inline service that builds its own prompt, so it
  now folds `promptAdditions['initiative-interviewer']` under the same `## Initiative preset: <label>`
  heading. Generic and preset-less initiatives register none, so their interview stays byte-for-byte
  unchanged — the migration preset is simply the first FULL-interview preset to steer its interviewer.
  Both changes are dormant data + a generic seam until T8 registers the preset; the loop never branches
  on a preset id.

## 0.44.1

### Patch Changes

- 785576b: Initiative presets — docs-refresh preset review fixes (follow-up to slice 8, #911):

  - **`seedPlan` deduplicates derived target paths.** Two items whose titles slug to the same name
    under one directory (e.g. two `diagrams` items) would previously stamp the SAME `targetPath`,
    spawning two doc tasks that open competing PRs writing one file. Derived `<dir>/<slug>.md` paths
    are now uniquified (`-2`, `-3`, …) across the plan.
  - **Human review gates the `merger` step, derived from the pipeline shape.** `docsReviewGates` no
    longer hand-maintains per-pipeline boolean arrays; it derives the override from each pipeline's
    `agentKinds` and places the single gate on `merger`, so the human reviews the CI-green PR right
    before it merges — the same review point for EVERY doc pipeline (previously `pl_document_quick`
    gated a mid-pipeline `doc-reviewer` that still auto-merged afterwards, contradicting the form's
    "review each documentation change before it merges" promise). Correct-by-construction against
    pipeline-shape drift instead of relying on a length drift-guard.
  - **README items are writer-placed from the description, not a dead `targetPath` mechanism.** The
    planner's structured output has no `spawn` field (`INITIATIVE_PLANNER_SYSTEM_PROMPT`), so
    `coerceInitiativePlan` never carries a planner-authored path to `seedPlan` — the old
    `authored-readme` branch was inert. READMEs now name their per-service path in the item
    description (like `comments`/`business-rules`) and carry no `targetPath`.
  - **`seedPlan` merges its decoration OVER any planner spawn** (so a planner-authored `agentConfig`
    survives) rather than replacing it, and reuses the package's shared `moduleSlug` for the file
    slug instead of a fourth copy of the kebab-slug helper.
  - **Planner steering keeps the required `foundations` phase present** (0 items when the dirs already
    exist) rather than implying the phase may be dropped — which the exhaustive `phaseTemplate` would
    reject as a missing required phase, failing the whole plan ingest.

## 0.44.0

### Minor Changes

- f1906cb: Initiative presets — slice 8 (docs-refresh pilot): register the `preset_docs_refresh` initiative
  preset — the FIRST real preset, and the registration pattern the technological-migration preset
  (T8) copies. Incorporates inter-phase follow-up #1 (adopt the generic `phaseTemplate` shape
  enforcement; do NOT hand-roll phase shaping in `seedPlan`); follow-up #2 (templated pipelines)
  stays deferred.

  - **agents** (`presets/docs-refresh/preset.ts`): the `preset_docs_refresh` registration — a
    descriptor FORM (doc types, placement mode, docs/diagrams/business-rules dirs with `showWhen`,
    scope hint, human-review opt-in, writing-style fragments), a `detect` probe reusing slice 6's
    `detectDocsLayout`, a declarative `phaseTemplate` (Foundations `required` + one OPTIONAL phase
    per doc type, `allowAdditionalPhases: false`), `promptAdditions` turning the analyst into a
    documentation gap-auditor and shaping the planner's phases + item granularity, and a `seedPlan`
    that stamps per-item spawn DECORATION only (pipeline per doc type, `taskType`/`docKind`/derived
    `targetPath`, writing-style `fragmentIds`, and — when human review is opted in — the per-run
    `spawn.gates` override at each pipeline's review point). Registered as a module side effect on
    import (the `@cat-factory/gates` pattern), so it is available in every deployment with no
    per-facade wiring — the two runtimes cannot drift on it. Plan SHAPE lives in the template + the
    generic ingest normalizer; DECORATION lives in `seedPlan`; the two never overlap.
  - **kernel** (`domain/seed.ts`): the preset's interviewer-free planning pipeline
    `pl_initiative_docs` (`[initiative-analyst, initiative-planner, initiative-committer]`, no human
    gates — the form is the interview; per-task review is the opt-in gate-override seam) + its
    exported id `INITIATIVE_DOCS_PIPELINE_ID`, plus `DOCUMENT_QUICK_PIPELINE_ID` for the README /
    diagram spawn pipeline.
  - **prompt-fragments**: re-export the `styleFragments` collection so the preset builds its
    writing-style form options from the same source of truth (no duplicated fragment ids/labels).

  Backend-only: the SPA renders the new preset from its descriptor with no frontend changes (the
  slice-4 generic form renderer + picker), and human review maps to SPAWNED-task gates, so the
  planning run stays unattended.

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0
  - @cat-factory/prompt-fragments@0.12.0

## 0.43.1

### Patch Changes

- Updated dependencies [4a7fca0]
  - @cat-factory/prompt-fragments@0.11.0

## 0.43.0

### Minor Changes

- 44fafa4: Inline subscription LLM steps can now run inside a prewarmed local container on a leased
  subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
  job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
  usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
  local inline resolver now selects the developer's host CLI when its binary is present (ambient,
  unmetered) and otherwise the container backend on a leased credential — personal per-run
  activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
  This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
  host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
  non-native claude-code vendors.

  Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
  takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
  interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
  the run's execution + initiator so the container backend can lease the right credential.
  `buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
  closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.42.0

### Minor Changes

- 89c861a: Initiative presets — slice 7 (docs-refresh pilot): the in-source comment annotator + the lean
  spawn pipelines the preset drives.

  - **agents** (`agents/kinds/code-commenter.ts`): a new built-in `code-commenter` agent kind,
    pre-loaded by `defaultAgentKindRegistry()`. It adds and clarifies WHY-not-what comments in
    EXISTING source with **no behaviour change** — a container-coding kind that runs the generic
    work-branch → PR lifecycle (`buildRegisteredAgentBody`, no bespoke harness handler, no
    executor-harness image bump), `doc-aware` so the engine folds the block's writing-style
    fragments into its prompt. Its system prompt hard-forbids touching executable code (comments /
    docstrings only), and the pipeline's `ci` step is the backstop that proves the diff is
    behaviour-neutral. Being a side-effect kind (its product is a pushed commit) it deliberately does
    NOT carry `FINAL_ANSWER_IN_REPLY`.
  - **kernel** (`domain/seed.ts`): two lean built-in spawn pipelines the docs-refresh preset stamps
    onto its spawned tasks (also pickable standalone) — `pl_code_comments`
    (`[code-commenter, conflicts, ci, merger]`) and `pl_business_docs`
    (`[business-documenter, conflicts, ci, merger]`, reusing the existing reverse-doc kind) — plus
    their exported ids (`CODE_COMMENTS_PIPELINE_ID` / `BUSINESS_DOCS_PIPELINE_ID`).
  - Design note (see the tracker's slice-7 row + inter-phase follow-up): after review, this is the
    MINIMAL set — Mermaid diagrams and READMEs reuse `doc-writer` / `pl_document_quick` (a diagram
    doc is just Markdown a writer produces), so `code-commenter` is the only genuinely-new capability
    and no `diagram-author` kind / `pl_diagrams` pipeline are added.

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.41.0

### Minor Changes

- 2d97812: Initiative presets — slice 6 (docs-refresh pilot): deterministic documentation-layout
  autodetection.

  - **agents** (`presets/docs-refresh/docs-detect.logic.ts`): a new pure `detectDocsLayout(reader)`
    heuristic — the checkout-free repo probe behind the docs-refresh preset's form prefill (its
    `detect` hook lands in slice 8). Over a narrow `DocsRepoReader` (a `RepoFiles` satisfies it
    structurally) it proposes the preset's placement DEFAULTS without a clone: the docs root
    (`docs`/`doc`/`documentation`), the diagrams + business-rules subfolders (known dir-name
    heuristics under the detected root), a monorepo flag (workspace manifest / `package.json`
    `workspaces` / conventional `packages`|`apps`|`services`|`libs` dirs), a `per-service` vs `root`
    placement decision (sampled from whether most packages carry their own docs), and an
    `hasExistingMermaid` hint for the analyst.
  - Deterministic, memoized, bounded by a hard read budget, and TOTAL — it never throws and never
    rejects, so an unwired GitHub / a partial or unreadable repo simply yields the conventional
    defaults (a prefill must never block create). Detected values are non-binding FORM DEFAULTS; a
    user edit wins and the analyst confirms placement at planning time.
  - **kernel** (`shared/repo-scan.logic.ts`): extracts the checkout-free scan primitives the repo
    auto-detectors share — `joinRepoPath` + the budgeted, memoized `BudgetedRepoScanner` (over a
    `CheckoutFreeRepoReader`) — into one home, so a fix to path normalization / caching / budget
    lands once instead of drifting across copies.
  - **integrations**: the service-provisioning (`provision-detect`) and frontend-config
    (`frontend-detect`) detectors now consume the shared kernel primitive instead of their own
    private `joinPath` + `Scanner` copies — a behaviour-neutral refactor (the shared `exhausted`
    uses the precise "a read was actually skipped" semantics both had converged toward).

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0
  - @cat-factory/prompt-fragments@0.10.27

## 0.40.13

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4
  - @cat-factory/prompt-fragments@0.10.26

## 0.40.12

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3
  - @cat-factory/prompt-fragments@0.10.25

## 0.40.11

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/prompt-fragments@0.10.24

## 0.40.10

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1
  - @cat-factory/prompt-fragments@0.10.23

## 0.40.9

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/prompt-fragments@0.10.22

## 0.40.8

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/prompt-fragments@0.10.21

## 0.40.7

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/prompt-fragments@0.10.20

## 0.40.6

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2
  - @cat-factory/prompt-fragments@0.10.19

## 0.40.5

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/prompt-fragments@0.10.18

## 0.40.4

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/prompt-fragments@0.10.17

## 0.40.3

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/prompt-fragments@0.10.16

## 0.40.2

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1
  - @cat-factory/prompt-fragments@0.10.15

## 0.40.1

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/prompt-fragments@0.10.14

## 0.40.0

### Minor Changes

- bf31df7: Stack recipes & shared stacks (slice 8): the opt-in environment analyst.

  Adds an `environment-analyst` agent kind — the LLM half of environment auto-detection. Where the deterministic detector reads a repo checkout-free and can only see mechanical facts (compose layering, external networks, env-file pairs), the analyst is a read-only `container-explore` agent that CLONES the repo and reads the imperative bring-up a scan can't (README / Makefile / `bin/*` CLIs / setup scripts / seed dumps) to draft a declarative Docker Compose stack recipe — setup steps, prerequisites and a health gate — each grounded in a source citation. It returns the draft on `result.custom` (rendered by the shared `generic-structured` view); it never writes the repo. The draft is NON-BINDING: the setup wizard (slice 7) will merge it over the deterministic recommendation and nothing is applied until the human confirms.

  - Contracts: `AnalystRecipeDraft` / `AnalystRecipeNote` / `AnalystCitation` (`environment-analyst.ts`) — a lenient LLM-output shape (a proposed `StackRecipe` + per-field provenance + summary) that degrades field-by-field on a partially-malformed reply.
  - Agents: the `environment-analyst` kind (registered through the public `AgentKindRegistry` seam, pre-loaded by `defaultAgentKindRegistry()`), with its schema-derived structured output (`failOnUnusableFinal`, so an empty reply fails loudly rather than yielding an empty draft).
  - Kernel: a seeded analyst-only pipeline `pl_environment_analysis` (`ENVIRONMENT_ANALYSIS_PIPELINE_ID`) the wizard runs against a service frame, mirroring `pl_blueprint`.

  No persistence change — the analyst rides the execution engine and the existing `provisioning` blob, so no migration and no runtime asymmetry. The draft-merge + wizard trigger UI land with the wizard (slice 7).

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/prompt-fragments@0.10.13

## 0.39.4

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/prompt-fragments@0.10.12

## 0.39.3

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/prompt-fragments@0.10.11

## 0.39.2

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/prompt-fragments@0.10.10

## 0.39.1

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/prompt-fragments@0.10.9

## 0.39.0

### Minor Changes

- 076d02f: feat(documents): interactive document-review sessions (doc-task WS5)

  Between the outline and the draft, a document-authoring run now converses with the requester
  instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
  after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
  clarifying questions about scope, audience and structure, parks the run on the standard durable
  decision-wait while the human answers through a dedicated window, and iterates (up to a round
  cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
  from (folded into their context via the agent-context builder).

  The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
  parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
  interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
  task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
  table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
  window is wired through the universal result-view seam (`doc-interview`) and updates live over a
  new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
  pipelines run unchanged.

  Hardening: a re-run of a document task now clears the block's prior session before interviewing
  (so it starts clean instead of reusing a stale, already-converged one), the converged brief is
  folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
  interviewer pass that returns neither questions nor a brief fails the run loudly instead of
  silently skipping the interview with an empty brief.

  Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
  interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/prompt-fragments@0.10.8

## 0.38.2

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0
  - @cat-factory/prompt-fragments@0.10.7

## 0.38.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/prompt-fragments@0.10.6

## 0.38.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/prompt-fragments@0.10.5

## 0.37.2

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1
  - @cat-factory/prompt-fragments@0.10.4

## 0.37.1

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/prompt-fragments@0.10.3

## 0.37.0

### Minor Changes

- f4c321e: feat(documents): add the `doc-quality` gate (WS4) to the forward document pipelines

  A new deterministic polling gate `doc-quality`, authored through the public `registerGate`
  seam in `@cat-factory/gates`, is inserted into `pl_document` (after `doc-finalizer`) and
  `pl_document_quick` (after `doc-reviewer`). It reads the drafted document on the PR head
  checkout-free via a new `DocQualityProvider` (wired per facade over `RepoFiles`) and checks
  — against the WS1 template (`docTemplateFor`, the single source of truth) — that every
  required section is present, no leftover placeholders remain, the heading hierarchy is sane,
  and in-repo relative links resolve. On a red verdict it escalates to a new `doc-fixer`
  container helper that repairs the document on the PR branch; a green document advances with
  nothing spun up. Both doc pipelines' `version` is bumped (reseed offer).

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.36.0

### Minor Changes

- 13a284f: Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
  structured `container-coding` agent kind writes one or more tests that fail for the reported
  reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
  the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
  without failing the run. Conceding and reproduced outcomes both advance to the coder; a
  post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
  output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
  objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

  Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
  kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
  coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
  harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
  Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
  uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
  separate project.

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.35.0

### Minor Changes

- 102c049: Document tasks: per-kind specific fields. The create-task form now collects the fields that
  matter for the chosen document kind (PRD target users + success metrics, RFC alternatives +
  rollout concerns, ADR decision drivers + considered options, runbook when-to-use + escalation,
  research question + options to compare, API surface), and the author agents fold them into the
  brief as required content for the matching template sections. The fields live on the sparse
  `taskTypeFields` bag (no migration) with `DOC_KIND_FIELDS` as the single source of truth shared
  by the form and the prompts.

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1
  - @cat-factory/prompt-fragments@0.10.2

## 0.34.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/prompt-fragments@0.10.1

## 0.33.1

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.33.0

### Minor Changes

- 8eaa3f2: Universal writing-style fragments for document-authoring tasks (WS2 of the
  documentation-type task initiative). Two built-in fragments — `style.anti-llmisms`
  (cut the machine-written tells: filler intensifiers, hedging, throat-clearing,
  summary-that-restates, bullet inflation) and `style.concise-actionable` (lead with
  the point, active voice, one idea per paragraph, every recommendation names an actor
  and an action) — now guide the document-authoring agents.

  They reach those agents through a new `doc-aware` capability trait, the document
  analogue of `code-aware`: the `doc-researcher` / `doc-outliner` / `doc-writer` /
  `doc-finalizer` kinds carry it on their definitions and the `doc-reviewer` companion
  carries it too, so the execution engine folds the block's selected style fragments
  into each one's system prompt via the same `AgentContextBuilder` path `code-aware`
  uses — no parallel fragment path in the prompt builders. Because the reviewer sees
  the same bodies, the style guidance is both the writer's instruction and the
  reviewer's criteria (an explicit clause in the companion prompt says so).

  A new document task is pre-seeded with both style fragments (default-on,
  user-removable like any block pin) via `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, seeded
  onto the task's `fragmentIds` in `BoardService.addTask` — the selection default lives
  at task creation, not hard-coded in a prompt.

  The fragment "add" pickers (service, task, and workspace-default) now render their
  options as labelled per-category sections instead of one flat list, so the catalog
  stays navigable now that a block can pin across two tracks at once — the technical
  collections (Node / React / …) and the Writing-style fragments.

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/prompt-fragments@0.10.0

## 0.32.0

### Minor Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

- 6213771: Add a per-`DocKind` document template registry (WS1 of the documentation-type task
  initiative). Each document kind now carries a structured template — required and optional
  sections with per-section authoring guidance — that is the single source of truth for the
  kind's expected shape. The templates are woven into the `doc-outliner` prompt (the outline
  must cover the required sections) and the `doc-writer` prompt (start from the rendered
  skeleton), replacing the previous one-line structure hint. A deployment can override a
  kind's template through the public `registerDocTemplate` seam (an import side effect,
  mirroring `registerPromptFragment`).

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.31.0

### Minor Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.30.5

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/prompt-fragments@0.9.55

## 0.30.4

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/prompt-fragments@0.9.54

## 0.30.3

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/prompt-fragments@0.9.53

## 0.30.2

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1
  - @cat-factory/prompt-fragments@0.9.52

## 0.30.1

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/prompt-fragments@0.9.51

## 0.30.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/prompt-fragments@0.9.50

## 0.29.1

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/prompt-fragments@0.9.49

## 0.29.0

### Minor Changes

- 55661f4: Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
  initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
  runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
  `GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
  GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

  - Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
    one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
    recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
    key is shown once on create.
  - Runs are anchored on a headless `internal` block excluded from every board projection, so the
    external runs never appear in the UI.
  - Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/prompt-fragments@0.9.48

## 0.28.0

### Minor Changes

- ca5c3e8: Initiatives (slice 1 of 4): the long-running, multi-task counterpart to a task — see
  `docs/initiatives/initiatives-feature.md` for the full multi-slice plan.

  - **New `initiative` block level** — a container block under a service frame (created via the
    new "Create initiative" button in the frame header, next to add-task/import-task). Tasks a
    later slice's execution loop spawns link back via the new `blocks.initiative_id` membership
    column (epic-style). D1 migration `0035_initiatives.sql` ⇄ Drizzle schema, shared mapper.
  - **New `initiatives` entity + store** — the DB row is the source of truth (phases, items with
    planner-authored estimates + dependencies, the execution policy with estimate→pipeline rules,
    decisions / deviations / follow-ups / caveats), guarded by a `rev` compare-and-swap so the
    loop has a single logical writer. Mirrored D1 ⇄ Drizzle repositories with a cross-runtime
    conformance suite (CRUD, doc round-trip, CAS conflict, `blocks.initiative_id`).
  - **Initiative Planning pipeline skeleton (`pl_initiative`)** — `initiative-planner` (a
    read-only structured container explore that drafts the multi-phase plan, gated for human
    approval) + `initiative-committer` (a deterministic engine step that flips the entity to
    `executing` and commits the rendered tracker to `docs/initiatives/<slug>/` — canonical
    `initiative.json` + human `tracker.md` + `version.json`, hash-short-circuited and
    replay-safe, following the blueprint artifact pattern). A bidirectional guard in the
    engine's shared `assertRunnable` makes `pl_initiative` the ONLY pipeline runnable on an
    initiative block (and vice versa), across start/retry/restart.
  - **API + snapshot + realtime** — `POST/GET /workspaces/:ws/initiatives` (+ by-block read),
    the snapshot's optional `initiatives` field, and a new `initiative` WorkspaceEvent pushed
    from both runtimes' publishers.
  - **Frontend** — the Create Initiative modal + frame-header button, the initiative board card,
    an inspector body (run planning / open tracker) and the read-only Initiative Tracker window
    (`initiative-tracker` result view), with the `initiative.*` i18n namespace across all 8
    locales.

  Later slices add the interactive planning interview, the execution loop (just-in-time task
  spawning with estimate-gated pipeline selection), and follow-up/deviation harvesting.

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/prompt-fragments@0.9.47

## 0.27.1

### Patch Changes

- cc924a9: Requirements-review recommendations: batch, tighten, and surface what's awaited.

  - The Requirement Writer now answers findings in CHUNKS (up to 4 per LLM call) instead of one
    call per finding, so a batch of N findings costs `ceil(N / 4)` calls rather than N. Shared
    grounding is still gathered once and progress still streams `ready / total` a chunk at a time;
    a failure is isolated to its chunk. Each finding keeps the same per-finding output budget the
    single-call path used (scaled by chunk size), and a batched response is routed back to its
    findings by the echoed itemId with a prompt-order fallback — so a response that drops the ids
    isn't discarded wholesale and the whole chunk force-reopened.
  - The Writer prompt (`requirement-writer`, bumped to v2) now asks for precise, succinct
    recommendations — the concrete answer in a couple of sentences, cite sources briefly, no
    preamble or padding — instead of open-ended prose.
  - The review window now shows a persistent "awaited recommendations" summary (how many the
    Writer is still generating and how many are waiting on the human) in the stats rail, and lets
    you request recommendations while a merged review is being reworked — not only in the initial
    `ready` state.
  - The incorporated-requirements document can now be collapsed as a whole. It defaults to collapsed
    only in the pre-incorporation `ready` phase (so a long doc doesn't push the findings being worked
    through off-screen) and expanded in `merged`/`incorporated`, where the document itself is the
    thing to read; a manual collapse no longer leaks across a status change.

## 0.27.0

### Minor Changes

- b216fdc: Fragment GitHub-source staleness is now a lightweight commit-version check.

  The full fragment bodies were already cached on our side; the "check for changes"
  probe previously re-listed the whole source directory and hashed every blob sha.
  It now reads only the source directory's current head commit sha and compares it to
  the commit the source was last synced to — a single cheap GitHub/GitLab call, no
  directory listing or file reads.

  Breaking (pre-1.0, no migration): `FragmentSource`/`FragmentSyncResult` now expose
  `lastSyncedCommit` instead of `lastSyncedSha`, and `FragmentSourceStatus` is
  `{ changed, lastSyncedCommit, remoteCommit }` (the per-file `changedCount`/`remoteSha`
  are gone — the resync badge is now a plain "changes available" indicator). A new
  `latestCommitSha` port method is added to `GitHubClient` and `VcsClient`. The physical
  `fragment_sources.last_synced_sha` column is unchanged and reused to store the commit
  sha, so no database migration is required; existing rows re-derive their commit on the
  next sync.

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/prompt-fragments@0.9.46

## 0.26.18

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.26.17

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/prompt-fragments@0.9.45

## 0.26.16

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/prompt-fragments@0.9.44

## 0.26.15

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/prompt-fragments@0.9.43

## 0.26.14

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.26.13

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.26.12

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8
  - @cat-factory/prompt-fragments@0.9.42

## 0.26.11

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.26.10

### Patch Changes

- 4955639: Fix five bugs in how best-practice prompt fragments are managed and applied:

  - **Code-aware helper agents now receive the service fragments.** `ci-fixer`, `fixer`
    and `on-call` are dispatched off their HOSTING step (a `ci`/`post-release-health`
    gate, the tester, the human-test/visual-confirmation loops), and the fragment fold
    keyed off that step's kind — so the helpers never received the service's standards
    despite being marked `code-aware`. `AgentContextBuilder.buildContext` now takes an
    explicit `agentKind` override and every helper dispatch passes it; the on-call job
    body additionally folds the resolved fragments into its bespoke system prompt
    (previously bypassed). A stale `step.selectedFragmentIds` is also cleared when a
    re-dispatch resolves to nothing, so observability can't over-report.
  - **Tier tombstones now stick on the run path.** `resolveBodiesForRun` used to fall
    back to the static pool for any id missing from the merged catalog — which is
    exactly what a tombstone does to a built-in, so suppressing a fragment a service
    had selected silently resurrected it. The fallback is gone; a missing id is dropped.
  - **Deployment-registered fragments join the tenant catalog.** The library's built-in
    tier now reads the UNIVERSAL pool (shipped catalog + `registerPromptFragment`
    entries, lazily) instead of the raw shipped array, so a registered override of a
    built-in id actually reaches runs and the resolved catalog, and registered
    fragments can be tier-shadowed/tombstoned like any built-in.
  - **Repo-source resync no longer mishandles renames and id edits.** The tombstone
    sweep is keyed by the fragment ids the current tree produces, not by stale paths:
    renaming a file that pins an explicit frontmatter `id` no longer tombstones the
    fragment the rename just updated, and changing a file's explicit `id` in place now
    retires the old id instead of leaving a live duplicate forever. The GitHub
    installation is also resolved once per sync instead of once per file, and the
    requirement writer's fragment grounding resolves through the merged tenant catalog
    when the library is wired.
  - **The SPA pickers now offer the merged catalog.** The per-service / per-block /
    workspace-default fragment pickers loaded only the static built-in pool, so
    managed, repo-sourced and document-backed fragments could be authored but never
    attached (and a managed id set via API rendered no chip). The fragments store now
    loads the workspace's resolved catalog (falling back to the static pool when the
    library is off), invalidates on library edits, and unknown selected ids render as
    removable chips instead of disappearing. The catalog is per-board, so a workspace
    switch now invalidates it and the task inspector reloads it on mount — otherwise the
    task picker kept showing the previous board's fragments.

  Review follow-ups: `AgentContextBuilder` now clears a stale `step.selectedFragmentIds`
  on the non-code-aware and error paths too (not only when a code-aware resolve is empty);
  the requirement-writer grounding resolves the merged catalog once (reused for titles and
  bodies) instead of twice; a repo-source RENAME of an explicit-id file inherits the
  fragment's `version`/`createdAt` by id instead of resetting them; and the source `status`
  count no longer double-counts a pure rename.

## 0.26.9

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/prompt-fragments@0.9.41

## 0.26.8

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5
  - @cat-factory/prompt-fragments@0.9.40

## 0.26.7

### Patch Changes

- fc8df61: Fix a cross-tenant access hole on the fragment-source routes: `unlink`/`status`/`sync`
  resolved the source by its id alone, so an authenticated member of one account/workspace
  could read, resync or delete another tenant's fragment source by addressing its id under
  their own prefix. `FragmentSourceService.unlink/sync/status` now take the addressed
  `(ownerKind, ownerId)` and 404 when the source belongs to a different owner (breaking
  signature change for direct callers of those three methods).

## 0.26.6

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4
  - @cat-factory/prompt-fragments@0.9.39

## 0.26.5

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3
  - @cat-factory/prompt-fragments@0.9.38

## 0.26.4

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1
  - @cat-factory/prompt-fragments@0.9.37

## 0.26.3

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/prompt-fragments@0.9.36

## 0.26.2

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/prompt-fragments@0.9.35

## 0.26.1

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/prompt-fragments@0.9.34

## 0.26.0

### Minor Changes

- 16621f8: feat(testing): test quality-control companion that loops the Tester on incomplete reports

  The Tester gate concluded a step purely from `greenlight` + blocking concerns + failed
  outcomes, so a report that claimed to exercise many areas (`tested`) but recorded a single
  happy-path `outcome` could greenlight and "pass" — leaving most scenarios as "No discrete
  check recorded" in the Test Report window while the step read as successfully completed.

  Two changes address this:

  - **Tester prompts now require one recorded `outcome` per `tested` area** (API + UI testers):
    every scenario listed as tested must have a matching outcome with a concrete detail, and
    describing results only in the prose `summary` does not count. Genuinely un-exercised areas
    are recorded as `skipped` with a reason rather than dropped.
  - **A new test quality-control companion** (`tester-qc`) audits each Tester report for
    coverage/coherence BEFORE the greenlight/fixer decision. When the report is inadequate it
    loops the Tester for a focused additional pass (folding the prior report + the flagged gaps
    in, and carrying forward already-covered outcomes), bounded by a new merge-preset knob
    `maxTesterQualityIterations` (default 3). Enabled by default; a per-Tester-step toggle in
    the pipeline shape (`pipeline.testerQuality`) disables it or gates it on the task estimate.
    The companion is an inline reviewer (no container) that resolves its model like the other
    inline reviewers and is a pass-through when no model is wired.

  Persistence: the merge preset gains a `max_tester_quality_iterations` column, mirrored across
  the D1 and Drizzle stores (built-in preset seed `version` bumped 1 → 2). The QC loop state
  lives on the execution step, so no new table is added.

  The frontend pipeline-builder toggle + Test Report verdict surfacing land in a follow-up
  (see `docs/initiatives/tester-quality-companion.md`).

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/prompt-fragments@0.9.33

## 0.25.0

### Minor Changes

- f70c273: feat(frontend): `pl_frontend` pipeline + frontend-aware mocker (slice 4 of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  Builds on slice 3's self-contained UI-test infra with the pipeline that drives it and a mocker
  that authors the mocks it needs.

  - **`pl_frontend` built-in pipeline** (`coder → reviewer → mocker → tester-ui → conflicts → ci →
merger`). For a `type: 'frontend'` frame the engine already resolves the frame's
    `frontendConfig` + backend bindings and stands the app + WireMock up in one container (slice 3),
    so this pipeline is just the step order that exercises it end to end: implement → review → mock
    → browser-test → the standard mergeability/CI/merge tail. Labelled `experimental` — two
    deploy-/keying-time steps remain (the `ui`-image per-step routing, and keying a bound service's
    ephemeral env by its FRAME id so a live-service binding resolves instead of falling back to
    WireMock); a mock-only frontend already runs fully self-contained today.
  - **Frontend-aware mocker.** When a `mocker` step runs on a task under a `frontend` frame, its
    user prompt now carries a frontend section: author WireMock stub mappings under the frontend
    repo's mock dir in WireMock's `--root-dir` layout (`<dir>/mappings/*.json` + `<dir>/__files/`)
    for exactly the upstreams the harness points at WireMock (every binding with no live service
    under test), and do NOT wire a docker-compose stack — the platform serves the app + WireMock
    directly. The live service(s) under test are named and explicitly excluded from mocking. A
    backend-service mocker run is unchanged (the section is absent without a resolved frontend
    context). The section explicitly OVERRIDES the docker-compose stand-up guidance in the
    (backend-oriented) mocker role prompt so the two do not contradict for a frontend run, and the
    default WireMock root (`mocks/`) is now the shared `DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH` constant
    in `@cat-factory/contracts` rather than a private literal.

- 6c51e31: Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
  start a pipeline whose model preset can't satisfy every step.

  - **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
    inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
    on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
    analogue of the existing container ambient-auth path. Previously a subscription-only preset
    (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
    unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
    Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
    local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
    degrading it. The consensus executor (an inline path) threads the same predicate, so a
    subscription-only consensus participant model is kept inline in local mode too.
  - **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
    inline-usability, not just container-usability. A subscription-only model that satisfies the
    container agents but can't run the inline reviewers (and this deployment has no inline harness)
    is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
    instead of failing mid-run. The SPA maps the new reason to a translated toast.

  Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
  union gains `preset_unsatisfiable`.

### Patch Changes

- 33687cf: fix(tester): give the Tester standardized env coordinates + real access credentials in its prompt

  The tester prompt claimed a deployed environment's URL and access credentials were "provided to
  the test harness out of band" — but nothing delivered them, so Testers aborted with "no deployed
  URL or credentials found". `environmentSection()` now renders the standardized coordinates
  (URL + derived host/port/scheme) and the FULL endpoint access credentials (bearer token / HTTP
  basic username+password / custom header name+value) directly in the run context.

  These are test-environment access credentials, treated as non-sensitive: the Tester cannot
  authenticate without them reaching the model regardless of channel, so they go straight into the
  prompt rather than a fictional out-of-band path. The tester system prompts and run-mode wording
  now point at the concrete "Ephemeral environment under test" section.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/prompt-fragments@0.9.32

## 0.24.16

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1
  - @cat-factory/prompt-fragments@0.9.31

## 0.24.15

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/prompt-fragments@0.9.30

## 0.24.14

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/prompt-fragments@0.9.29

## 0.24.13

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/prompt-fragments@0.9.28

## 0.24.12

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4
  - @cat-factory/prompt-fragments@0.9.27

## 0.24.11

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3
  - @cat-factory/prompt-fragments@0.9.26

## 0.24.10

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/prompt-fragments@0.9.25

## 0.24.9

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1
  - @cat-factory/prompt-fragments@0.9.24

## 0.24.8

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/prompt-fragments@0.9.23

## 0.24.7

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4
  - @cat-factory/prompt-fragments@0.9.22

## 0.24.6

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3
  - @cat-factory/prompt-fragments@0.9.21

## 0.24.5

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2
  - @cat-factory/prompt-fragments@0.9.20

## 0.24.4

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1
  - @cat-factory/prompt-fragments@0.9.19

## 0.24.3

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0
  - @cat-factory/prompt-fragments@0.9.18

## 0.24.2

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1
  - @cat-factory/prompt-fragments@0.9.17

## 0.24.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/prompt-fragments@0.9.16

## 0.24.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/prompt-fragments@0.9.15

## 0.23.4

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/prompt-fragments@0.9.14

## 0.23.3

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/prompt-fragments@0.9.13

## 0.23.2

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.23.1

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/prompt-fragments@0.9.12

## 0.23.0

### Minor Changes

- 5fd0ffa: Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

  The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1
  - @cat-factory/prompt-fragments@0.9.11

## 0.22.6

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/prompt-fragments@0.9.10

## 0.22.5

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.22.4

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3
  - @cat-factory/prompt-fragments@0.9.9

## 0.22.3

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2
  - @cat-factory/prompt-fragments@0.9.8

## 0.22.2

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1
  - @cat-factory/prompt-fragments@0.9.7

## 0.22.1

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0
  - @cat-factory/prompt-fragments@0.9.6

## 0.22.0

### Minor Changes

- 48a3df6: Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

  Three related issues in the API/UI Tester flow:

  - **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
    regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
    to an existing entry rather than re-running (replay idempotency). A container-reusing
    transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
    rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
    re-attached to its FIRST round's completed job and silently replayed the stale report. Each
    re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
    job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
    CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
    with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
    The conformance suite now models a pooled container so the loop is exercised faithfully.

  - **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
    of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
    timeline in the test report window instead of only a bare "N/M fix" count.

  - **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
    meaningfully tested — its ephemeral environment never came up, a required dependency is
    missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
    the step's ephemeral environment is in a `failed` state). The run stops, the block is left
    blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
    dispatched, since it cannot provision infrastructure.

  This is a breaking change to the persisted Tester step state and the test-report wire shape
  (new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
  may simply break rather than migrate.

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/prompt-fragments@0.9.5

## 0.21.17

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1
  - @cat-factory/prompt-fragments@0.9.4

## 0.21.16

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/prompt-fragments@0.9.3

## 0.21.15

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/prompt-fragments@0.9.2

## 0.21.14

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/prompt-fragments@0.9.1

## 0.21.13

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/prompt-fragments@0.9.0

## 0.21.12

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/prompt-fragments@0.8.9

## 0.21.11

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/prompt-fragments@0.8.8

## 0.21.10

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2
  - @cat-factory/prompt-fragments@0.8.7

## 0.21.9

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/prompt-fragments@0.8.6

## 0.21.8

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/prompt-fragments@0.8.5

## 0.21.7

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/prompt-fragments@0.8.4

## 0.21.6

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
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/prompt-fragments@0.8.3

## 0.21.5

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4
  - @cat-factory/prompt-fragments@0.8.2

## 0.21.4

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.21.3

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2
  - @cat-factory/prompt-fragments@0.8.1

## 0.21.2

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.21.1

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/prompt-fragments@0.8.0

## 0.21.0

### Minor Changes

- e641417: Add a document-authoring pipeline and a richer document task definition.

  **Reviewers now read the real repository.** The `reviewer` (code) and `doc-reviewer`
  companions run as read-only container reviewers: they clone the producer's PR branch and
  read the ACTUAL changed files / committed document with tools before rating, instead of
  grading the producer's summary reply (a review of a summary is worthless). They are
  dispatched through the same async container path the coder/merger use and return their
  verdict as structured JSON, resolved by the same threshold / rework-loop / human-gate
  handling as before. Inline companions (`architect-companion` / `spec-companion`) are
  unchanged. A container companion is gated on a wired sandbox like any other container kind.

  A new forward-authoring track produces an in-repo Markdown document (PRD / RFC / design
  doc / ADR / technical reference / runbook / research report) shipped as a pull request —
  distinct from the reverse-documentation kinds (`documenter` / `business-documenter` /
  `blueprints`) that describe existing code. Four new agent kinds are registered through the
  public `registerAgentKind` seam — `doc-researcher` and `doc-outliner` (inline), `doc-writer`
  (container-coding, opens the PR coder-style) and `doc-finalizer` (container-coding, polishes
  on the PR branch) — plus a `doc-reviewer` companion that loops the writer back for rework.

  Two built-in pipelines are seeded: `pl_document` (research → outline [human gate] → write →
  AI review loop [human gate] → finalize → conflicts → ci → merger) and `pl_document_quick`.

  The `document` task type gains a wider `docKind` set (`prd`/`rfc`/`adr`/`design`/`technical`/
  `api`/`runbook`/`research`/`reference`/`other`) and optional `audience`, `targetPath` and
  `outlineHints` fields, threaded into the agent context so the document agents specialise their
  prompts. No new persisted tables — the committed Markdown is the durable artifact.

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/prompt-fragments@0.7.41

## 0.20.3

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.20.2

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2
  - @cat-factory/prompt-fragments@0.7.40

## 0.20.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/prompt-fragments@0.7.39

## 0.20.0

### Minor Changes

- 32c653f: Add the Visual Confirmation gate and split the tester into an API + UI tester.

  - **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
    testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
    non-redundant screenshot of each distinct view, uploads them to the binary-artifact
    store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
    loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
    with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
  - **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
    (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
    reference design images (paired by view) and parks for a person to review actual-vs-reference.
    The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
    or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
    binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
  - Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
    `listByBlock`.

  BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
  (no backwards-compatibility shims), any persisted state that still names `tester` simply stops
  matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
  the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
  recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
  all use `tester-api`.

  NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
  routing into it (a second Cloudflare container class; image-per-step on the local/pool
  transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
  routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
  Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
  (a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
  `experimental`.

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
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/prompt-fragments@0.7.38

## 0.19.0

### Minor Changes

- b5231b0: Make prompt-caching a first-class, visible capability and add per-kind progress-guard
  leniency.

  **Caching capability + observability.** `providerCachePolicy` moves to the kernel
  (`domain/cache-policy.ts`, re-exported from `@cat-factory/agents`) so the model catalog
  can derive a per-flavour `ModelOption.cachesPrompts` from the effective provider — the
  same model reads `false` on its cache-less Cloudflare/Workers-AI flavour and `true` once
  a direct key upgrades it to its caching `direct` flavour. The already-recorded
  `cachedPromptTokens` is now aggregated per agent kind in `summarizeByExecution` (D1 +
  Drizzle, kept symmetric) and surfaced as `cachedPromptTokens` + a derived `cacheHitRate`
  on the step rollup and the LLM-metrics export.

  **Vendor-selection UI.** The model picker shows a `Prompt caching` / `No prompt caching`
  badge per flavour, the API-keys panel notes which direct keys enable caching, and the
  step metrics bar shows a cached-token split when present — so a user can see (and act on)
  the hot path running cache-less. Shipped model defaults are intentionally NOT changed;
  extending `providerCachePolicy` to more providers (Moonshot / OpenRouter / LiteLLM) is
  gated on benchmark evidence (see `backend/docs/prompt-caching.md`).

  **Per-kind guard leniency.** The container progress guard can now be loosened per agent
  kind via an optional `guardLimits` job-body field (clamped per knob in the harness;
  merged over the env/built-in defaults — loosen-only, never tighten). A data-driven
  `agentTuningFor` seam (`@cat-factory/agents`, plus an `AgentKindDefinition.tuning` hook
  for custom kinds) supplies the profile, which `ContainerAgentExecutor` folds into the
  dispatch body. Initial profiles give `conflict-resolver` more error headroom and the
  research-heavy kinds a higher consecutive-web cap, so a legitimately-progressing run is
  not killed for its normal pattern. Output-token ceilings are unchanged.

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/prompt-fragments@0.7.37

## 0.18.5

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/prompt-fragments@0.7.36

## 0.18.4

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/prompt-fragments@0.7.35

## 0.18.3

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1
  - @cat-factory/prompt-fragments@0.7.34

## 0.18.2

### Patch Changes

- 692ccb4: Centralize OpenAI-compatible provider base-URL resolution.

  The env-override→default base-URL logic (and the "litellm has no public default" rule)
  was reconstructed per facade — a `NODE_BASE_URLS` map plus a `||` lookup on Node and a
  provider `switch` on the Worker. Both now route through a single
  `resolveOpenAiCompatibleBaseUrl(provider, override)` in `@cat-factory/agents`, driven by
  the existing `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` table, so adding an OpenAI-compatible
  vendor is a one-line table entry both runtimes pick up automatically.

  Minor behavioural alignment: a _blank_ `${PROVIDER}_BASE_URL` override now falls back to
  the built-in default on the Worker too (it previously returned the empty string), matching
  Node's long-standing `||` semantics.

## 0.18.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/prompt-fragments@0.7.33

## 0.18.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/prompt-fragments@0.7.32

## 0.17.2

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/prompt-fragments@0.7.31

## 0.17.1

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/prompt-fragments@0.7.30

## 0.17.0

### Minor Changes

- 9f7ee39: Add "Requirements brainstorm" and "Architecture brainstorm" agents — structured-dialogue
  gates that PROPOSE options with explicit trade-offs and let a human converge on a direction,
  rather than doing all the work themselves or expecting the work done upfront.

  - One shared, stage-discriminated engine (`BrainstormService` over the existing
    `IterativeReviewService`), driven through the generic `ReviewGateController`. Two agent kinds
    (`requirements-brainstorm`, `architecture-brainstorm`) reuse it via a stage-bound repository
    adapter.
  - Persistence: a new `brainstorm_sessions` table keyed per (block, **stage**) — a block may hold
    a live requirements AND a live architecture session at once — mirrored across both runtimes
    (D1 + Drizzle/Postgres) with a cross-runtime conformance suite.
  - Handoffs (DB session state → next stage's prompt): `requirements-brainstorm` → the
    requirements review (its converged direction becomes the reviewed subject);
    `architecture-brainstorm` → the architect (surfaced additively as a prior output).
  - Pipelines: both steps are added to `pl_full` and `pl_fullstack` but **disabled by default**
    (opt-in per pipeline) — existing runs are unchanged.
  - Frontend: a shared brainstorm window (option cards with trade-offs → choose/steer/dismiss →
    incorporate → re-run), wired through the result-view seam, the workspace stream, and the
    palette catalog.

  Breaking: adds a new required table on both runtimes (`brainstorm_sessions` D1 migration +
  Drizzle migration) and a new optional `ExecutionEventPublisher.brainstormSessionChanged` event.
  No data migration — pre-1.0, stale state is acceptable.

  The brainstorm iteration cap reuses the merge preset's `maxRequirementIterations` /
  `maxRequirementConcernAllowed` knobs (no new preset field).

- 81b60d4: Add the future-looking **Follow-up companion** to the Coder agent.

  As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
  side-tasks it is deliberately not acting on, and clarifying questions — by appending them
  to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
  tails that file and streams the items **out** on the job view (drain-on-read, like tool
  spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
  the first item appears — while the container is still running.

  A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
  / Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
  after delivering the key task, answer a question, or dismiss it. The pipeline's following
  steps do not start until **every** item is decided: an undecided follow-up or unanswered
  question parks the run at the Coder's completion (a new `followup_pending` notification).
  Once all are decided the engine loops the Coder for the queued / answered items (within a
  per-step budget) before advancing. The companion is enabled by default on Coder steps and
  disableable per step in the pipeline builder.

  This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
  Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
  decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
  `followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
  the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
  optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
  are added across the stack.

  Bumps the executor-harness image (new src) — publish + redeploy to roll it out.

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/prompt-fragments@0.7.29

## 0.16.1

### Patch Changes

- 4dd6e97: Fix: container agent (and repo-bootstrap) runs on **OpenRouter** and **LiteLLM** models
  were rejected at start with `'openrouter' is not supported` even though the LLM proxy
  already forwards both (their base URLs resolve in `resolveOpenAiCompatibleUpstream`). The
  proxyability guard hardcoded only `qwen`/`deepseek`/`moonshot`/`openai`/`workers-ai` and
  was duplicated (out of step) across `ContainerAgentExecutor` and `ContainerRepoBootstrapper`.
  Replaced both copies with a single shared `isProxyableProvider` in `@cat-factory/agents`,
  derived from `DEFAULT_OPENAI_COMPATIBLE_BASE_URLS` (so every OpenAI-compatible direct
  provider — including OpenRouter) plus the operator-hosted `litellm` gateway and the per-user
  local runners, so the start guard and the proxy can no longer disagree.

## 0.16.0

### Minor Changes

- ea59e91: Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
  workspace, never a pipeline-builder step) that grades each completed agent step on how
  smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
  improvements.

  - After a run completes, the engine schedules a grading per completed agent step
    (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
    the inline LLM grade. The grader's model is configured in Model Configuration like
    every other agent (the hidden-from-palette `kaizen` kind).
  - A `(promptVersion, agentKind, model)` combo that grades strongly (>=4) with no
    recommendations five times in a row is marked **verified** and is no longer graded.
  - New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
    asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
    setting (a new `workspace_settings.kaizen_enabled` column).
  - New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
    a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
    per-step grading status (scheduled/running/complete + results) inside the run window —
    never on the board.
  - A step with neither a provided-context snapshot nor any recorded LLM calls (e.g. prompt
    recording is off deployment-wide) is settled `failed` rather than graded blind, so a
    guessed grade can't advance a combo toward a bogus `verified`.
  - The Worker Kaizen sweep gains an in-isolate re-entrancy guard (mirroring the Node
    sweeper) so overlapping passes don't race the per-combo streak update.

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/prompt-fragments@0.7.28

## 0.15.2

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/prompt-fragments@0.7.27

## 0.15.1

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/prompt-fragments@0.7.26

## 0.15.0

### Minor Changes

- 52d886a: Improve the ergonomics of authoring custom agent kinds and gates:

  - **Typed provider registry** (`defineProviderToken`/`wireProvider`/`requireProvider`, kernel),
    surfaced through `GateContext.getProvider`/`requireProvider`. A custom gate reaches its data
    source through the context instead of a hand-authored module global + unsafe `!`. The built-in
    `@cat-factory/gates` suite dogfoods it (public `wireX` signatures unchanged).
    **Breaking:** `GateContext` gains required `getProvider`/`requireProvider` (use `stubGateContext`).
  - **Schema-driven structured output** (`defineStructuredOutput`, agents): one valibot schema
    derives both the `agent.output` spec and a typed `parse`/`safeParse`, replacing the hand-written
    `shapeHint` string + lenient coercer. `registerAgentKind` auto-fills `agent.output` from a
    `structuredOutput` schema.
  - **Boot-time registration validation** (`validateRegistrations`/`validateRegistrationsOnce`,
    orchestration): a facade validates registered gates/kinds/pipelines at startup (gate `helperKind`
    resolves, `resultView` is known) and fails loudly instead of mid-run. Wired into both runtimes.
  - **Prompt + resultView wiring** (agents/contracts): `FINAL_ANSWER_IN_REPLY` + the read-only
    guardrail are applied to registered kinds from their `agent.surface` (fixing a registered
    `container-explore` kind missing the guardrail); `resultView` is now a typed picklist of
    `RESULT_VIEW_IDS` (unknown ids fail validation instead of silently falling back to prose).

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/prompt-fragments@0.7.25

## 0.14.9

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/prompt-fragments@0.7.24

## 0.14.8

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1
  - @cat-factory/prompt-fragments@0.7.23

## 0.14.7

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/prompt-fragments@0.7.22

## 0.14.6

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/prompt-fragments@0.7.21

## 0.14.5

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.14.4

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.14.3

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.14.2

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/prompt-fragments@0.7.20

## 0.14.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.14.0

### Minor Changes

- 6ff1f10: Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

  A team can now link an external document (a Confluence page, a Notion page, or a
  GitHub file — any connected Document source) as a prompt-fragment whose guidance is
  **re-resolved from the source at the moment an agent run uses it**, rather than a
  one-time snapshot. Edit the upstream doc and the next agent run follows the new
  version — no re-import. The body is cached on the fragment as a last-resolved
  snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
  the run falls back to the cached body, so resolution never blocks a run. Available
  at both the account and workspace tiers; an account-tier link fetches through a
  chosen workspace's connection — recorded on the fragment so every consuming
  workspace re-resolves through that same connection at run time, not its own.

  New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
  `POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
  "Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
  a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

  As part of this, run-time fragment-id resolution now goes through the merged tenant
  catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
  so **managed (DB-authored) fragments also reach a run** — previously only built-in
  ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
  not configured.

  Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
  `doc_via_workspace_id` / `resolved_at` columns on both runtimes (a D1 migration and
  a Drizzle migration); stale pre-existing rows simply carry nulls.

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/prompt-fragments@0.7.19

## 0.13.0

### Minor Changes

- 04befe8: Business-only specs + an explicit `technical` task label.

  **Business-only spec-writer + "no new specs" outcome.** The spec-writer now captures
  ONLY business requirements. For a purely technical task (a refactor / non-functional /
  internal change with no externally-observable behaviour) "no new specs" is a valid
  outcome: the writer returns `{"noBusinessSpecs": true}`, the baseline spec is left
  untouched (`specPostOp` commits nothing), and the new `AgentRunResult.noBusinessSpecs`
  channel carries the determination. The spec-companion corroborates or disputes it via a
  new optional `technicalCorroborated` verdict on `companionAssessmentSchema` (a disputed
  "no specs" claim loops the writer back as before). The spec-writer prompts are updated
  accordingly (no version bump — they are not under prompt-version control).

  **Explicit `technical` label on a task.** Blocks gain an optional `technical` field
  (`true`/`false`/unset), persisted on both runtimes (D1 column ⇄ Drizzle column + generated
  migration; shared block mapper). A human sets it at creation (a "Technical task" checkbox)
  or via a tri-state inspector toggle (unset / technical / business). An explicit `false`
  (business) is forwarded to the spec-writer, which is then required to produce specs (it is
  told not to claim "no business specs"); `true` tells it the empty outcome is expected.
  Left unset, the engine infers the label from the settled spec phase — `noBusinessSpecs`
  (writer) combined with `technicalCorroborated` (companion) — both when the spec-companion
  converges automatically AND when a human proceeds past its iteration cap. Once a concrete
  label is recorded it is authoritative and not re-inferred (whether set by a human or a
  prior inference); a human re-opens it to inference by clearing it to "unset". When a task
  is technical the implementer treats the task definition / incorporated requirements as the
  primary source of truth and the committed specs as a regression-spotting reference; the
  `build` prompt is bumped to v3 and carries the per-task signal (only the implementer — not
  the architect/reviewer — acts on it).

  Breaking: none for existing data (the new columns default to "not determined").

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/prompt-fragments@0.7.18

## 0.12.0

### Minor Changes

- be182e8: Hybrid linked-context delivery to agents, and deterministic reference resolution.

  Linked documents and tracker issues now reach a container agent as a cheap in-prompt
  summary index plus their full bodies materialised into a `.cat-context/` directory in the
  checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
  what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
  checkout) agent kinds instead get the budgeted full body injected into the prompt.

  The engine also resolves references named explicitly in a block's description or its
  incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
  and URLs) against the already-imported corpus, folding those high-confidence items into the
  context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
  `getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
  `#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
  is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
  speculative relationship graph and no live fetching: everything is prepared backend-side,
  which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

  Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
  are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
  page still re-projects.

  Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
  `contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
  `DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
  D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
  bump the runner image tag.

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0

## 0.11.16

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/prompt-fragments@0.7.17

## 0.11.15

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/prompt-fragments@0.7.16

## 0.11.14

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/prompt-fragments@0.7.15

## 0.11.13

### Patch Changes

- c7b8012: Improve the requirements-review experience.

  **Auto-save answers (no button).** The requirements-review window no longer has a "Save
  answer" button: an answer is seeded into its textarea from the recorded reply and persisted
  on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

  **"Recommend something" + the Requirement Writer.** A finding can now be marked for a
  grounded recommendation instead of being answered or dismissed. A new second companion of
  the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
  `requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
  precedence order: the block's **best-practice fragments** (team/org standards — checked
  FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
  in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
  (provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
  Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
  folded into the next incorporation), rejects, or re-requests with a "do it differently"
  note. Recommendations are a first-class collection on the review that survives the re-review
  item churn.

  - Contracts: `recommend_requested` item status, `RequirementRecommendation` +
    `recommendations[]` on `RequirementReview`, and the request schemas.
  - Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
    (new D1 migration `0009` ⇄ Drizzle column + generated migration).
  - Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
    `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
    - best-practice-fragment resolver deps (degrade gracefully when unwired).
  - Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
    `…/recommendations/:recId/{accept,reject,re-request}` routes.

  **Board progress for the review companions.** While the review is incorporating, re-reviewing
  or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
  label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/prompt-fragments@0.7.14

## 0.11.12

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/prompt-fragments@0.7.13

## 0.11.11

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.11.10

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.11.9

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/prompt-fragments@0.7.12

## 0.11.8

### Patch Changes

- 7d1f829: Migrate the `tester` built-in agent onto the generic, manifest-driven `agent` harness kind,
  continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers, the
  coder, blueprints, and spec-writer).

  `ContainerAgentExecutor` now routes `tester` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the PR
  head branch (it makes NO commits) instead of the bespoke `/test` body. The agent returns ONLY
  its structured JSON report; `toRunResult` coerces that `custom` result into the `testReport`
  channel the engine's `TesterController` greenlights-or-loops the fixer on. The conservative
  coercion the harness `/test` handler used to apply — defaulting every field safely and honouring
  a greenlight ONLY when no blocking (high/critical) concern is open — now runs backend-side in
  `coerceTestReport` (and the engine re-applies it defensively). The role prompt and the
  run-mode / ephemeral-URL guidance come from the standard `roleSystemPrompt` + `userPromptFor`,
  which already carry them, so the harness adds none.

  The tester needs its docker-compose dependencies stood up for the run, so the generic
  `agent` explore flow grows an optional `infra` spec (`{ environment, noInfraDependencies?,
composePath?, environmentUrl? }`): `handleAgent`'s explore mode stands the local
  docker-compose infra up before the agent runs and tears it down afterward (lifted from the
  bespoke tester handler), folding a stand-up-failure note into the prompt so a missing Docker
  daemon is non-fatal. An `ephemeral` run manages no infra (the env is already deployed and its
  URL reaches the agent through its prompt). This is a harness `src/**` change, so the
  executor-harness image is bumped (1.13.0; deploy tag + `wrangler.toml`).

  Two regressions the migration introduced are fixed here. (1) The report's `environment` (which
  env the suite ran in, echoed to the UI) was authoritatively set from the task config by the old
  `/test` handler; the migrated `coerceTestReport` only read it from the model's JSON, so it was
  near-always dropped. The harness now stamps `environment` onto the structured result from the
  job's `infra` spec (the authoritative source), so it's deterministic again regardless of what the
  model emits. (2) A `local` service with no infra dependencies lost the precise "nothing was stood
  up — run the suite directly" guidance and was told its infra had been stood up on localhost;
  `testerEnvironmentSection` now restores the no-dependencies run-mode line for those services.

  The dead `/test` harness handler (and the other migrated kinds' handlers) is removed in the
  later harness-cleanup sweep. The cross-runtime conformance suite already covers the generic
  `agent` explore + structured-result path on both runtimes.

## 0.11.7

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/prompt-fragments@0.7.11

## 0.11.6

### Patch Changes

- 77b7d31: Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
  kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
  the coder, and blueprints).

  `ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
  per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
  absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
  bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
  `spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
  `toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
  engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
  the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
  carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
  `buildUserPrompt`/`renderTaxonomyInventory` used to inject.

  The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
  executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
  `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
  own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
  built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
  reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
  shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
  channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
  absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
  (`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
  dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
  byte-compares each rendered shard to the branch and makes NO commit when everything matches
  and there is nothing to seed or prune (durable-driver replay re-commits nothing).

  Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
  a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
  handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
  (or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
  the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
  half-baked spec by the structured repair. This is a harness change, so the executor-harness
  image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
  bumped to match). The dead `/spec` handler is removed in a later sweep step.

  Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
  work branch via `RepoFiles` on both runtimes.

  Also fixes a facade-parity gap in the self-hosted runner-pool result coercion
  (`HttpRunnerPoolProvider.coerceRunnerResult`): the generic `agent`-kind structured channel
  `custom` was missing from the pass-through allow-list, so a migrated kind's doc
  (blueprints / spec-writer / merger / on-call) was silently dropped on a runner-pool backend
  while the Cloudflare/local transports — which return the harness view verbatim — kept it.
  `custom` now passes through, and a regression test covers it.

- Updated dependencies [77b7d31]
  - @cat-factory/kernel@0.13.4

## 0.11.5

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/kernel@0.13.3
  - @cat-factory/prompt-fragments@0.7.10

## 0.11.4

### Patch Changes

- ce27690: Migrate the `blueprints` built-in agent onto the generic, manifest-driven `agent` harness
  kind, and add a checkout-free file-DELETION channel the migration needs.

  `ContainerAgentExecutor` now routes `blueprints` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent (cloning the PR
  branch when one is open, else the default branch — exactly its old `prBranch ?? baseBranch`
  clone) instead of the bespoke `/blueprint` body. The agent now returns ONLY the service →
  modules tree as JSON; `toRunResult` coerces that `custom` result into the `blueprintService`
  channel (via `coerceBlueprintService`) the engine already reconciles onto the board.

  The deterministic render + commit of the in-repo `blueprints/` artifact that used to live in
  the executor-harness `/blueprint` handler now runs as a BACKEND built-in post-op
  (`blueprintPostOp`, `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is
  keyed by the engine's own built-in op map in `ExecutionService` — deliberately NOT the
  agent-kind registry, so the built-ins never leak into `customAgentKinds` / the SPA palette.
  The post-op is idempotent (the `version.json` content hash short-circuits an unchanged tree,
  so a durable-driver replay re-commits nothing) and prunes a removed module's stale deep-dive
  file — the checkout-free analogue of the harness wiping `blueprints/` before writing.

  To support that prune, `commitFilesSchema` / `CommitFilesInput` (and the `RepoFiles` /
  `GitHubClient` `commitFiles` impl in `FetchGitHubClient`) gain an optional `deletions:
string[]`: paths removed in the same commit, built into the Git Data tree as `sha: null`
  entries against the base tree. Additive and non-breaking (absent ⇒ a pure add/update commit).

  The already-shipped executor-harness image serves this via its generic `handleAgent`
  explore-structured handler, so **no image bump is required**. One intentional, low-risk delta:
  the blueprint explore body now carries the shared web-tools fields like every other explore
  agent (gated by `webSearchProxyEnabled`), and the agent reads any existing blueprint from its
  own checkout rather than the harness pre-injecting the baseline tree into the prompt.

  The now-dead `/blueprint` harness handler is removed in a later step of the sweep (which
  bumps the executor image), once parity is confirmed on CI. The cross-runtime conformance
  suite gains an assertion that a `blueprints` step's post-op renders + commits the
  `blueprints/` artifact via `RepoFiles`, identically on both runtimes.

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/prompt-fragments@0.7.9

## 0.11.3

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.11.2

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/prompt-fragments@0.7.8

## 0.11.1

### Patch Changes

- 22d7fff: Migrate the read-only built-in agents (`architect`, `analysis`, `bug-investigator`) onto
  the generic, manifest-driven `agent` harness kind — the first step of the strangler that
  converts every built-in to the custom-agent model.

  `ContainerAgentExecutor` now dispatches the read-only kinds through `buildRegisteredAgentBody`
  with a synthesized `container-explore` step, so they ride `kind: 'agent'` in `mode: 'explore'`
  (the SAME path a deployment's registered `container-explore` kind takes) instead of the
  bespoke `explore` dispatch kind. The job body is byte-identical to the old `/explore` body
  (same branch resolution, prompts and web-tools) bar the harness-internal temp-dir label, and
  the prose result maps to `output` exactly as before — a behaviour-preserving reroute, not a
  behaviour change. The already-shipped executor-harness image serves this via its generic
  `handleAgent` handler, so no image bump is required.

  The now-dead `/explore` harness handler (`handleExplore` / `parseExploreJob` / the `explore`
  dispatch kind) is removed in a follow-up once parity is confirmed on CI.

## 0.11.0

### Minor Changes

- 128e12e: Custom agents: live pre/post-op execution + data-driven palette + generic result view.

  Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
  fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
  `postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
  the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
  (`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
  `GitHubClient` + the executor's `resolveRepoTarget` via the new
  `makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
  three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
  `buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
  unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
  orchestration engine drives the hooks without importing the server HTTP layer. New kernel
  ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
  asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

  Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
  container flag), which the SPA merges into its palette catalog
  (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
  block + result view instead of the generic fallback. A `container-explore` structured
  kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
  rendered read-only by a new shared `generic-structured` result view — a custom agent gets
  a usable result window with no bespoke UI.

  The built-in agents are not yet migrated to this model (their rendering still lives in the
  executor-harness); that strangler conversion is sequenced as follow-up work. See
  `backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/prompt-fragments@0.7.7

## 0.10.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.10.0

### Minor Changes

- 1e31cbc: Replace per-agent-kind model defaults with named **model presets**.

  A workspace now keeps a library of model presets instead of a single per-agent-kind
  default map. A preset is one `baseModelId` applied to every agent kind plus optional
  per-kind `overrides`, so "everything Kimi K2.7" is a base with no overrides. Two
  built-ins are seeded for every workspace: **Kimi K2.7** (the default — every agent runs
  on Kimi K2.7) and **GLM-5.2**. A task selects a preset via the new `Block.modelPresetId`
  (the inspector's "Model preset" picker + the new-task form); changing it affects only
  steps that haven't started yet. Resolution precedence is unchanged in spirit: a block's
  pinned model wins, else the task's selected/default preset's mapping for the kind, else
  the env routing.

  - `@cat-factory/contracts`: new `model-presets.ts` (`ModelPreset`, create/update schemas);
    `Block.modelPresetId`; `addTask`/`updateBlock` accept `modelPresetId`; the snapshot
    carries `modelPresets` instead of `modelDefaults`. The `model-defaults` contract is removed.
  - `@cat-factory/kernel`: new `ModelPresetRepository` port (replaces `ModelDefaultsRepository`),
    `DEFAULT_MODEL_PRESETS` seed + `modelForKindFromPreset` helper; `resolveWorkspaceModelDefault`
    resolvers gain an optional `modelPresetId` argument throughout.
  - `@cat-factory/orchestration`: `ModelPresetService` (CRUD + lazy seeding, replaces
    `ModelDefaultsService`) and `resolvePresetModelForKind`; the execution engine threads the
    block's preset into model resolution, the personal-credential gate and the start guard.
  - `@cat-factory/agents`: `StepModelInputs.modelPresetId` + the resolver signature.
  - `@cat-factory/server`: `ModelPresetController` (`GET|POST|PATCH|DELETE
/workspaces/:ws/model-presets`, replaces the model-defaults controller); the block mappers
    persist `model_preset_id`; the snapshot lists `modelPresets`.
  - `@cat-factory/worker` / `@cat-factory/node-server`: the `model_presets` table (D1 migration
    `0006` ⇄ Drizzle) + `blocks.model_preset_id`, replacing `workspace_model_defaults`.

  BREAKING (pre-1.0, no migration): the `workspace_model_defaults` table, the
  `/model-defaults` endpoint, and the snapshot's `modelDefaults` field are removed. Existing
  per-agent-kind default maps are dropped; workspaces fall back to the seeded built-in presets.

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/prompt-fragments@0.7.6

## 0.9.0

### Minor Changes

- d0081e1: Shard the in-repo `spec/` artifact by a module → feature taxonomy to kill merge churn.

  The spec-writer no longer commits a single monolithic `spec/spec.json` (+ `overview.md`
  / `rules.md` / `version.json`); every spec run rewrote those whole files, so two task
  branches that both touched the spec conflicted hard on merge. The spec is now SHARDED:
  a tiny `spec/service.json`, an `spec/overview.md` index, and one canonical
  `spec/modules/<module>/<group>.json` (+ a human `<group>.md`) per feature group, with
  the Gherkin `spec/features/<module>/<group>.feature` files nested to match. A group's
  file bytes depend only on that group, so concurrent branches editing different
  features never touch the same file.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - `@cat-factory/contracts`: `SpecDoc` gains a two-level taxonomy — `modules: SpecModule[]`
    where each module holds `groups`, and each group carries BOTH its `requirements` and the
    domain `rules` scoped to it. The top-level `SpecDoc.groups`/`SpecDoc.rules`,
    the `SpecVersion`/`version.json` manifest, and the `SPEC_JSON_PATH`/`SPEC_RULES_PATH`/
    `SPEC_VERSION_PATH` path constants are removed; `SPEC_SERVICE_PATH`/`SPEC_MODULES_DIR`
    are added. `renderSpecForReview` walks the new shape. An existing repo's monolithic
    `spec.json` / `rules.md` / `version.json` (and any old flat `features/*.feature` files)
    are DELETED on the next spec run — the sharded layout is written fresh; no migration.
  - `@cat-factory/executor-harness`: sharded deterministic render + on-disk reassembly
    read-back + orphan-shard pruning (a removed/renamed module or group is deleted, not
    resurrected) + a one-time prune of the pre-sharding monolithic/flat artifacts;
    `version.json` dropped (no-op detection is now per-file via the commit).
    Content-derived (not positional) rule ids keep a group file byte-stable. The spec-writer
    prompt + reassembled-baseline now carry an EXISTING-taxonomy inventory and steer the
    agent to slot new requirements/rules into the closest existing module + feature (reusing
    exact names) rather than spawning near-duplicate domains/groups. Ships in the **1.9.0**
    runner image already pinned in `deploy/backend` (no further tag move needed).
  - `@cat-factory/agents`: the runtime-neutral `repo-ops/render.ts` mirror is reworked to
    the same sharded layout (`renderSpecVersionFile`/`nextSpecVersion`/`canonicalSpecJson`/
    `hashSpec` for the spec removed); `SPEC_AWARE_GUIDANCE` points readers at
    `spec/modules/<module>/<feature>.{md,json}`.
  - `@cat-factory/server`: `SPEC_WRITER_SYSTEM_PROMPT` describes the module → feature →
    {requirements, rules} structure, the no-catch-all rule, and the taxonomy-reuse rule.

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/kernel@0.10.1
  - @cat-factory/prompt-fragments@0.7.5

## 0.8.2

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/prompt-fragments@0.7.4

## 0.8.1

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.8.0

### Minor Changes

- c70df09: Add the foundations for manifest-driven custom agents (pre/agent/post-op model).

  - `@cat-factory/agents`: new `repo-ops/render.ts` — the deterministic, container-free
    rendering + lenient coercion of the in-repo `blueprints/`/`spec/` artifacts
    (`renderBlueprintFiles`/`renderSpecFiles`/`renderSpecFeatureFiles`,
    `coerceBlueprintService`/`coerceSpecDoc`/`dedupeSpecIds`, the version manifests). This
    is the logic lifted out of the executor-harness image; the hash uses Web Crypto so it
    is runtime-neutral (so the hash + version helpers are async). The agent-kind registry
    (`AgentKindDefinition`) gains `agent` (execution surface), `preOps`/`postOps` (backend
    repo-op hooks) and `presentation` (frontend palette metadata), with matching accessors;
    `registeredKindRequiresContainer` now also derives from a container agent surface.
  - `@cat-factory/kernel`: new `RepoFiles`/`ResolveRepoFiles` ports (a per-run,
    checkout-free facade over the `GitHubClient` Git Data API) and the agent-definition
    vocabulary (`AgentSurface`/`AgentStepSpec`/`AgentCloneSpec`/`AgentOutputSpec`,
    `RepoOp`/`RepoOpContext`).
  - `@cat-factory/contracts`: new `AgentPresentation`/`AgentCategory`/`CustomAgentKind`
    wire shapes for the data-driven agent palette.

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/prompt-fragments@0.7.3

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/prompt-fragments@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/prompt-fragments@0.7.1

## 0.7.0

### Minor Changes

- 6406c8c: Extract `@cat-factory/agents` — agent catalog, routing, prompts, fragment library, and versioned prompt registry are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility. `REVIEW_SYSTEM_PROMPT` moves from `requirements.logic` into agents (its natural home); `renderTaskContext`/`TaskContextView` move into `@cat-factory/kernel` (pure, kernel-deps-only).
- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 385bd93: Add an optional consensus-orchestration framework + a core Task Estimator.

  A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
  a multi-model **consensus** process — a specialist panel, a debate, or ranked
  voting/scoring — to produce a higher-quality result of the same shape the single-actor
  agent would have (a polished document, an aggregate of observations, an estimate). It
  integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
  composite and delegates to it when a step isn't consensus-enabled or gating marks the
  task ineligible. Eligibility is surfaced through a new group of assignable capability
  traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
  pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
  optional risk/impact gating) on eligible steps. Each session persists a full transcript
  (`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
  and streamed live via a new `consensus` workspace event; every sub-call flows to
  `llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

  A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
  requirements are clarified; the engine persists it on `block.estimate` (new column on
  both stores) and the inspector shows the ratings. It gates the expensive consensus step
  and is useful standalone for triage.

  BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
  shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
  `WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
  shapes simply re-create.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- 3a12f15: Fix the container coding-agent role prompts that told the agent to push and manage
  the pull request itself — work it has no credentials for and was never meant to do.

  The `build`, runnable-tests (`playwright`) and docs (`business-documenter`) gates each
  instructed the agent to "open or update the pull request, push the fix, and wait for
  CI". Inside the run container the agent has no push token (version control is the
  platform's job), so a capable model would try `git push`, hit an auth wall, and then
  burn the entire run probing env vars, decoding tokens and poking at git remotes
  instead of doing the work (shipping zero changes and failing with "no file changes");
  weaker models just gave up.

  The three gates now share one `PLATFORM_DELIVERY_CONTRACT` (in `ci-gate.ts`) that makes
  the boundary explicit: the agent commits its OWN work (it alone knows which files are
  part of the solution vs scratch scripts/artifacts), validates locally, and stops; the
  platform pushes, opens the PR and drives CI (dispatching a CI-fixer on failure). It is
  told not to push, not to use `gh`/the GitHub API, and not to chase credentials, and to
  bound its effort rather than spin. The `build` prompt is bumped to `build@v2`.

  BREAKING: the `CI_RETRY_SANITY_CHECK` export is replaced by `PLATFORM_DELIVERY_CONTRACT`.

- b40da13: Simplify task granularity and run configuration; open the pipeline-step detail
  overlay from the zoomed-in board.

  - **Open the agent step-detail overlay from the board.** Clicking a pipeline agent
    in a zoomed-in task card now opens the full `AgentStepDetail` overlay (execution
    metadata + the agent's prose output), exactly like clicking it from the inspector
    or the focus-view pipeline — instead of expanding raw text inside the card.
  - **Removed the per-task auto-merge "confidence threshold".** The confidence-score
    auto-merge gate (`Block.confidenceThreshold`, the inspector + task-card UI, the
    `DEFAULT_CONFIDENCE_THRESHOLD` constant) is gone; the `merger` step's merge-policy
    preset (complexity/risk/impact ceilings) is the sole auto-merge gate. (The raw
    `confidence` score is still recorded for transparency.)
  - **Removed "feature" tracking from the board and the service map.** `Block.features`
    (the inspector's "Features implemented" tags and the board/module feature badges)
    is removed, and the in-repo blueprint / board-scan decomposition is now
    service → modules only — the Blueprinter, harness rendering, and reconciliation no
    longer produce a "feature" sub-level or derive tasks from it. Acceptance scenarios
    are now freeform per task (decoupled from features) pending a deeper
    requirements-driven model.
  - **Task creation picks a pipeline + merge policy; model selection removed.** The
    "Add a task" modal now offers a default pipeline (`Block.pipelineId`, which the
    task's Run/Start controls use) and a merge policy preset. The per-task model
    picker is gone — a model is resolved per step, not per task.

  Migration `0025_task_run_config.sql` drops the `confidence_threshold` and `features`
  columns and adds `pipeline_id`. Bumps `@cat-factory/executor-harness` (the blueprint
  rendering inside its image changed).

- 8eed38c: Introduce a generic, extensible AI provisioning facade so model resolution is no
  longer hardwired to the Cloudflare Worker.

  `@cat-factory/agents` now exposes `CompositeModelProvider` — a `ModelProvider`
  composed from one or more mixable `ProviderRegistry` maps — plus the base,
  runtime-neutral resolvers (`openAiResolver`, `anthropicResolver`,
  `openAiCompatibleResolver`, `cloudflareRestResolver`, `baseProviderRegistry`) and
  the shared OpenAI-compatible endpoint constants. Direct vendor usage works on any
  runtime; `cloudflareRestResolver` adds a non-binding path to Cloudflare-hosted
  models (Workers AI REST / AI Gateway) for non-Worker deployments.

  AWS Bedrock support ships as a separate opt-in package,
  `@cat-factory/provider-bedrock` (`bedrockResolver` / `bedrockRegistry`), so the
  AWS SDK is pulled in only by deployments that use it. It throws a clear
  `Unsupported Bedrock model` for any model id outside its configured allow-list.

  `@cat-factory/worker`'s `CloudflareModelProvider` is now a thin composition of the
  shared facade (behaviour unchanged: same providers, same "not configured" errors),
  and a new installation extension point — `registerModelRegistry` — lets a
  deployment mix extra provider registries (e.g. Bedrock) into every container build,
  including the durable Workflow and cron-sweeper paths.

- f49fa30: Give the inline design/research agents (architect, researcher) provider-hosted web
  search. The `AiAgentExecutor` now attaches the AI SDK's server-executed `web_search`
  tool (Anthropic / OpenAI) to its one-shot call for an allow-listed set of kinds, plus
  a per-kind usage nudge — so those agents can verify current libraries/APIs instead of
  relying on training data, the same way Claude Code and Codex do. Opt-in and a no-op by
  default: enabled per deployment via `INLINE_WEB_SEARCH_ENABLED` (with
  `INLINE_WEB_SEARCH_KINDS` / `INLINE_WEB_SEARCH_MAX_USES` to tune the allow-list and
  cap), and only on providers that expose a hosted search — models on Workers AI / the
  OpenAI-compatible providers run unchanged. Both runtime facades wire it from env.

  The per-kind web-research nudge is data-driven, not a hardcoded switch:
  `AgentKindDefinition` gains an optional `webResearchHint`, so a proprietary/custom
  agent kind registered via `registerAgentKind` supplies its own nudge and the shared
  composer (`webResearchGuidanceFor`) picks it up — the shared surface never needs to
  know the custom kind exists. Built-in kinds carry sensible defaults; unknown kinds get
  a generic hint.

- 918764f: Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
  `@cat-factory/observability-langfuse` package implements a runtime-neutral
  `LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
  OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
  facades.

  Proxied container-agent calls and inline (non-proxied) calls — requirements
  review/rework, document planner, fragment selector, the inline agent — flow through the
  SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
  call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
  so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
  grouped under one trace per run (`executionId`); inline single-shot calls become their
  own standalone trace.

  Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
  runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
  bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
  path — failures are swallowed and logged. The existing local metric store, spend gating
  and board rollups are unchanged; Langfuse is an additive external sink, not a
  replacement.

- 9be11e1: Add an automated merge-conflict resolver, and converge the container coding agents
  onto a shared base.

  **Conflict resolver.** Previously a PR that conflicted with its base degraded to a
  manual `merge_review` handoff. A new pre-merge `conflicts` gate now sits before the
  `ci`/`merger` steps in the standard pipelines (mirroring the CI gate): it reads the
  PR's mergeability (`PullRequestMergeabilityProvider` → GitHub `mergeable_state`) and,
  on a real conflict, dispatches a `conflict-resolver` container agent that clones the
  PR branch, merges the base in, has the agent resolve the conflicts, and pushes back
  onto the same branch — looping (bounded by the merge preset's attempt budget) until
  the PR is mergeable, or failing the run for a human if it can't. Pass-through when no
  mergeability provider is wired (e.g. tests / no GitHub), so existing behaviour is
  unchanged. The resolver never pushes a half-resolved tree (it guards on remaining
  unmerged paths).

  **Shared base.** The container agents were near-duplicates of one clone → write
  context → run Pi → push flow. They now share `runCodingAgent` (implement + ci-fix +
  conflict-resolve) on top of a thinner `withWorkspace` / `runAgentInWorkspace` base
  (also used by bootstrap / blueprint / merger), plus shared no-op-reason helpers — so
  fixes like the "judge the whole run, counting the agent's own commits" change apply
  everywhere instead of being re-derived per agent.

  Bumps `@cat-factory/executor-harness` (new `/resolve-conflicts` endpoint + shared-base
  refactor change its image).

- 5ec0d25: Real merge lifecycle: CI gate + CI-fixer, merger agent, and notifications.

  A task now becomes `done` only when its pull request is **actually merged** on
  GitHub — fixing the bug where a task showed "merged" (and a green board) from a
  confidence score alone, while CI was red and the PR still open.

  - **CI gate (`ci` step)** — auto-inserted before the merger in the standard
    pipelines. It polls the PR head's GitHub check runs and, on failure, dispatches a
    new **`ci-fixer`** container agent that pushes a fix to the PR branch, looping up
    to a configurable budget (default 10) until CI is green; polling stops the moment
    CI goes green. If the budget is spent it raises a `ci_failed` notification.
  - **Merger agent (`merger` step)** — runs last. A container agent scores the PR's
    complexity / risk / impact, and the engine compares those against the task's
    **merge threshold preset** to either auto-merge (a real GitHub merge) or raise a
    `merge_review` notification for a human. Presets are a per-workspace library
    (selectable per task); the CI-fixer attempt budget lives on the preset.
  - **`merger` is appended to the standard pipelines.** A pipeline with no merger now
    raises a `pipeline_complete` notification on completion (confirm + merge) instead
    of silently marking the task done.
  - **Notifications** — a new first-class, human-actionable board surface (inbox +
    events), modelled behind a `NotificationChannel` port so email/Slack delivery can
    be added later without touching the call sites. In-app delivery only for now.

  Adds migration `0024_merge_lifecycle.sql` (notifications + merge-preset tables, the
  `blocks.merge_preset_id` column). The executor-harness image gains `/ci-fix` and
  `/merge` endpoints (version bumped so the GHCR image is re-tagged).

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 4a08935: Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
  they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
  dedicated package) and work for both inline engine calls and container coding agents via
  the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
  other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
  public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
  so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
  (OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
  gateway-default entry) with approximate pricing/context, overridable via
  `SPEND_MODEL_PRICES`.

  Catalog selectability now also gates on a **resolvable base URL**: an OpenAI-compatible
  provider (everything but `openai`/`anthropic`) is only offered once its base URL resolves,
  so a LiteLLM model stays unselectable — and a pipeline using it is blocked at start —
  until `LITELLM_BASE_URL` is set, instead of passing the guard and throwing "No base URL
  configured" mid-run. Wired symmetrically into both facades' capability resolution.

  **Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.

- 5c8ca33: Add per-step human approval gates to pipelines, plus two board polish fixes.

  A pipeline step can now be marked "require approval" when building the pipeline
  (`Pipeline.gates`, parallel to `agentKinds`; persisted via the new `gates` column,
  migration `0023`). When a gated step finishes, the run parks — reusing the durable
  decision wait — and a human reviews the step's proposal in an editable modal, then
  either **Approves** (the edited proposal advances and flows to downstream steps as
  context) or **Requests changes** (the same step re-runs with the human's feedback
  folded into the agent's prompt via `AgentRunContext.revision`). New endpoints
  `POST /executions/:id/steps/:approvalId/{approve,request-changes}`
  (`ExecutionService.approveStep` / `requestStepChanges`). The gate is surfaced on the
  board card, inspector, focus view and the zoomed-in pipeline.

  The **requirements reviewer** is now an automated, inline pipeline step
  (`requirements` agent kind) that runs before the architect instead of a manual
  inspector button. The default "Full build" pipeline seeds it first and gates both
  the requirements review and the architecture proposal.

  Also: the inspector panel now scrolls when its content exceeds the viewport, and
  zoomed-in pipeline steps are clickable to reveal the prose conclusion each agent
  produced (matching the inspector).

- 3a12f15: Add prompt caching for container-agent model calls, plus the observability to prove
  it works, and unify how both AI-call paths treat a provider's cache.

  - **Shared cache policy** (`@cat-factory/agents`): `providerCachePolicy` is the single
    source of truth for how each provider caches (`auto-prefix` for OpenAI/DeepSeek/Qwen,
    `explicit-anthropic`, or `none`). Both the in-container proxy path and the inline
    AI-SDK path consult it instead of hard-coding provider ids.
  - **Proxy** (`@cat-factory/server`): routes a run's calls to the same cached prefix via
    `prompt_cache_key` (keyed on the execution id) on providers that support it — the big
    win, since a container agent re-sends its whole growing prefix every turn. It also
    fixes the misleading `requestMaxTokens` metric to record the EFFECTIVE output ceiling
    (it previously logged the client's value before the Workers-AI floor override, so it
    read as `null`).
  - **Measure the hit rate**: `LlmCallMetric` gains `cachedPromptTokens` (read across the
    `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` field names), so the
    dashboard shows cached vs total prompt tokens per call. D1 migration `0028` + a Drizzle
    migration add the column.

  Note: the inline path's calls are single-shot (no growing prefix), so caching there is
  marginal; full inline-call observability (recording inline LLM calls through the same
  sink) is a follow-up.

- 37baa7f: Scheduled recurring pipelines on services.

  A service (a `frame` block) can now carry **recurring pipelines** that re-run a
  pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
  schedule runs every `intervalHours`, optionally constrained to an allowed window
  (weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
  on-board task block inside the service that each fire runs the pipeline against
  (skipping any fire while a run is still in flight). Run history is kept ~1 week and
  surfaced in the inspector.

  - **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
    agent that audits the repo, then a special non-LLM `tracker` step that files a
    **GitHub issue or Jira ticket** from the analysis before implementation. The
    tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
    `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
    resolves each **tenant's own** connected integration (it is injected with a
    `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
    credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
    App installation against the service's repo, and Jira tickets (markdown→ADF) using
    the workspace's encrypted `task_connections`. Two new seed pipelines:
    `pl_dep_update`, `pl_tech_debt`.
  - **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
    resolving the **workspace's own** integration. Jira: the task-source integration is
    wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
    `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
    connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
    the filer mints a short-lived token from that workspace's own GitHub App installation
    (reusing the per-tenant App infra) and resolves the service's repo from the
    `github_repos` projection — no shared/env credentials.
  - **Persistence + scheduling are symmetric across runtimes**: D1 migration
    `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
    Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
    `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
    `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
    conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
  - **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
    task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
    surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
    badge on the board; selecting it reveals the cadence, run-now/pause, and run
    history in the inspector.

- c664fe6: Let deployments mix in custom agent kinds and predefined pipelines programmatically —
  the same installation-level extension pattern as opt-in model providers
  (`registerModelRegistry` / `@cat-factory/provider-bedrock`).

  `@cat-factory/agents` now exposes an agent-kind registry (`registerAgentKind` /
  `registerAgentKinds`, `AgentKindDefinition`): a registered kind contributes its system
  prompt (string or `(kind) => string`), an optional custom user prompt, and an optional
  `requiresContainer` flag. `systemPromptFor` / `userPromptFor` consult the registry for
  custom kinds — after the built-in tracks (so a registered kind never shadows a
  standard-phase, acceptance, mock or business-logic kind) and before the generic
  fallback. The Worker's `CompositeAgentExecutor` routes a registered
  `requiresContainer: true` kind to the container executor (inline kinds need no harness
  changes and work end-to-end).

  `@cat-factory/kernel` now exposes a pipeline registry (`registerPipeline` /
  `registerPipelines`): registered pipelines are merged into `seedPipelines()` by id
  (appended, or replacing a built-in in place), so every new workspace is seeded with the
  deployment's pipelines alongside the built-in catalog.

  Both runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`) re-export
  `registerAgentKind` / `registerPipeline` (and the test-only `clear*` helpers) next to the
  existing model-provider seam, so a proprietary org package registers everything from one
  place at deployment-assembly startup. The agent-kind id was already an open string
  throughout (pipelines, steps, model defaults), so no schema change is required.

- 4026793: Requirements review: react to findings + a rework agent that feeds downstream steps.

  The requirements-review flow is now wired into the UI and reworks the requirements
  instead of overwriting the block description:

  - **New review window** (`RequirementsReviewWindow.vue`) modelled on the polished
    prose review window: a human reacts to the reviewer's structured findings —
    answering the relevant ones, dismissing the irrelevant — then runs the
    **requirements-rework** agent. Triggered from the inspector's "Review
    requirements" button (open-finding count badge). The old dormant
    `RequirementReviewModal` is removed.
  - **Rework, not overwrite.** `incorporate()` no longer rewrites
    `block.description`. It folds the answers into ONE standard-format requirements
    document (new versioned `REWORK_SYSTEM_PROMPT`: SHALL statements + MoSCoW +
    Given/When/Then acceptance + domain rules) stored on the review, and returns
    `{ review }`. It runs even with **zero findings**, so every task can carry a
    clean, writer-ready spec.
  - **Downstream consumption.** When a block has an incorporated review,
    `ExecutionService` feeds that reworked document to **every** agent step in place
    of the original description and drops the (already-folded-in) linked docs/tasks;
    the requirements-writer aggregates the reworked text per task instead of the raw
    description. The rework call rejects a length-truncated document instead of
    persisting a silently-incomplete spec.
  - **Both runtimes, enforced.** The requirements feature is wired on the Node facade
    too — a `requirement_reviews` Postgres table (Drizzle schema + migration) and
    `DrizzleRequirementReviewRepository`, plus the review/model deps in the Node
    container — so the review/rework API and the agent-context substitution behave
    identically on Cloudflare and Node. The cross-runtime conformance suite asserts the
    substitution against both stores so the parity can't silently drift.
  - **Frozen description.** Once a task's requirements are reworked, the inspector
    freezes its raw description (read-only, tucked behind an expander) and puts the
    standardized requirements in focus — the description is no longer what agents read.

- d65c979: Unify the approval gate into the conclusions reader, with GitHub-style review.

  The dedicated approval modal is gone. A pending gate now opens the same polished
  step-detail reader (ToC side nav, rendered markdown), in a new **approval mode**:
  the reviewer can comment on individual blocks of the agent's output (click a block —
  the rendered markdown carries `data-src-start/end` source ranges so the comment
  quotes that block's verbatim raw markdown), leave overall freeform feedback, then
  **Approve** (advance), **Request changes** or **Reject**.

  - **Request changes** re-runs the step with both the freeform feedback and the
    per-block comments folded into the agent's prompt (`AgentRunContext.revision`
    gains `comments`; `requestStepChangesSchema` now takes `feedback?` + `comments?`,
    requiring at least one).
  - **Reject** stops the run entirely — a terminal `rejected` failure
    (`agentFailureKindSchema`), so the board's shared failure banner + retry surfaces
    it (block → `blocked`). New `POST /executions/:id/steps/:approvalId/reject`
    (`ExecutionService.rejectStep`).
  - `stepApprovalSchema` gains the `rejected` status and a persisted `comments` array
    (`stepReviewCommentSchema`). No migration: approvals live in the execution
    `detail` JSON.

  - **Approve with corrections** opens an inline editor over the conclusions; the
    human's edits become the approved proposal carried forward (the existing
    `approveStep` proposal override — no backend change). Manual edits are a distinct
    mode and can't be combined with per-block comments / request-changes — they only
    happen _together with_ approving.

  The review surface is responsive — a right-side rail on wide screens, a bottom
  sheet below `lg` — so a pending gate is always actionable. Reject uses a two-step
  inline confirm (no native dialog). `requestStepChanges`/`rejectStep` reject a stale
  gate id whose step is already being re-run (`changes_requested`) so a double-submit
  can't dispatch duplicate work.

  Cross-runtime conformance gains assertions for reject and comment-driven re-runs.

- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

- a54ada2: Spec-writer now applies ONE task's requirements as an increment, not a service-wide aggregate.

  The spec-writer used to receive `serviceTasks` — every task under the block's service
  frame, merged or not — and fold them all into one document. So a run for a single task
  ("add CRUD for office tables") produced a spec covering five unrelated sibling resources,
  and the spec-reviewer correctly read it as scope contamination. That violates the
  branched-work model: a task's baseline is what's already merged, plus its own increment;
  an unmerged sibling task does not exist for it.

  The spec-writer now reads the spec already committed on its work branch (the baseline)
  and applies ONLY the current task's clarified/reworked requirements as an increment —
  adding what the task introduces and adjusting existing requirements only where the task
  changes their behaviour. It translates the given requirements and does not invent or fill
  gaps (that is the requirements step's job). The in-repo `spec.json` stays the complete
  service spec; only the writer's editing scope narrows.

  - Engine: removed `gatherServiceTasks` and the `serviceTasks` field from
    `AgentRunContext`. The dispatch feeds the single task (the block, whose description is
    already the reworked requirements).
  - Reviewer: the `spec-companion` now judges fidelity to the requirements it was given and
    no longer penalises the writer for requirements it was never handed.
  - Harness (`SpecJob.tasks` → `SpecJob.task`): the prompt is reframed as "baseline plus
    this task's increment". Image retagged 1.6.0 → 1.7.0 (deploy/backend `image:publish` +
    wrangler.toml) so the new digest rolls out.

  Breaking: the `/spec` harness job shape changes (`tasks: []` → `task: {}`) and
  `AgentRunContext.serviceTasks` is gone. No migration — stale in-flight jobs simply break.

- 0090313: Surface a step's model the moment it starts, not only once its work finishes.

  A pipeline step's `model` was recorded on the step only after the work returned: a
  container step got its model from the job handle once `startJob` (which blocks for
  the whole cold-boot dispatch) returned, and an inline step from the result once the
  LLM query was over. But the model is fixed the instant its ref resolves (block pin >
  workspace per-kind default > env routing) — well before the container is up or the
  query runs — so the board showed "Spinning up container…" / a working step with no
  model for that whole window.

  The executor port gains an optional, side-effect-free `resolveModel(context)` that
  previews the `provider:model` without dispatching (implemented by the inline
  `AiAgentExecutor` and the `ContainerAgentExecutor`, forwarded by
  `CompositeAgentExecutor`). The execution engine calls it up front and sets
  `step.model` before the first "spinning up container" emit (container steps) and
  before the blocking LLM call (inline steps), so the model rides the same emit that
  shows the step starting. The job handle / result still re-assert the same value, and
  the preview is best-effort (an executor that can't preview, or a resolution failure,
  simply falls back to the old timing). No wire-contract change — the SPA already
  renders `step.model` whenever present, so it now appears immediately. A cross-runtime
  conformance assertion pins that `step.model` is set on the booting/querying emit.

- 7dc8e57: Link integration context at task creation, GitHub issues as a source, and feed
  all linked context to every agent step.

  - **Linked context now reaches every step.** Documents (Confluence / Notion / …)
    and tracker issues (Jira / GitHub) attached to a task were only rendered into the
    prompts of the generic agent kinds — the four standard phases (architect, coder,
    reviewer, tester) silently dropped them, so the agents doing the work never saw
    the linked requirements/issues. The engine already resolves this context per step
    (`ExecutionService.buildAgentContext`); a shared `linkedContextSection` is now
    appended to every kind's user prompt (`@cat-factory/agents`), standard phases
    included.
  - **Attach context when creating a task.** The "Add a task" modal now lets you
    select already-imported documents and issues and links them to the new task on
    creation (previously only possible from the inspector after the fact).
  - **GitHub Issues as a task source.** A new `github` task source reuses the
    workspace's installed GitHub App (no separate credentials): it resolves the
    installation that owns the issue's repo and fetches the issue body + comments via
    the existing `GitHubClient` (new `getIssue`). Refs accept a full issue URL or the
    `owner/repo#number` shorthand. Wired in when `TASK_SOURCES` includes `github` and
    the GitHub integration is enabled.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 48d2f0d: Add per-workspace, per-agent-kind default model selection. A workspace can choose
  which model each agent kind defaults to (e.g. point `architect` at a strong model
  and `tester` at a cheap one), overriding the env-driven `AGENT_routing` for that
  workspace at run time. New `GET|PUT /workspaces/:workspaceId/model-defaults`
  endpoints (returning/replacing `{ defaults: Record<agentKind, modelId> }`) and the
  selection surfaced on the workspace snapshot as `modelDefaults`. Persisted in
  `workspace_model_defaults` on both runtimes (D1 migration 0028 / a new Postgres
  migration).

  The defaults are applied uniformly through one shared resolver
  (`resolveStepModelRef` in `@cat-factory/agents`) used by **every** executor — the
  inline LLM executor, the container executor and the requirements reviewer, on both
  the Worker and the Node service — so a step's model resolves as block-pinned >
  workspace per-kind default > env routing for the kind > env default for every agent
  kind, not just the container kinds. A stale/unresolvable block pin now falls
  through to the workspace default instead of skipping it. Request keys (agent kinds)
  and values (model ids) are validated as trimmed, non-empty strings.

### Patch Changes

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- 8065fed: Make the CI / conflicts gates observable. The gate window now shows the run id
  (copyable, with a jump into observability), a per-attempt history of every
  ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
  the conflicts gate — the resolver's own account of which files it left
  conflicting (GitHub's API exposes mergeability as a single bit, so this comes
  from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
  now link straight to their GitHub run logs.

  Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
  records each gate-helper attempt when its job finishes (previously discarded the
  moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
  from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
  `githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
  (populated on the live check-runs read; not persisted to the projection). The
  conflict-resolver result mapping now surfaces the still-conflicting file list
  (its `error`) instead of dropping it.

  Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
  manager rather than hand-merged — large generated files are what exhausted the
  resolver's context window and left big conflict sets unresolved.

- b48c455: Internal cleanup — no behavior or API changes. Deduplicates repeated helpers into
  shared modules: the subtask-snapshot comparison (`sameSubtasks`/`sameSubtaskItems`)
  used by the execution + bootstrap flows now lives in `@cat-factory/kernel`
  (`domain/subtasks.logic`), a `getErrorMessage` helper replaces the repeated
  `error instanceof Error ? error.message : String(error)` expression, the shared
  `STANDARDS_FOOTER` prompt line is centralized in `@cat-factory/agents`
  (`agents/prompt-shared`), and the identical document/task in-memory provider
  registries now extend a generic `MapSourceRegistry` exported from
  `@cat-factory/kernel`.
- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 197264e: Sharpen the `mocker` and `tester` agent prompts so they do real work instead of
  restating the implementer and resolving.

  - **Mocker.** Leads with the concrete goal — make the service runnable locally with
    just `docker-compose up`, every external SERVICE answered by a WireMock mock — and
    is now explicit that this is a hands-on build step: it must read the existing
    mappings, add/extend the stubs + fixtures + docker-compose wiring and COMMIT them.
    A prose-only "already covered" write-up with no committed mock files is called out
    as a failure of the step. The prose output is reframed as a summary of the mocks it
    committed (which services/operations are now mocked, and what was deliberately left
    unmocked).
  - **Tester.** Reframed as exploratory testing that actually runs the software:
    greenlights must be backed by observed runtime behaviour, not by reading the diff.
    It now starts from the earlier steps' artifacts — the `spec/` document and its
    Gherkin acceptance scenarios for the new functionality, and the WireMock mocks the
    mocker stood up on localhost via docker-compose — then probes edge/error cases and
    does a reasonable amount of regression testing of the blast radius. Sub-blocking
    issues go in `concerns` at low/medium severity without necessarily withholding the
    greenlight (the engine still skips the fixer when the report is greenlit).

  The existing tester gate already dispatches the `fixer` companion on a withheld
  greenlight and skips it when the tests pass — no wiring, pipeline or harness-image
  change for the prompts.

  **Frontend (`@cat-factory/app`).**

  - **Dedicated test-report window.** The `tester` archetype now declares a `resultView`,
    so opening a tester step opens a structured window (the universal result-view seam,
    like the requirements review) instead of the generic prose panel. It renders the
    report as a hierarchical tree — the scenarios the Tester exercised (its `tested`
    areas) → the per-area outcomes (passed / failed / skipped) → the concerns grouped
    under them — plus the greenlight verdict, outcome counts and the fixer-attempt state.
    The service spec is not yet exposed to the SPA, so spec-element linkage is derived
    from the report itself (a future spec endpoint can make it explicit).
  - **Companion visualization.** Companion steps (`reviewer` / `architect-companion` /
    `spec-companion` / `fixer`) are now visually tagged as companions in the pipeline
    views, and a gate step's conditionally-run companion — today the Tester's `fixer` —
    renders as a distinct sub-node marked **possible / running / completed / skipped**
    (in both `PipelineProgress` and the inspector's `TaskExecution`). `fixer` is added to
    the agent catalog + the `AgentKind` union.

- b80d657: Reorganize the `agents/` source into focused subfolders so each agent's prompt is
  easy to find. Pure internal refactor: the package's public barrel exports are
  unchanged, the precompiled template output is byte-identical, and behaviour is the
  same. The prompt TEXT now lives under `agents/prompts/*` (one file per track:
  `standard`, `acceptance`, `business-logic`, `mock`, `testing`, `companion`,
  `requirements`, plus the thin `roles` map extracted from the old `agent-catalog`,
  and the shared `shared`/`delivery-contract` constants); metadata ABOUT kinds lives
  under `agents/kinds/*` (`companions`, `traits`, `configs`, `read-only`, `registry`,
  `versions`); the model-call machinery lives under `agents/runtime/*` (`executor`,
  `routing`, `fragments`, `web-search`); and `agents/catalog.ts` is the dispatcher
  that maps a kind to its prompt. The versioned-prompt registry (`versions`) is split
  from the requirements prompt text (`prompts/requirements`) it references.
- 2dd7e56: Spec reviewer (`spec-companion`) now judges only what the Spec Writer controls.

  The reviewer kept faulting the writer for things the writer was never allowed to add:
  error paths, validation rules, and status codes the requirements never stated (or
  explicitly put out of scope), plus open questions like "is an extra field discarded?".
  That is reviewing the requirements, not the spec — exactly what the writer's mandate
  forbids it from filling.

  The prompt now: covers the happy path for every stated behaviour plus only the
  error/edge/boundary cases the requirements explicitly call for or that a stated
  requirement cannot be satisfied without; honours the requirements' own non-goals,
  assumptions, and exclusions instead of penalising the spec for leaving them out; and
  never asks the writer to "clarify" or "decide" a question the requirements left open.

- 86a5843: Require final-answer agents to emit the answer in the reply, not the reasoning channel.

  A spec-writer run, then a blueprinter run, on `@cf/moonshotai/kimi-k2.7-code` failed
  with "the agent did not return a usable ...: its final turn produced no text (an empty
  completion)" even though the model produced a complete, valid document. The whole
  answer landed in the model's reasoning channel and the visible reply came back empty
  (telemetry: `finish_reason='stop'`, thousands of completion tokens, ~31k chars of
  `reasoning_text`, zero visible content). The harness reads the deliverable from the
  visible content only, so the no-empty-outcome gate (`unusableFinalAnswerCause`)
  correctly failed the run.

  This is universal to any agent whose deliverable IS its final reply. Added a shared
  `FINAL_ANSWER_IN_REPLY` fragment (`@cat-factory/agents`, `prompts/shared.ts`) that
  names the channel, and applied it to every final-answer agent: the four container
  constants in `ContainerAgentExecutor.ts` (spec-writer, blueprint, merger, on-call), the
  design/review/test standard phases, the tester report, the business-reviewer, the
  companions, the requirements reviewer + rework, and the generic report roles
  (researcher, analysis, bug-investigator, documenter, integrator, task-estimator,
  merger). It is deliberately NOT applied to side-effect agents whose product is a pushed
  commit (coder, ci-fixer, conflict-resolver, mocker, playwright, business-documenter):
  they legitimately end with no final text. The spec-writer prompt also now states it has
  no repository write access, removing the "maybe it just wants me to push the file"
  reading. Bumped the `requirement-review`, `requirement-rework`, and `review` versioned
  prompts. The no-empty-outcome gate stays as the safety net.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- 43f2443: Add a unified, persisted requirements structure stored in each service's GitHub
  repo. A new `requirements-writer` container agent runs before the coder in
  `pl_full` (and standalone via the new `pl_requirements` pipeline): it aggregates
  the clarified requirements of every task under the service frame into one
  PRESCRIPTIVE document, committed to the implementation branch
  (`cat-factory/<blockId>`, created from base when absent) so the spec is present
  before any code is written.

  The harness deterministically renders the document into `requirements/`: the
  canonical `requirements.json` (a `RequirementsDoc`), `overview.md`, `rules.md`
  (cross-cutting domain rules / invariants), a `version.json` staleness manifest,
  and Gherkin `features/*.feature` files (one `Scenario` per acceptance criterion).
  Gherkin is generated two-pass — mechanical render in the harness, then the
  `acceptance` agent polishes the `.feature` files and `playwright` turns each
  scenario into a runnable test. Every container agent reads the requirements via a
  new `REQUIREMENTS_GUIDANCE` block in its global `AGENTS.md`. The in-repo files are
  the source of truth; the engine strictly validates the returned doc
  (`parseRequirementsDoc`) at ingest. Mirrors the blueprint pattern; covered by the
  cross-runtime conformance suite.

- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2d66d34]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/prompt-fragments@0.7.0
