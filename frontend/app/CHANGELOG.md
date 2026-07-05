# @cat-factory/app

## 0.90.0

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

## 0.89.0

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

## 0.88.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase E — the `bug-intake` engine step (engine + SPA).

  The recurring bug-triage pipeline's inbound entry point: each scheduled fire pulls ONE matching
  open issue from the schedule's configured tracker board, claims it, and seeds the reused block
  from it so every downstream step works that bug. Consumes the Phase D foundations
  (`searchIssues`, `issueIntake`, `onIssuePickedUp`, `replaceForBlock`); no harness change, no
  image bump.

  - **`bug-intake` engine step** — a non-LLM one-shot step (the inbound dual of `tracker`),
    registered as a `StepHandler` in the engine so it never reaches a container. It resolves the
    schedule's `issueIntake` config by block, searches the source (predicates pushed into the
    vendor query), dedupes against every already-worked issue in ONE batched projection read,
    picks the oldest match, imports + **replace-links** it onto the block, rewrites the block's
    title/description from it, and posts the best-effort "taken by cat-factory" pickup writeback.
    The read-and-claim logic lives in a new provider-neutral `BugIntakeService`
    (`@cat-factory/integrations`), wired into the engine only when task sources are configured.
  - **No-match no-op** — when nothing qualifies (or no task source is wired), the run completes
    SUCCESSFULLY with every remaining step marked `skipped` (there is nothing to fix) and no
    notification — the outcome is visible in the schedule's run history. A scoped early-complete
    that reuses the existing skip/finalize machinery, not a new gate archetype.
  - **Schedule validation** — `RecurringPipelineService.create`/`update` now require an
    `issueIntake` config, pointed at a connected task source, whenever the pipeline carries an
    enabled `bug-intake` step (validated at both boundaries, including clearing the config on an
    existing bug-intake schedule) — otherwise every fire would silently no-op.
  - **SPA** — `RecurringPipelineModal.vue` gains an issue-intake section (source picker from the
    connected task sources, per-vendor board field, and the title/labels/issue-type predicates)
    shown when the picked pipeline has a `bug-intake` step, with i18n across all locales.
  - **Conformance** — intake pickup (a matching issue is imported, linked and seeds the block),
    the no-match no-op (the run completes with the remaining steps skipped), and the
    missing-config rejection are asserted on every runtime against a fake task source.

  Review fixes folded in:

  - The no-match no-op now finalizes the reused block `done` DIRECTLY instead of via
    `finalizeBlock`, which for a mergerless bug-triage pipeline would have flipped the block
    `pr_ready` and raised a spurious `pipeline_complete` "confirm + merge the PR" notification for a
    PR that does not exist. The conformance no-match test now asserts the `done` status and that no
    notification is raised.
  - Schedule intake validation now checks `TaskConnectionService.isOffered` (available AND enabled)
    rather than `isEnabled`, which defaults ON for a never-connected source and so would have waved
    through intake from a source with no connection to search.
  - `PipelineService.update` now rejects enabling a `bug-intake` step on a pipeline whose attached
    schedules carry no `issueIntake` config (the pipeline-edit dual of the schedule-attach guard).
  - Reseeding the reused block on pickup also clears the previous fire's `peerPullRequests` so a new
    bug doesn't inherit a prior bug's connected-repo PRs.
  - `RecurringPipelineModal.vue`'s bug-intake detection now respects the per-step `enabled` mask,
    mirroring the backend, and the literal `owner/name` / `bug` / `in-progress` placeholder examples
    are inlined in the component rather than living (and being mistranslated) in the message catalog.

- c20a69a: feat(initiatives): slice 4 — follow-ups & polish

  Complete the Initiatives feature: a settling spawned-task run's forward-looking
  follow-ups (and, on failure, its real cause) are harvested onto the initiative
  tracker at the terminal emit; a human promotes an open follow-up into a new
  `pending` tracker item or dismisses it, retries/skips/re-scopes items, and retunes
  the execution policy — all over the existing rev-CAS single-writer path. No new
  persistence or facade wiring: the curation state rides the initiative `doc` blob
  (D1 ⇄ Drizzle parity unchanged), and the harvest reuses the in-hand run instance
  so it costs no extra read.

### Patch Changes

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

- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0

## 0.87.5

### Patch Changes

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

## 0.87.4

### Patch Changes

- 633c4a9: UX papercuts (docs/initiatives/ux-papercuts.md): render agent prose as markdown and make
  structured output copyable in the result-view surfaces (UX-43, UX-44 copy affordances).

  - New shared `renderMarkdown()` reader (secure markdown-it, `html: false`, links decorated to
    open safely in a new tab) + a reusable `common/MarkdownProse.vue` component that renders it
    with the inspector's prose styling.
  - The merger result view (rationale + pre-structured raw output), the consensus session window
    (synthesis + round contributions), and the generic structured result view (prose summary) now
    route their prose through `MarkdownProse` instead of a `whitespace-pre-wrap` plain-text dump,
    so `**bold**`, lists, code, and links read as formatted prose — consistent with
    `AgentStepDetail`'s reader.
  - Copy affordances (the shared `common/CopyButton.vue`) added to the generic structured JSON
    block and to the consensus synthesis + each round contribution, so a user can lift the
    structured output without a manual select-all.

## 0.87.3

### Patch Changes

- e73285e: UX papercuts (docs/initiatives/ux-papercuts.md): stop leaking raw internal identifiers into
  the review and consensus windows (UX-36/37).

  - The requirements- and clarity-review windows now render the reviewer's model through
    `models.labelForRef(...)` (friendly `<label> · <provider>` label) instead of the raw
    `provider:model` id, matching the pipeline step surfaces; it falls back to the bare ref when
    the catalog hasn't loaded, so there is no regression.
  - The consensus session window renders the step's `agentKind` through `agentKindMeta(...).label`
    (a human title) instead of the raw enum, and each participant's model through
    `models.labelForRef(...)` instead of the raw `modelId`.

## 0.87.2

### Patch Changes

- 0d78224: UX papercuts (docs/initiatives/ux-papercuts.md): clipboard-feedback shared primitive
  (UX-38/39).

  - New `useCopyToClipboard()` composable wraps VueUse's `useClipboard` and always toasts the
    outcome, only claiming success once the write actually landed — so a copy in an insecure
    context or with a denied permission surfaces a failure toast instead of a silent no-op.
  - All previously-silent copy handlers now route through it: `StepMetadataCard`/`StepRunMeta`
    (run id), `AgentStepDetail` (raw output), `KubernetesEngineForm` (auto-setup command); the
    origin pattern in `StepContainerStatus` is refactored onto the composable.
  - New reusable `common/CopyButton.vue` (title + aria-label) makes error/detail surfaces
    copyable: the failure stack-trace `<pre>` (`FailureDetail`, so both `AgentFailureCard` and
    `AgentFailureHistory`), the consensus failure banner, and the gate failure summary.

## 0.87.1

### Patch Changes

- 6c1efd1: Docker Compose ephemeral envs: opt-in build-from-source mode.

  The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
  `build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
  its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

  A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
  `ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
  the isolation-safe rewritten compose beside the original inside the checkout, and runs
  `docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
  and relative `env_file`s are honored. Image mode is unchanged and remains the default.

  Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
  sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
  all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
  separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
  unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
  cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
  from disk, so their services would otherwise slip a privileged container / host bind / pinned port
  past the parse-based guard. `privileged: true` stays refused.

  The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
  facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
  `clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
  tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
  they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
  Build mode registers only on the docker-family local runtime — the documented runtime-bound
  exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

  Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
  recommended in build-from-source mode (previously it was recommended blindly and then failed at
  provision time).

  The compose environment connect form gains an "Image source" selector (pull pre-built vs build
  from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0

## 0.87.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0

## 0.86.0

### Minor Changes

- ef57cb1: Bug-triage pipeline, Phase A — pipeline `availability` (one-off / recurring / both).

  A library pipeline can now declare HOW it may be launched, so a recurring-only pipeline (the
  upcoming `pl_bug_triage`) can't be started as a manual one-off, and a one-off-only pipeline can't
  be attached to a schedule. Absent means `'both'` (unrestricted) — pre-1.0, no migration/back-fill,
  existing rows read unchanged.

  - **Contract**: `pipelineSchema` gains `availability?: 'one-off' | 'recurring' | 'both'` (+ the
    `PipelineAvailability` type, re-exported from kernel); `createPipeline`/`updatePipeline` accept
    and persist it.
  - **Persistence** (both runtimes, kept symmetric): `availability` is a new `pipelines.availability`
    column — D1 migration `0037_pipeline_availability.sql` ⇄ Drizzle schema + generated migration —
    read/written by the shared `rowToPipeline` mapper and both repos, so the field round-trips
    instead of being silently dropped on save.
  - **Server enforcement** (the pickers are convenience, not the gate): `ExecutionService.start`
    gains an `origin: 'manual' | 'recurring'` option (default `'manual'`), and a start-only
    `assertPipelineLaunchable` gate rejects a manual start of a recurring-only pipeline (and a
    scheduled fire of a one-off-only one). `RecurringPipelineService.fire` passes `'recurring'`; its
    `create`/`update` reject attaching a one-off-only pipeline to a schedule. A retry/restart
    re-drives an already-validated run, so it never re-checks the launch constraint. A pipeline
    carrying an ENABLED `bug-intake` step must be `'recurring'` (validated at builder save + start;
    a disabled step imposes no requirement). The schedule-attach check delegates to the same gate
    (one rule, one `ValidationError`), and `clone` re-runs it so an un-launchable copy can't be
    minted. Editing a pipeline to `'one-off'` while a schedule still references it is rejected
    (`ConflictError`) rather than silently breaking every future fire.
  - **SPA pickers**: the manual-start surfaces (add-task modal, board/inspector Run menus, task
    run-settings default) filter out `'recurring'`-only pipelines, and the recurring-pipeline modal
    filters out `'one-off'`-only ones — composed with the existing `pipelineAllowedForFrame`
    predicate.

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0

## 0.85.0

### Minor Changes

- 1d738f7: feat(recurring): on-demand (manual-only) recurring tasks that can use individual-usage subscriptions

  A recurring pipeline can now be flagged **on-demand**: it has no cadence and is never
  fired by the sweeper — it runs ONLY when a person triggers it via "run now". Because a
  human is present at every fire, an on-demand schedule's block MAY target an individual-usage
  subscription model (Claude / Codex / GLM), unlocked per run-now with the initiator's personal
  password exactly like a manual task start. A cadence schedule still refuses individual-usage
  models (no one is present to unlock them unattended).

  - New `onDemand` flag on `PipelineSchedule` + `createScheduleSchema` (recurrence is now
    optional — an on-demand schedule needs none). Persisted as an `on_demand` column on both
    runtimes (D1 migration `0037` ⇄ Drizzle), with `listDue` filtering `on_demand = 0` so the
    sweeper skips them. Cross-runtime conformance asserts the flag round-trips and run-now fires.
  - `RecurringPipelineService.fire` exempts on-demand schedules from the individual-usage
    refusal and threads the run-now initiator + credential-activation closure into the run;
    the run-now controller resolves the personal-credential gate (428 when a password is needed).
  - Frontend: an "on-demand" toggle in the add-recurring modal (hides the cadence editor), an
    on-demand inspector view (no cadence/pause, just run-now), and run-now now rides the cached
    personal password through the credential modal. i18n in all 8 locales.

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0

## 0.84.0

### Minor Changes

- 47a2975: Initiatives slice 3 — the execution loop.

  An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
  initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
  the initiative once every tracker item settles.

  - **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
    `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
    `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
    → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
    the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
    cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
    rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
    never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
    next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
    blocks the item — the sweep never throws.
  - **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
    phase current, so the initiative never advances past it) and raises the new `initiative`
    notification type; in-flight siblings finish. A human retries/skips the item to unblock.
  - **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
    Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
    loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
    on a merge), so work advances without waiting for the next sweep.
  - **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
    skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
    the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
  - **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
    id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
    by the cross-runtime conformance suite.

  No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
  migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0

## 0.83.1

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0

## 0.83.0

### Minor Changes

- 7fa7578: Initiatives slice 2 — interactive planning.

  The Initiative Planning pipeline (`pl_initiative`) now interviews the human and analyses the
  codebase before the planner drafts, so the plan is grounded in the stakeholder's intent and the
  real code. The pipeline becomes
  `[initiative-interviewer → initiative-analyst → initiative-planner → approval gate → initiative-committer]`
  (catalog `version` bumped to 2, so workspaces get the reseed offer).

  - **`initiative-interviewer`** — a new inline LLM gate that asks clarifying questions about goals,
    scope and constraints, PARKS the planning run on a durable decision-wait while the human answers
    through a dedicated planning Q&A window, then synthesizes the agreed goal / constraints / non-goals
    brief. It is **entity-native**: the questions, answers and brief live directly on the `initiatives`
    entity (its `qa` + new `interview` fields) via the CAS `mutate` — no new table. Reuses the shared
    `RunStateMachine` park/answer/resume spine (the review-gate model). Passes through when no
    interviewer model is wired, so pipelines run unchanged.
  - **`initiative-analyst`** — a new container-explore agent that reads the repo and writes a prose
    codebase analysis onto the entity (`analysisSummary`), grounding the plan.
  - The **planner** and **analyst** prompts now fold in the interview brief + analysis (threaded onto
    the agent context for `initiative`-level runs).
  - New endpoints (`POST /blocks/:blockId/initiative-planning/{answer,continue,proceed}`), store
    actions and the `initiative-planning` result-view window; the inspector surfaces an "Answer
    planning questions" button while the interviewer is parked. `initiative.planning.*` copy added to
    all locales.

  Runtime-symmetric with no facade changes (the interviewer resolves its model exactly like the
  requirements reviewer, from the routing default already wired in both runtimes) and no new
  persistence — so no D1/Drizzle migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0

## 0.82.2

### Patch Changes

- ef688e8: UX papercuts (undo & confirmation cluster): make destructive board actions recoverable.

  - **Undo after delete (UX-01).** Deleting a block now defers the backend delete by a short
    window and shows a "Deleted X — Undo" toast that cancels it in place and restores the
    full subtree (blocks + dependency/epic/initiative edges). The pending subtree stays
    hidden across a coarse refresh or stray live event, and the deferred call targets the
    workspace the block was deleted from even after a workspace switch.
  - **Delete confirmation states the cascade scope (UX-02).** A service/module delete confirm
    now names the exact number of items that will be removed with it, instead of the vague
    "and everything inside it".
  - **Undo after drag-reparent (UX-03).** A drag that moves a block into a different container
    now offers a "Moved X — Undo" toast that returns it to its previous home — covering the
    easy overshoot-into-a-neighbour mistake.
  - **i18n move-failure toast (UX-13).** The `moveBlock` failure toast is now translated
    instead of a hardcoded English string.

## 0.82.1

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0

## 0.82.0

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

## 0.81.0

### Minor Changes

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

## 0.80.0

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

- f21b06f: Cleaner inspector panel: related entries are grouped into collapsible sections (a shared InspectorSection shell with a chevron header, item count, and header actions), each section carries a plain-language explanation of what it means and what it is used for, secondary configuration collapses by default while the live execution surface stays open, and a task's execution now renders above its configuration. New hint strings are translated in every locale.
- Updated dependencies [b216fdc]
  - @cat-factory/contracts@0.86.0

## 0.79.2

### Patch Changes

- b4c4130: Board: a newly added service frame is placed clear of existing board nodes and the camera centres on it.

  Adding a frame no longer drops it on top of a neighbour or leaves it off-screen. A new pure
  helper (`findFreeFramePosition` in `utils/framePlacement.ts`) picks the nearest non-overlapping
  top-left for a frame of a given size, and the `useFramePlacement` composable wires it to the live
  board + Vue Flow camera (`focusFrame` pans, gently zooming in only if the board is zoomed far out).
  The clearance considers every top-level board node — both service frames and epic grouping cards —
  so a new frame never lands on top of an epic either.
  Wired into all three add-a-frame paths:

  - **Palette drop** (`BoardCanvas`): the frame lands where you drop it, nudged off any frame it
    would overlap, then centred.
  - **Import from repo** (`AddServiceFromRepoModal`): the client now sends a computed free position
    instead of relying on the backend's fixed diagonal stagger, then centres on the import.
  - **Bootstrap** (`BootstrapModal`): the provisional frame is re-homed to free space (the backend
    stagger can land on top of a large existing service) and centred.

## 0.79.1

### Patch Changes

- bf4c029: Infrastructure attempts window (run details) now live-tracks every container spin-up /
  tear-down as it happens: while the run is active it silently re-polls so each attempt
  appears with its timestamp, and it does one final poll on the terminal transition to catch
  the last tear-down row. Background polls are silent, so the "refreshing" spinner no longer
  flickers; once the run is terminal the auto-poll stops, while the manual refresh control
  stays available so a missed or not-yet-persisted tear-down row can always be refetched.

## 0.79.0

### Minor Changes

- 0ac0dc4: Surface per-iteration fixing instructions in polling-gate run details. A `ci` /
  `conflicts` gate's helper attempt now records the instructions it was handed (the
  failing-check summary + structured red checks for CI, the conflict/review detail for the
  others) alongside the helper's own report, so the gate window shows WHAT each round set out
  to fix — bringing the gate attempt timeline to parity with the Tester's fixer timeline
  (`concerns` + `summary`). Adds `instructions` / `failingChecks` to `gateAttemptSchema` and a
  transient `lastDispatchedInstructions` stash on `gateStepStateSchema` (schemaless step JSON,
  no migration).

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0

## 0.78.0

### Minor Changes

- 36f4cf6: Frontend UI-test bindings: surface how each backend binding resolves + a non-fatal run-start note.

  - **Shared resolution helpers moved to `@cat-factory/contracts`** (next to `frontendOriginsForService`)
    so the SPA and the backend share ONE source of truth: `resolveFrontendBindings`,
    `indexLiveServiceEnvUrls`, `boundServiceFrameIds`, the `ResolvedFrontendBinding`/`LiveEnvHandle`
    types, and a new pure `buildFrontendRunNotes`. Orchestration re-exports them, so existing importers
    are unchanged.
  - **Inspector resolved-binding visibility**: `FrontendConfig.vue` now shows, live, how each backend
    binding resolves — `envVar → a bound service's live ephemeral URL | mocked (WireMock)` — mirroring
    what a UI-test run resolves, plus a warning for duplicate env vars. Backed by a new lightweight
    `environments` store over `GET /workspaces/:ws/environments`.
  - **Run/step detail projection + run-start note**: the engine stamps BOTH the resolved bindings
    (`ExecutionInstance.frontendBindings`) and the non-fatal advisories (`ExecutionInstance.notes`:
    duplicate env vars, or a partial-live set where some bound services fall back to WireMock) on the
    run ONCE at start — the SPA-visible mirror of the harness's own `buildInfraNotes`. A `tester-ui`
    step's detail projects the FROZEN start-time bindings (so a finished run shows what it actually
    drove against, not a live re-resolution that could disagree with the co-located note after the
    envs are torn down); the run-start note shows on any step detail of a frontend-frame run. Both
    ride in the run's `detail` JSON (no migration) and round-trip identically on D1 ⇄ Postgres.

  No wire/behaviour break: the notes field is optional, the moved helpers are re-exported, and a
  non-frontend run is unaffected.

- b78adf5: Private package registries: workspace-scoped npm registry credentials (npm private
  orgs + GitHub Packages) that agent containers use to resolve private dependencies on
  checkout.

  - **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
    ⇄ Drizzle mirror) holding a single sealed JSON array of entries
    (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
    cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
    scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
  - **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
    (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
    write-only — the list view never returns them; edit = delete + re-add. Only one
    entry per vendor is allowed (a 409 otherwise): the harness renders a single
    host-keyed `_authToken` per registry, so a duplicate token would be silently
    dropped — put every scope for a vendor on its one entry. Tokens are validated as a
    single opaque printable-ASCII string (no spaces/control characters) so a token can't
    inject extra `~/.npmrc` lines.
  - **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
    `resolvePackageRegistries` seam (wired in both facades from the same store) and
    forward the decrypted entries as a `packageRegistries` field on every container job
    body, like `ghToken`. The registry host is derived backend-side from the fixed
    vendor set. A resolution failure fails the dispatch rather than silently running
    without auth. The agent-context snapshot's allow-list projection excludes the field.
  - **UI**: a "Private package registries" panel in the Integrations hub
    (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
    listed from the redacted summary.
  - **Conformance**: a new suite section asserts add → redacted list → decrypted
    dispatch resolution → remove identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0

## 0.77.0

### Minor Changes

- e0aab3f: Connections between services, phase 1 of the service-connections initiative (see
  `backend/docs/service-connections.md` + `docs/initiatives/service-connections.md`):

  - **Service connections**: a `service`-type frame carries `serviceConnections` — directed
    consumer→provider edges to the other services it uses, each with an optional
    description ("sends transactional email via it"). Stored as a JSON column on the block
    (D1 migration `0034` ⇄ Drizzle), validated at the `updateBlock` write gate (no
    self-connection, no duplicates, targets must be service frames; cycles are deliberately
    legal), pruned when a connected frame is deleted, and drawn as emerald consumer→provider
    edges on the board. A new inspector panel on service frames edits the connections and
    shows the reverse "Used by" list.
  - **Per-task involved services**: a task carries `involvedServiceIds` — the connected
    services directly involved in it beyond its own service, picked (in the task's run
    settings) from the frame's connection neighbors in either direction. Validated at the
    write gate against the neighbor set; a selection whose connection was later removed is
    badged stale in the UI and dropped on the next change. Later phases use the selection
    to provision every involved service as an ephemeral environment and to let the coding
    agent change every involved repo (multi-repo sibling checkouts) — designed in the
    docs, not yet implemented.
  - Cross-runtime conformance now round-trips both JSON columns and asserts the write-gate
    rejections on both stores.

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0

## 0.76.0

### Minor Changes

- 5ce03c6: Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
  help, and collapsible field groups.

  - **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
    (package manager from the lockfile, install command, build script + output dir from
    package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
    examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
    (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
    non-binding preview the user reviews and applies (backend bindings are appended, never
    overwriting existing service links).
  - **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
    subdirectory (threaded into the harness job-body builder).
  - **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
    from the separate env-injection axis.
  - **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
    injection / Backend bindings / Preview), collapsed by default.

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0

## 0.75.2

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

## 0.75.1

### Patch Changes

- 4a7a3f1: Preserve a task run's error trail across retries. A failed run's `failure` is now
  appended to a new `failureHistory` on the fresh attempt (persisted in the shared
  `agent_runs.detail`, so both runtimes get it with no migration), and cleared on the
  running attempt — so the top failure banner disappears the moment the task restarts
  while every previous error stays viewable in a "previous errors" history on the task
  inspector. Applies to both retry (resume-from-failure) and restart-from-step.
- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3

## 0.75.0

### Minor Changes

- 4e82496: Enable the prompt-fragment library by default and streamline linking GitHub-backed fragments.

  - The prompt-fragment library (ADR 0006) is now **on by default** in both runtimes; opt out
    with `PROMPT_LIBRARY_ENABLED=false`. Previously it was off unless `PROMPT_LIBRARY_ENABLED=true`
    was set, so linking a GitHub document as a fragment failed with "Prompt-fragment library is
    not configured" on a stock deployment.
  - The fragment-library manager now reuses the same GitHub affordances as the other repo
    windows: a **server-side repo search** (new `GitHubRepoSearchSelect`) plus the
    `RepoTreeBrowser` to browse to a **file** (document-backed fragments) or **directory**
    (repo sources), instead of hand-typing `owner`/`repo`/`path`/`ref`. Manual entry remains as
    a fallback when the GitHub App isn't connected.
  - When the library is explicitly disabled, the manager now shows a clear notice instead of
    offering forms that fail with a raw 503.

## 0.74.3

### Patch Changes

- 6243bea: Scope the "create task from a GitHub issue" picker's already-imported list to the
  target service's repo. The quick-pick list of imported issues was filtered only by
  source and free text, so it leaked in issues from every repo in the workspace even
  though the live search was already repo-scoped. `listTasks` now accepts an optional
  `blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
  the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
  Linear) are unaffected. The picker fetches its own repo-scoped list rather than
  reading the shared workspace-wide store.
- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2

## 0.74.2

### Patch Changes

- 9638bf3: Fix the "Create task from issue" window: it now reuses the same tracker-issue
  picker as the add-task "context issues" flow. Search-by-title works and is scoped
  to the repo of the container the task is being created in (so GitHub hits stay in
  that service's repo), pasting an issue URL/key now actually creates a task instead
  of silently importing it, and the tracker source (GitHub / Jira / Linear) is always
  shown and selectable. The shared `ContextIssuePicker` also now recognises
  Jira/Linear issue keys (e.g. `PROJ-123`) as attach-by-reference input and re-runs
  its search when the scoped block changes.

## 0.74.1

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1

## 0.74.0

### Minor Changes

- 67d3876: feat(github): search available repos server-side in the "add service from repo" picker.
  The picker no longer prefetches the entire installation repo list on open (slow for a wide
  App install or PAT with hundreds of repos, and it blocked filtering until the whole list
  loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
  `GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
  param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
  manual "refresh list" button is removed (each search hits GitHub live).

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0

## 0.73.1

### Patch Changes

- d7f6e1c: Correctness fixes across the engine, the Node facade, and the SPA stores:

  - **Engine:** `finalizeMerge` and the merger resolver are now idempotent under
    durable-driver replays — a re-resolved merger step on an already-`done` (= merged)
    block is a no-op instead of re-merging, downgrading the block to `pr_ready`, and
    raising a spurious `merge_review` notification. `approveStep` now runs under the same
    optimistic-concurrency write as its siblings (`resolveDecision`/`requestStepChanges`),
    so an approve holding a stale snapshot can no longer resurrect a run a racing reject
    already failed (it now returns 409).
  - **CI gate (behavior change):** a check run concluding `stale` (superseded by GitHub)
    no longer fails the CI gate — previously it looped the `ci-fixer` against a check it
    could never fix until the attempt budget failed the run. `cancelled`/`timed_out`/
    `action_required` still fail the gate.
  - **Node facade parity:** the retention sweep now prunes the `github_commits`
    projection to `retention.commitMs` (previously it grew without bound; the Worker
    already pruned it), and a new every-2-min GitHub reconcile sweeper re-syncs stale
    repo projections and tombstones uninstalled installations — the backstop for missed
    webhooks the Worker's `github-reconcile` cron already provided.
  - **SPA stores:** the execution store now reconciles snapshots/events monotonically by
    the run's `rev` (a lagging refresh can no longer revert a just-terminal run to
    `running`), the requirements/clarity/brainstorm stores guard live-event upserts by
    `updatedAt` (out-of-order events no longer revert just-submitted answers), and
    `board.moveBlock`/`updateBlock` roll their optimistic mutation back on API failure.

- Updated dependencies [d7f6e1c]
  - @cat-factory/contracts@0.80.1

## 0.73.0

### Minor Changes

- 120de05: feat(testing): pipeline-builder toggle + Test Report surfacing for the test quality companion (PR 2)

  Completes the test quality-control (QC) companion (see
  `docs/initiatives/tester-quality-companion.md`) with its authoring + observability surfaces:

  - **Pipeline builder**: a per-Tester-step toggle (enabled by default) turns the QC companion
    off, and an optional estimate-gating panel runs the coverage audit only on tasks whose
    estimate clears a threshold (mirroring the companion-gating panel). The estimator-required
    hint now covers QC gating too.
  - **Test Report window**: a "Coverage review" section renders each QC verdict (adequate /
    gaps-found, the reviewer's feedback + concrete gaps, model, timestamp) plus the loop budget
    and a "budget spent" badge — so a report that greenlit only after a QC-driven re-run shows
    why it looped.
  - **Persistence fix**: the pipeline create/update/clone API + `PipelineService` now thread
    `testerQuality` (and the sibling `followUps`, which had the same latent gap) end-to-end, so a
    custom pipeline's builder toggle actually persists instead of being silently stripped by the
    request-body validator. This includes the persistence layer itself: new `follow_ups` +
    `tester_quality` JSON columns on the `pipelines` table, mirrored D1 (migration
    `0032_pipeline_companion_toggles`) ⇄ Drizzle (schema + generated migration), written by both
    repos and read by the shared `rowToPipeline` mapper. A QC estimate gate is validated like
    companion gating (a threshold must be set and a `task-estimator` must run earlier).
  - **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
    report) is now driven through an injected deterministic reviewer on every runtime, asserting
    the verdicts + counters persist identically across D1 and Drizzle. A separate round-trip
    assertion saves a custom pipeline with a `followUps` opt-out + a gated `testerQuality` config
    and re-reads it from the store, so the new columns can't silently drop the toggles on either
    runtime.

  All new user-facing copy is translated across every shipped locale.

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0

## 0.72.1

### Patch Changes

- 31a80a1: UX reliability & feedback hardening: inspector edits (title/description/run settings) now roll
  back and toast on a failed save instead of silently sticking a stale value; notification
  act/dismiss failures surface an error toast; the `Delete` key can no longer delete a block hidden
  behind an open result-view window (those windows now carry `role="dialog"`); merging a PR and
  discarding a run are gated behind a confirm; an emptied task title reverts to its last saved
  value; a "Reconnecting…" indicator shows when the live event stream drops; and the remaining
  hardcoded app-shell / toast / bootstrap strings are routed through i18n.

## 0.72.0

### Minor Changes

- dcc8b32: Browsable frontend preview — SPA surface (slice 5d of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  The frontend-frame inspector now surfaces the live browsable preview: when the frame's
  `previewEnabled` toggle is on (local/node only), a control shows the preview's status, a
  clickable "Open preview" URL once it is serving, and start / stop buttons. A new
  `usePreviewStore` drives the three preview endpoints (`GET|POST|DELETE
/workspaces/:ws/frames/:frameId/preview`), self-polling while the preview is `starting` so
  the URL appears the moment it comes up. All copy is translated across every locale.

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0

## 0.71.3

### Patch Changes

- 16ee6cc: Surface the merger's verdict as a structured decision instead of raw JSON.

  The engine now records a `MergeDecision` on the completed `merger` step (`step.custom`): the
  assessment scores, the resolved preset ceilings, and — crucially — whether it auto-merged or routed
  the PR to a human, and WHY (`within_thresholds` / `exceeded_thresholds` / `auto_merge_disabled` /
  `no_rationale` / `no_assessment` / `merge_failed` — `no_rationale` distinguishes a scored-but-
  unexplained assessment from a truly absent one). The SPA renders it in a dedicated `MergerResultView` (complexity /
  risk / impact bars vs their ceilings + a plain-language decision banner — "Auto-merged — every score
  is within the Balanced thresholds" / "Awaiting human review — risk exceeded the thresholds") instead
  of the agent's raw JSON.

  Also fixes the inspector showing a finished merger step as "Agent running": the run's shared container
  is kept alive until the pipeline's final step, so a step whose state is already `done` (the merger
  resolving mid-pipeline before a trailing gate) no longer displays the stale live container-phase label.

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1

## 0.71.2

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0

## 0.71.1

### Patch Changes

- e9e9fbe: Show the spend/budget meter in the board toolbar as soon as a workspace budget is
  configured (previously it only appeared once tokens had been metered, so setting a
  budget at zero spend left the limit and usage hidden). Saving a budget now also
  refreshes the workspace snapshot so the meter reflects the new limit/currency
  immediately.

## 0.71.0

### Minor Changes

- edf4e69: feat(frontend): gate visual pipelines to frames with a UI (slice 4c of the frontend-preview +
  in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A pipeline with a VISUAL step — `tester-ui` (drives a real browser against a running frontend) or
  `visual-confirmation` (the human gate over its screenshots) — only makes sense where there is a UI
  to exercise. Until now nothing stopped `pl_frontend` / `pl_visual` from being started on a bare
  backend `service` (or a `library` / `document`) frame, where `tester-ui` has no app to drive.

  The engine now refuses such a start unless the task's enclosing frame is a `frontend` frame (it
  owns the app under test) OR a frame a `frontend` frame links to (its `frontendConfig.backendBindings`
  name it as a `service` upstream — the linked frontend is the UI a change to that service is
  validated through). The SPA surfaces the SAME rule so those pipelines are hidden from the pickers
  where they can't run, and both sides share one predicate so the surface can't drift from the gate.

  - **Shared predicates in `@cat-factory/contracts`** (`pipelineHasVisualStep`,
    `frameAllowsVisualPipeline`, and the canonical `UI_TESTER_AGENT_KIND` /
    `VISUAL_CONFIRM_AGENT_KIND` slugs, now re-exported by orchestration's `ci.logic` so the wire
    values can't drift). The link scan reads the workspace block list once — no per-frame point read.
  - **Run-start gate** (`ExecutionService.assertPipelineFrameTypeAllowed`): a new
    `visual_pipeline_no_frontend` conflict reason, refused before any side effects, alongside the
    existing tester-infra / binary-storage start guards. A non-visual pipeline passes through.
  - **SPA surface**: the task-create, run-settings, run-launcher (inspector + focus view) and
    recurring-schedule pipeline pickers filter out visual pipelines for a frame with no UI, keyed off
    the block's enclosing frame and the board's frontend→service links. The new conflict reason maps
    to a localized toast title across every locale.
  - **Conformance**: a cross-runtime assertion refuses a visual pipeline on a bare service frame
    (`visual_pipeline_no_frontend`) and lets the same run START once a frontend links that service —
    pinning the D1 ⇄ Drizzle parity of reading `frontend_config` during the run-start gate.

- f21279e: Warn when required infrastructure is undefined. The workspace snapshot now carries an
  `infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
  deployment actually wired) that tracks three areas explicitly as `not_defined` /
  `configured` / `not_applicable`:

  - **Ephemeral environments** (all runtimes that wire the environments integration) —
    `not_defined` when no environment provider connection is registered, so testing agents
    that need a live environment can't run.
  - **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
    local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
    pool is registered, so NO container agents can run. This area fires only where the pool is the
    SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
    when it uses the default pool transport); Cloudflare and local both wire the runner surface but
    keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
    `!!container.runners` check would otherwise falsely nag on every local deployment.
  - **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
    store) — `not_defined` when the account selected no content-storage backend, so UI
    screenshots / reference images have nowhere to live.

  The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
  into the relevant configuration. Dismissing a banner asks whether to hide it just for this
  session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
  again" — the latter persisted per-user in localStorage.

  The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
  single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
  instead of drawing on top of each other. The `RunnerPoolConnectionService` and
  `EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
  projection uses on the hot board-load path.

  Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
  or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
  stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
  key + the infra-setup area list are exported from `@cat-factory/contracts`
  (`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
  source of truth, and the stacked banner cards announce through a single polite live region instead
  of one assertive alert each.

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

- 1d2684f: fix(board): don't drop a live-added bootstrap run when a stale snapshot resync races it

  `agentRuns.hydrate` reconciled a workspace snapshot by mapping over the incoming jobs only, so
  a bootstrap run that a live `bootstrap` event had just ADDED — but which a stale, in-flight
  snapshot (the stream's on-connect resync, fetched before the run started) never observed — was
  silently dropped. A terminal bootstrap emits nothing further, so the service frame was stranded
  on a stale "bootstrapping…" badge (or lost its failure banner) with no event to correct it.

  `hydrate` now preserves cached runs the snapshot hasn't observed yet, scoped to the workspace
  (bootstrap runs carry `workspaceId`), so a board switch still discards the previous board's runs.
  This also fixes the intermittent `bootstrap-live` e2e failure (the live failure banner never
  arriving within the timeout under shard load, only to pass on a page-reload retry).

- 9e93fe8: feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
  long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
  self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
  Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
  on every runtime and read by nothing.

  This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
  run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

  - **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
    `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
    so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
    Node + local `true`.
  - **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
    true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
    explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
    when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
    local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
  - **Conformance** pins that the axis is present + boolean on every facade (its value is a
    differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.

- e0aa45e: Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
  frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
  the two together — all as localhost processes in the one container (no Docker-in-Docker), so
  it works on Cloudflare and Apple `container` too.

  - **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
    installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
    for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
    the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
    (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
    (executor-harness image bumped to 1.28.0).
  - **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
    `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
    live ephemeral env URL for the service under test, else a WireMock mock). The engine's
    `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
    frontend UI test only when it binds a live-backend `service` with none actually live (a
    mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
    Empty-envVar bindings are filtered.
  - **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
    `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
    WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
    not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
    from the injected build env, and a configured `servePort` that collides with a reserved
    in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
    inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
    are de-duplicated in the harness. The frontend UI-test gate's batch env read
    (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
    allow-list so the gate resolves in mothership mode.
  - **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
    watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
    `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
    otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
    forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
    dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
    now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
    The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
    in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
    (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
    infra gap rather than an app defect.
  - **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
    SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
    `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
    from the repo root would have targeted the wrong directory (the docker-compose stand-up still
    runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
    frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
    out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
    in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
    / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
    binding that reconfigures the package manager, git, or the TLS trust store during the build is
    dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
    (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
    server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
    gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
    already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
    `?? {}` empty-fallback spread in the serve env).
  - **Hardening (fourth review round)**: the reserved-env family filter (`npm_config_*` / `GIT_*`)
    now matches **case-insensitively** in BOTH the harness parse and the backend infra-spec builder —
    npm reads its config env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY`
    (upper/mixed case) is honoured just like `npm_config_registry`; a case-sensitive prefix match
    would have let the upper-cased form slip through and reconfigure the package manager during the
    build. The frontend serve/WireMock health-check now also aborts an in-flight probe on the run's
    own abort signal (not just the per-attempt timeout). The stale `envInjectionHint` translation is
    synced across all locales, and the missed-translation class is now guarded in CI (see the app
    note). The agent prompt-note assembly and the frontend `installCommand` are extracted as pure
    helpers with unit coverage.

  `@cat-factory/app`: sync the `envInjectionHint` hint across all locales (the `en` update noting
  the build-tool prefix caveat, e.g. Vite only exposes `VITE_*`, had been left untranslated). A new
  CI **locale-parity guard** now fails a PR that changes an `en.json` message key without changing
  the same key in every other locale, so translations can't silently go stale.

  BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
  (`service` | `frontend`); the default backend-service tester shape is unchanged.

- ab7d589: feat(infra): view, retest and safely edit a stored Kubernetes test-environment connection

  The Test-environments Kubernetes handler previously only offered a delete: opening the edit form
  cleared the write-only ServiceAccount token, so "Test connection" on a saved connection always
  failed auth (no token) and re-saving a non-secret tweak silently wiped the stored token.

  - Backend (`EnvironmentConnectionService` + `EnvironmentUserHandlerService`, runtime-neutral):
    `testHandler` now falls back to the SAVED handler's stored secret, so an established connection
    can be tested (or a non-secret field edited and tested) without re-entering the token; a
    freshly-typed value still overrides it. Saving a handler now PRESERVES stored secrets the
    operator left blank (a blank/omitted secret means "keep it") and replaces them only when a new
    value is supplied. Shared `overlaySecrets` helper; no schema change.
  - Frontend: the Kubernetes engine form shows when a token is already saved, makes the token
    optional on edit ("leave blank to keep"), and enables Test against the stored token. The
    handler list now frames each entry as an established connection with a prominent connected
    checkbox and an inline Test-connection button.

- 8bab651: fix(board): announce the workspace stream as connected only after its on-connect resync settles

  The real-time stream flipped `connected` the moment the socket opened, then fired the
  reconcile `workspace.refresh()` in the background. Under load that snapshot — fetched at
  connect time — could resolve AFTER a fresh live event and clobber it: `board.hydrate`
  replaces the block list wholesale, so it dropped a just-created provisional bootstrap frame
  the stale snapshot never saw, and its live "bootstrapping…" badge flickered out with no
  further board event to restore it.

  `connected` (and its `data-connected` attribute) now means "connected AND reconciled" — it is
  set only after the on-connect refresh settles (still on failure, so a transient refresh error
  can't wedge the indicator). Anything acting on a connected board — a user, or an e2e spec that
  gates on `data-connected` — now does so after the reconcile, so a lagging resync can't drop the
  state that action produces. Deflakes the `bootstrap-live` "provisional frame + live progress
  badge" e2e spec.

- 9091404: UX quality-of-life pass (follow-up): complete the destructive-confirm coverage across the
  settings/connection surfaces the first pass didn't reach. Add a reusable `useConfirmAction`
  composable (built on the same `useConfirm()` singleton + `useToast()`) that gates the
  recurring disconnect/remove/revoke/clear/destroy actions behind a confirmation and toasts on
  success, so every such affordance routes through one confirm-then-mutate + feedback path
  instead of mutating instantly and silently. Gated: revoke API key, revoke team invite,
  disconnect email sender, disconnect observability / incident provider, clear release-health
  config, destroy human-test environment, remove custom manifest type, remove reference
  architecture, disconnect task/document source, remove provider connection, remove Kubernetes
  handler / override / custom handler, and clear Slack / Linear / web-search config. Generic
  `common.confirm.*` / `common.toast.*` copy added across all 8 locales.

  The `clear` shape warns the config can be reconfigured later (a cleared config is
  re-enterable) rather than reusing the harsher "can't be undone" copy of the
  remove/revoke/destroy shapes, and destroying a human-test environment now surfaces an error
  toast on failure instead of silently rejecting.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0

## 0.70.1

### Patch Changes

- 3c4dcc6: Fix a live-vs-snapshot race that could leave a failed repo-bootstrap frame stuck on the
  "bootstrapping…" badge. A `board` event triggers a debounced `workspace.refresh()`, and that
  snapshot read can resolve AFTER a newer `bootstrap` event has already landed — a blind
  re-hydrate then regressed a terminal run (e.g. a `failed` bootstrap reverting to `running`,
  with no further event to correct it). `agentRuns` now reconciles bootstrap runs monotonically
  by `updatedAt`, so a lagging refresh (or out-of-order event) can't clobber a live transition.
- 3c4dcc6: Add stable `data-testid` hooks to the agent-failure banner + retry (`AgentFailureCard`), the
  bootstrap progress badge (`BlockNode`), and the inspector step rows + subtask bars
  (`TaskExecution`), so the e2e suite can assert on the failure/retry, bootstrap, merge-review
  and async-progress live flows. Behaviour-neutral markup only.
- 2d6dabe: UX quality-of-life pass (part 1): add a reusable confirmation dialog + `useConfirm()`
  and gate every destructive action behind it (delete task/module/service, recurring
  pipeline, custom pipeline, merge/model preset, and dependency edge), routed through a
  shared `useBlockDeletion` so the inspector button and future keyboard shortcut can't
  drift. Add a reusable `EmptyState` component and apply it to the context pickers, the
  dependency list, and the (previously blank) execution history.
- 2d6dabe: UX quality-of-life pass (part 2): confirm silent actions with feedback toasts (run
  started, notification handled/dismissed, one-click-copyable container id/url) and add a
  global keyboard layer — Escape to deselect/close the inspector, Delete/Backspace to remove
  the selected block (through the same confirm-gated deletion the inspector button uses), and
  `?` for a keyboard-shortcuts cheatsheet (also reachable from the command bar). Delete is
  guarded so it never fires while typing, and Escape yields to any open modal.

## 0.70.0

### Minor Changes

- 762fe66: Add a first-class `frontend`-frame configuration. A frontend frame now carries a
  `frontendConfig` (package manager, install/build/serve knobs, WireMock mappings path,
  preview toggle) plus `backendBindings` that map each env var the frontend reads to an
  upstream: a bound service frame's ephemeral environment, or a WireMock stub. The bindings
  double as board links, drawn as frontend→service edges on the canvas. New inspector panel
  (`FrontendConfig.vue`), the `frontend_config` JSON column mirrored across D1 and Drizzle
  with a cross-runtime conformance round-trip, and `frontendConfig` on the update-block input.

  Second slice of the frontend-preview + in-context UI-testing initiative
  (docs/initiatives/frontend-preview-ui-testing.md).

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0

## 0.69.1

### Patch Changes

- fb53662: Recover and surface stalled runs instead of letting them spin `running` forever.

  A run whose durable driver was lost (a crashed/restarted orchestrator that left its
  pg-boss advance job orphaned-`active`) previously stayed `running` indefinitely with no
  error: the Node stale-run sweeper's re-`send` is a silent no-op while the `exclusive`
  singleton is still held, so the run was never recovered or flagged.

  - **Sweeper now reclaims orphaned advance jobs.** It classifies each stale run's advance
    job by pg-boss's own heartbeat (`live` / `orphaned` / `missing`); an orphaned job (dead
    worker, frozen heartbeat) is deleted to free its singletonKey before re-driving, so a
    bare re-send no longer no-ops onto a dead job. Runs on boot too (immediate reconcile),
    not just on the interval.
  - **Hard-stall backstop.** A run orphaned past a deadline (`STALE_RUN_HARD_FAIL_MINUTES`,
    default 60) that recovery can't resume is failed with the new `stalled`
    `AgentFailureKind` — surfaced by the existing failure banner + retry (a new "Run stalled"
    title) instead of spinning silently. Symmetric on the Cloudflare cron sweeper.
  - **Orphaned local containers are reaped at boot** — a still-running per-run container
    whose run has since gone terminal/away (its `release()` never ran) is removed, via a new
    `AgentRunRepository.liveRunIds` batch query + a `ContainerRuntimeAdapter.listRunContainers`.
  - **Harness structured-repair retries transient failures.** The last-ditch structured-output
    repair call now retries HTTP 429 / 5xx / network errors with exponential backoff honoring
    `Retry-After`, so a transient rate-limit no longer turns a recoverable parse into a hard
    `no structured result` run failure. (executor-harness image bumped to 1.27.5.)

  Breaking (internal): `AgentRunRepository.listStale` now returns `StaleAgentRun` (adds
  `updatedAt`) and gains `liveRunIds`; both D1 and Drizzle repos implement them.

- Updated dependencies [fb53662]
  - @cat-factory/contracts@0.75.0

## 0.69.0

### Minor Changes

- 6f95aff: Add a repository-type selector to repo import and bootstrap. A frame can now be onboarded as
  a backend service, a frontend app, a shared library, or a document repository. Document
  repositories accept only document/spike tasks (enforced in `BoardService.addTask` and the
  create-task form). New `library`/`document` block types, `frameRepoTypeSchema`/`FRAME_REPO_TYPES`
  in contracts, and display metadata for the new types.

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0

## 0.68.1

### Patch Changes

- 51dd48f: Surface why the Kubernetes connect button is disabled, and align the `cat-factory k3s` CLI
  guidance with the actual form field names.

  - The Kubernetes connect forms (`KubernetesEngineForm`, `KubernetesRunnerForm`,
    `KubernetesEnvironmentForm`) now render a red hint next to the disabled **Connect** button
    listing the mandatory fields that are still empty (or, where applicable, the format/range
    issue), so a dead button explains itself instead of leaving the user guessing.
  - `cat-factory k3s`'s connection summary now names the fields exactly as the Local k3s form
    labels them: paste the token into the **"ServiceAccount token"** field (was "API token"),
    and set **"Environment URL source" → "Ingress host template"** with the **"Host template"**
    value (was a single "Ingress host template" line).

## 0.68.0

### Minor Changes

- 4cc6fd4: Tester run details now show an explicit "Test environment is up. The tester is starting its work." line while a still-running tester step has all of its infrastructure ready (its container is up, the ephemeral environment is `ready`, and any in-container dependency stand-up succeeded) and has not yet produced a report, so the details no longer jump silently from "provisioning" into a blank working state. The line clears once the step finishes, fails, or a report lands.

## 0.67.0

### Minor Changes

- 3643708: Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
  A `custom` service prefills its manifest path from the type's default on selection, and
  "Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
  the exact default within the service subtree/repo root; else, for a bare filename, one level
  deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
  only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
  durable `env-config-repair` run — to create the manifest at the entered path or fix it when
  invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
  columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0

## 0.66.0

### Minor Changes

- ab7e4c1: The SPA now consumes the `cat-factory k3s` guided-setup deep-link (guided-setup slice 4). On
  load, `?infraSetup=local-k3s&…` opens Infrastructure → Test environments with the Local k3s
  engine form **pre-filled** from the link's non-secret params (label, apiserver URL, namespace +
  ingress-host templates, skip-TLS), then strips the params from the URL (mirroring the `?invite=`
  handling). The ServiceAccount token is deliberately never in the link — the CLI prints it once for
  the user to paste before Test → Save. The Local k3s engine form also gains an **Auto-setup with the
  CLI** hint surfacing the `cat-factory k3s` command with a copy button. Completes the guided-setup
  initiative; the `docs/initiatives` tracker is superseded by ADR 0008.

## 0.65.0

### Minor Changes

- 70e321b: Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
  `LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

  A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
  mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
  `accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
  it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
  hand-rolled test copy.

  The local facade adds a `node:sqlite` machine-token cache and a local-only
  `POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
  captures the returned session from the redirect fragment, and hands it to its own node, which
  exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
  user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
  request (env override → unexpired cached token → none), so a token-less node boots inert and the
  SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
  mothership" affordance behind `localMode.mothership` (i18n across all locales).

  A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
  `127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
  back on the local node without an operator allowlisting every dev port (a redirect to the caller's
  own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
  the login screen instead of silently returning to the sign-in button, and each connect lets the
  mothership assign the node id (a reconnect as a different user never inherits the previous user's
  id).

  Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
  facades.

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0

## 0.64.0

### Minor Changes

- 77c6842: Broaden the provisioning auto-detector and make it monorepo-aware with user-selectable candidates.

  - **More layouts recognized.** Compose detection now covers override/env-variant names
    (`compose.override.*`, `docker-compose.override.*`, `docker-compose.{prod,dev}.*`) and files nested
    under `deploy/` / `docker/` / `.docker/` / `compose/`. Kubernetes detection adds common roots
    (`charts`, `chart`, `helm`, `kustomize`, `.kube`, `infra`, `infrastructure`, `infra/manifests`,
    `deploy/k8s`, `deploy/kubernetes`, `config/k8s`, `ops`, `gitops`, `.deploy`) and nested wrapper
    subdirs (`overlays`, `base`, `helm`, `charts`, `kustomize`).
  - **Monorepo-aware.** When scoped to a service subdirectory, the detector checks both the colocated
    service folder AND the repo's root shared-deploy dirs (`deploy/<svc>`, `k8s/<svc>`,
    `manifests/services/<svc>`, …), matching the service's slice by its directory basename. Unrelated
    slices are not surfaced when colocated manifests already win, and a name-matched slice with no
    confirmable manifests is only pre-selected when it actually matches the service name (never a
    fabricated pick at an arbitrary directory).
  - **Choose instead of silent auto-pick.** The recommendation now surfaces `serviceDirCandidates`
    (which root-shared monorepo slice), `manifestRootCandidates` (which k8s root when several resolve),
    and `composeServiceCandidates` (which compose service) alongside the existing overlay candidates, each
    rendered as a selectable chip in the service inspector's "Detect from repo" panel.

  The recommendation's new fields are optional; nothing is persisted by detection. The compose service key
  is advisory (surfaced as a candidate/note only) — it is not written onto the service provisioning.

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0

## 0.63.1

### Patch Changes

- 2e1354f: Improve the Kubernetes per-type engine configurator:

  - **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
    defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
    explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
    unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
    share the same loopback defaults, so they remain one preset rather than separate options.
  - **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
    "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
    the engine config to a backend config and reaches the apiserver with the supplied token (nothing
    persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.

- 33005e9: Prettier SPA startup screen: the early loading shell now shows an inline cat
  badge inside the spinner ring plus a "Cat Factory is starting…" message, and
  honors `prefers-reduced-motion`.
- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1

## 0.63.0

### Minor Changes

- b4c7e60: Provisioning auto-detection now prioritizes the option matching the user's selected
  provision-type tab.

  The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
  `docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
  The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
  Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
  falling back to the other kind when the preferred one isn't found. With no preference (or any
  non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
  unchanged unless a caller opts in.

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0

## 0.62.0

### Minor Changes

- f568a8c: Add a built-in "Manual review only" merge-threshold preset and reseeding for the
  merge-preset catalog (mirroring pipelines).

  - "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
    never auto-merges a task using it — every PR is routed to a human `merge_review`
    notification regardless of the assessment scores. The flag is editable on any preset via
    a toggle in the Merge thresholds settings.
  - Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
    monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
    SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
    new built-in appeared upstream, offering a one-click reseed
    (`POST /workspaces/:ws/merge-presets/:id/reseed`).

  Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
  (default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
  seeds the whole built-in catalog (Balanced + Manual review only), not just the default.

### Patch Changes

- 572da5b: Fix console error spam (and broken `<USelect>` rendering) in the Infrastructure settings window. The kubernetes scheme pickers (`KubernetesEngineForm`, `KubernetesEnvironmentForm`) and the sandbox judge-model picker used an empty-string option value as the "default" sentinel, which reka-ui's `SelectItem` forbids (it reserves `''` to clear the selection). Switch the sentinel to a non-empty `'default'` value; the request payload still omits the field for that value, so the wire shape is unchanged.
- Updated dependencies [f568a8c]
  - @cat-factory/contracts@0.69.0

## 0.61.0

### Minor Changes

- 41203db: Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
  config from a service's repo.

  A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
  `RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
  facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
  the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
  `generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
  defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
  helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
  rather than guessed. The user always confirms/edits — nothing is applied silently.

  - Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
    `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
  - `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
    workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
  - Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
    prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
    and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

  No migration (detection is pure repo introspection — nothing persisted).

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0

## 0.60.3

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0

## 0.60.2

### Patch Changes

- ccc4a71: Deflake the e2e live-run specs and surface flaky e2e shards as red.

  - Frontend: the board page now renders a hidden `data-testid="workspace-stream"` marker reflecting the real-time WebSocket's connected state. Behaviour-neutral (inert, hidden); it lets the e2e suite wait for a live channel before driving a run.
  - e2e: `openBoard` now waits for that marker before returning, so a run's first `in_progress`/`blocked` events can't be broadcast to a not-yet-subscribed browser and missed (the source of the intermittent 30s timeouts in `notifications`/`reset-run`).
  - CI/test-only: the Playwright config sets `failOnFlakyTests`, so a test that fails then passes on retry turns the `Test e2e` shard red instead of green. The job stays out of the aggregated `Test` gate's `needs`, so a flaky shard reports red without blocking the merge.

## 0.60.1

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1

## 0.60.0

### Minor Changes

- ecf4cc1: Per-service provision types (slice 5): the frontend for the what/where ÷ how split.

  - **Service provisioning section** (`ServiceTestConfig.vue`): the per-type source inputs a
    service owns (the "what/where"). Kubernetes now offers the manifest source (colocated path —
    browsable in-repo — or a separate repo + ref + path) and the renderer (raw / kustomize);
    custom pins a `manifestId` from the workspace catalog (+ an optional manifest path);
    docker-compose gains a "local development only" flag. Type switches merge onto the existing
    provisioning so each type's fields survive toggling.
  - **Infrastructure configurator** (`InfraHandlersConfigurator.vue` in the Infrastructure
    window's environments tab): one section per provision type (the "how"). Kubernetes has an
    engine picker (local-k3s / remote-kubernetes) revealing the new `KubernetesEngineForm` (the
    apiserver + URL-derivation engine connection, split from the service-owned manifest source);
    docker-compose is informational (runs on the runtime's local Docker); custom hosts the
    `CustomManifestTypeEditor` (the open catalog — read-only registered types + editable
    workspace ones) plus a `remote-custom` HTTP handler per custom type. In local mode each kube
    handler also offers a personal (this-machine) override written to the `/me/environment-handlers`
    endpoints.
  - **Run details**: `EnvironmentStatusPanel` now surfaces the resolved provision type + engine
    recorded on the environment handle. `runEnvironmentSchema` (`@cat-factory/contracts`) gains
    `provisionType`/`engine`, and `RunDispatcher.attachEnvironmentProjection` maps them from the
    handle onto the step's environment projection.
  - **Stores/API**: a new `composables/api/infraHandlers.ts` wraps the slice-4 handler-bundle,
    per-type register/rotate/remove, custom-type CRUD, and the per-user override endpoints; a new
    `stores/infraConfig.ts` owns the handler + custom-type state (loaded on demand, never from the
    snapshot). New `inspector.testConfig.*`, `settings.infrastructure.kubernetesEngine.*` /
    `customType.*` / `handler.*` / `engine.*`, and `environments.provisionType.*` / `engine.*`
    i18n keys across all 8 locales.

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0

## 0.59.2

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0

## 0.59.1

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0

## 0.59.0

### Minor Changes

- 15c5894: feat(auth): remote node mode — surface the unauthenticated state and support PAT sign-in.

  - A remote facade (node service / Worker) has no anonymous tier, so once the auth handshake
    resolves with no signed-in user the SPA now routes to the login screen — even when the
    backend reports auth "disabled" (a dev-open / unconfigured remote). Previously this dropped
    the user onto a board where every per-user action silently failed with no sign-in affordance.
    An unreachable backend still falls through to the board's own error UI.
  - Source-control PAT sign-in now works on the remote node facade: a user pastes their own
    GitHub/GitLab PAT and is resolved to the account it belongs to. A hosted PAT login is held
    to the SAME login/org/domain allowlist as GitHub OAuth (admit when the login, an org it
    belongs to, or its email domain is allowlisted; fail closed when none are configured). Local
    mode keeps its configured-token, allowlist-exempt flow. `GET /auth/config` advertises the
    available PAT providers and the login screen renders a PAT option alongside OAuth/password;
    when a remote deployment has no sign-in method at all the screen explains that instead of
    showing a blank card.
  - New `TESTING_NO_AUTH` escape hatch (test-only, refused in a production-like ENVIRONMENT):
    a stronger `AUTH_DEV_OPEN` that both leaves the API open AND advertises (via `GET
/auth/config`) that the SPA may render the board anonymously instead of gating to login. The
    e2e suite opts into it; `AUTH_DEV_OPEN` on its own keeps the SPA's login gate, since a
    dev-open remote still has no anonymous tier.

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0

## 0.58.5

### Patch Changes

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

- Updated dependencies [f383515]
  - @cat-factory/contracts@0.62.0

## 0.58.4

### Patch Changes

- 8e305c3: Workspace settings tabs no longer truncate or scroll. The tab strip now wraps onto a
  second row when the viewport is too narrow to fit every label, keeps each tab at its full
  content width (no more "Workspa…"/"Bud…" ellipsis), and drops the sliding indicator — which
  couldn't track wrapped rows — for a per-tab active underline, removing the stray vertical
  scrollbar.

## 0.58.3

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/contracts@0.61.0

## 0.58.2

### Patch Changes

- 337d94d: Per-service provision types (slice 2b — reshape `environment_connections` + handler-aware
  service). **Breaking:** `environment_connections` is rekeyed from a single per-workspace
  provider binding (`(workspace_id, provider_id)`, discriminated by `kind`) into a multi-row
  per-provision-type HANDLER table `(workspace_id, provision_type, manifest_id)` with
  `engine` / `backend_kind` / `accepts_manifest_id` columns and `handler_json` (was
  `manifest_json`); pre-reshape rows are dropped (BC is a non-goal). The kernel
  `EnvironmentConnectionRepository` port becomes a multi-row API (`listByWorkspace`,
  `getByWorkspaceAndType`, `upsert`, per-type `softDelete`), mirrored in the D1 + Drizzle repos
  and the cross-runtime conformance suite.

  `EnvironmentConnectionService` gains the final handler-aware API — `registerHandler` /
  `listHandlers` / `updateHandlerSecrets` / `unregisterHandler`, custom-manifest-type CRUD, and
  `resolveProviderForType`, which matches a service's declared provisioning to a workspace
  handler and **merges the service-owned `manifestSource` into the engine config** at resolve
  time (the what/where ÷ how split). `EnvironmentProvisioningService.provision` accepts the
  service's `provisioning` and resolves per-type (short-circuiting `infraless`). A new
  `provision_type_unhandled` conflict reason is added (wire vocabulary + SPA title).

  The existing single-connection HTTP surface (register/describe/test/connection endpoints) is
  preserved as a thin **compat bridge** over the new table, so the current infrastructure UI
  keeps working unchanged; the per-type HTTP endpoints + the frontend rebuild follow in later
  slices, as does the tester collapse (dropping `defaultTestEnvironment`).

- Updated dependencies [337d94d]
  - @cat-factory/contracts@0.60.0

## 0.58.1

### Patch Changes

- 77937c4: Show a loading spinner on first SPA load via Nuxt's `spaLoadingTemplate`, so the very
  first paint is a spinner on the dark board background instead of a blank white screen
  while the JS bundle parses and Vue mounts.
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0

## 0.58.0

### Minor Changes

- 843e5fd: Add Japanese (`ja`) and Turkish (`tr`) localizations.

  - New `ja` and `tr` locales registered in `nuxt.config.ts` (both left-to-right) plus matching
    `numberFormats`/`datetimeFormats` entries in `i18n.config.ts`, and full
    `i18n/locales/ja.json` + `i18n/locales/tr.json` catalogs mirroring `en.json`
    (machine-translated, flagged for native-speaker review). Placeholders, plural-pipe segment
    counts, and brand/technical tokens (e.g. `Kaizen`, GitHub, code/format examples) are
    preserved verbatim; the `@<key>` translator notes are source-only and omitted from the
    catalogs.
  - No mechanism changes were required beyond the locale registration: text direction already
    tracks the active locale via `useLocaleHead()` in `app.vue` (both new locales are LTR), CJK
    glyphs render through the existing system-font fallback, and `pluralRules` stay unchanged
    (the default two-form selector covers Japanese's no-plural and Turkish's singular-after-count
    cases; only the Slavic locales need a custom rule).

## 0.57.0

### Minor Changes

- 2ac148d: Add a Docker Compose ephemeral-environment backend (the Checkbox-style preview-env mechanic).

  `composeEnvironmentBackend(runtime)` (new in `@cat-factory/integrations`) is an
  `EnvironmentProvider` that stands the PR repo's own `docker-compose.yml` up on a local Docker
  daemon under a per-PR `COMPOSE_PROJECT_NAME`, publishes the configured web service's port to an
  ephemeral host port, returns `http://localhost:<port>` for the Tester/`deployer` flow, and tears
  the project down on TTL. It rides the contract's generic environment-backend manifest member (no
  new config variant, no migration): the flat config lives in the stored manifest's `providerConfig`,
  written by the descriptor-driven connect form.

  To make the per-PR isolation real, the repo compose file is read checkout-free and **rewritten
  into one project file** before `up`: every service's published host port is forced ephemeral (so
  two concurrent per-PR stacks can't collide on a pinned host port — an additive `-f` overlay can't
  strip the base's mapping), the probed service is guaranteed to publish its port, and references
  this checkout-free backend can't honor — `build:` contexts, host bind mounts, relative `env_file`s,
  and `privileged` services — are **refused up front** with a clear reason instead of silently
  mis-mounting. An **auto-teardown TTL** is collected on the connect form (`ttlMinutes`, default
  2h; `0` = never) so a forgotten preview env is swept off the host instead of leaking containers +
  volumes. `testConnection` now probes the daemon (`compose ls`), not just the CLI, and every daemon
  call is time-bounded so a wedged daemon can't hang a provision/status/teardown. Default project
  names are disambiguated by block id so two workspaces sharing a repo name + PR number can't
  collide, and `status` reads `ps -a` so a brief container recreate doesn't flip a healthy env to
  `failed`.

  The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
  docker CLI, on the Docker-family runtimes only (Apple `container`, the plain Node service, and the
  Cloudflare Worker have no host docker daemon, so they don't register it — the documented
  runtime-bound asymmetry). The infrastructure picker (`@cat-factory/app`) surfaces it on the "Where
  test environments run" axis with actionable "when to use this" guidance and a local-only caveat.

  v1 supports self-contained image-based compose stacks (a service that builds from source, or that
  needs host bind mounts / relative env files, needs a full checkout — a follow-up). No
  backwards-compat concerns: this is a net-new opt-in backend.

## 0.56.0

### Minor Changes

- 5fd0ffa: Refuse to start a pipeline that includes an agent relying on binary-artifact storage when the workspace's account has none configured.

  The requirement is modelled as a new `binary-storage` agent trait (carried today by the UI Tester, which uploads its screenshots), so the system is universal: a future artifact-producing agent just declares the trait instead of the engine hard-coding it. `ExecutionService` enforces it on start/retry/restart and throws a `binary_storage_unconfigured` conflict, which the SPA surfaces as an error prompt with a "Configure storage" jump to the content-storage settings.

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0

## 0.55.0

### Minor Changes

- a6bea62: Add Hebrew (`he`) localization with right-to-left (RTL) support.

  - New `he` locale registered in `nuxt.config.ts` (with `dir: 'rtl'`) plus Hebrew
    `numberFormats`/`datetimeFormats`, and a full `i18n/locales/he.json` catalog mirroring
    `en.json` (machine-translated, flagged for native-speaker review; ~2% of leaves are
    intentionally left as brand/technical tokens).
  - The document `<html dir>`/`lang` now track the active locale via `useLocaleHead()` in
    `app.vue`, so selecting Hebrew flips the UI to RTL.
  - Converted physical-direction Tailwind utilities to logical equivalents across the
    component tree (`ml-`→`ms-`, `pr-`→`pe-`, `left-`→`start-`, `border-l`→`border-s`,
    `text-left`→`text-start`, etc.) so layout mirrors automatically under RTL; the sidebar
    drawer slide and horizontal chevron/arrow icons get explicit `rtl:` handling.

## 0.54.4

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0

## 0.54.3

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1

## 0.54.2

### Patch Changes

- 7536092: Startup-time optimizations (no behavior change):

  - **Node server boot**: run `migrate()` and `pgBoss.start()` concurrently (they touch
    independent schemas) and start the pure-timer background sweepers after the HTTP
    listener binds, so the server accepts requests sooner. The local facade inherits this
    via the shared `start()`.
  - **SPA workspace init**: fetch the accounts list and workspace list concurrently instead
    of sequentially on first board load.
  - **SPA bundle**: code-split the occasional, store-gated `BlockFocusView`,
    `TaskSourceConnectModal`, `TaskImportModal`, and `RecurringPipelineModal` into their own
    chunks (mounted only while open), matching the existing async-panel pattern.

## 0.54.1

### Patch Changes

- 227260b: i18n phase 9: localize the remaining SPA surfaces — repo bootstrap modal, the
  Sandbox (experiments / prompts / fixtures), the prompt-fragment library
  (manager + board panel), the Kaizen screen + per-step grading, the recurrence
  editor, the ephemeral-environment + provisioning-logs panels, and the
  media comparator + screenshot lightbox. New keys under `bootstrap.*`,
  `sandbox.*`, `fragments.*`, `kaizen.*`, `recurring.*`, `environments.*`,
  `provisioning.*` and `media.*` in all five bundled locales (en/es/fr/pl/uk,
  3-form plurals for pl/uk).

## 0.54.0

### Minor Changes

- ad5d3e0: Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
  containers" and "Test environments" tabs each now show a single radio list of concrete
  destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
  description, instead of stacking a "where it runs" radio above a separate "runner/environment
  backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

  Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
  prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
  ServiceAccount token. To support it, the Kubernetes runner form gains the
  `insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
  local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
  the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
  apiserver validator already permits loopback hosts and self-signed TLS.

  Also moves the manifest editor's "currently stored secrets" indication next to the secret
  inputs so it's clear whether a value is already saved.

  BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
  `settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
  dropdown + collapsed-manifest disclosure are gone).

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0

## 0.53.0

### Minor Changes

- 4897078: Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
  custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
  provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
  `registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
  removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
  deployment-wide injection used to provide, and serves both single- and multi-tenant.

  - **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
    `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
    guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
    custom kind's connect config validates with no new variant. The workspace snapshot gains
    `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
    `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
  - **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
    `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
    `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
    registered kind before it is connected.
  - **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
    fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
    manifest-editor save is tagged with its slug.
  - A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
    anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
    remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0

## 0.52.0

### Minor Changes

- 915861c: Surface the Tester's in-container docker-compose dependency stand-up logs on the test report
  window.

  A `local`-infra Tester stands the service's dependencies up inside its container with
  `docker compose up --wait` before running. Until now that command's output was written only
  to the harness's own logs — so when the dependencies failed to come up (a port clash, an
  image pull-auth failure, a healthcheck timeout, a service that exits immediately) the run
  showed an opaque failure and the single highest-signal artifact for diagnosing it was
  unreachable from the UI. This was flagged as the natural follow-up to the container-lifecycle
  observability work (the orchestrator-side provisioning logs can't see it — the stand-up runs
  _inside_ the container).

  - **Harness.** `standUpInfra` now captures the `docker compose up` stdout+stderr (on success
    _and_ failure), redacts credentials (the shared `redact` now also scrubs credential-named
    `KEY=value` / `KEY: value` assignments — e.g. a dependency echoing `POSTGRES_PASSWORD=…` —
    which are neither a token shape nor a known value), tail-bounds it, and returns an
    `infraSetup` record
    (started / compose path / duration / logs / error) on the agent result.
  - **Propagation.** The record rides the existing `RunnerJobResult` → `AgentRunResult` path
    (forwarded verbatim by both transports) and the engine persists it on the Tester step as
    `step.test.infraSetup`, refreshed on each Tester round.
  - **UI.** The test report window's Infrastructure section now shows a "Dependency stand-up"
    panel — the outcome, the compose file, how long it took, the verbatim error on failure, and
    the captured stand-up logs behind a toggle.
  - **Parity.** The cross-runtime conformance suite asserts the record round-trips onto
    `step.test.infraSetup` identically on D1 and Postgres.

  Bumps the `@cat-factory/executor-harness` image to `1.26.0` (the harness `src/` changed) and
  the matching tag in `deploy/backend`.

### Patch Changes

- 1a8f98e: fix(app): always show the Infrastructure navbar menu and its backend selectors. The menu and the tabbed window were still gated on the old provider-connection probes (a registered runner-pool / environment connection) or local mode, so on a Worker or Node deployment with neither connection wired the Infrastructure entry disappeared entirely and the execution-backend selector was unreachable. Both now key off the deployment's `auth.infrastructure` capability descriptor (populated by every facade), so the execution + test-environment backend selectors always render; the optional runner-pool / environment connect forms still gate on their own availability probe.
- Updated dependencies [915861c]
  - @cat-factory/contracts@0.54.0

## 0.51.1

### Patch Changes

- 816914f: Persist dismissal of the unofficial-translation warning banner. Dismissing the banner now
  sticks across reloads (stored per-locale in localStorage) instead of reappearing on every
  page load; switching to a different non-English locale still shows it, since each catalog is
  an independently-translated context.

## 0.51.0

### Minor Changes

- 48a3df6: Surface the per-run container's live lifecycle in a container agent's details, and bring
  the API Tester window to parity with the Coder.

  Previously a container-backed step showed a "Spinning up container…" badge that simply
  **vanished** once the container was up, leaving a blank "working" state — you couldn't tell
  whether the agent was still preparing the checkout or already making model calls, and there
  was no way to see which container the run was on or whether it was up / errored / gone.

  - **Live phase.** The executor-harness now exposes its current lifecycle phase
    (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
    already drove the stuck-run breadcrumb. The engine threads it through
    (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
    is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
  - **Container identity + address.** The transport now attaches the container's id (the
    Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
    reachable URL (the local host URL) — so a run's details name WHERE it runs.
  - **Explicit lifecycle status.** Steps carry a `container` projection
    (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
    reclaimed), so the details say whether the container is spinning up, running, errored, or
    gone — instead of inferring it from a run-level failure.
  - **API Tester parity.** The Tester result window now reuses the same observability the
    Coder's step detail shows — the container lifecycle (status / phase / id / url), the
    ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
    test report, instead of the report alone. The Tester (and the human-test / visual-confirm
    gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
    the Coder, rather than jumping straight to "running".
  - **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
    projection everywhere (no dual-signal path): every container-backed step — including the
    gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
    drop the field; backwards compatibility is a non-goal.)

  Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
  `deploy/backend`).

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
  - @cat-factory/contracts@0.53.0

## 0.50.1

### Patch Changes

- cf80c25: Surface "Manage this board's fragment library" / "Manage account fragments" links in the
  best-practices fragment pickers on the service and task inspectors, so you can jump from
  attaching a fragment to authoring/editing the library. The picker button now always shows
  (even when every applicable fragment is already attached) so the management links stay
  reachable. Managing fragments is open to every member, not just account admins.

## 0.50.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0

## 0.49.2

### Patch Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0

## 0.49.1

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/contracts@0.50.1

## 0.49.0

### Minor Changes

- 40f687d: Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

  - **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
    container start the moment the container has exited (or a CLI call fails) instead of
    spinning for the full ready timeout, and the thrown error carries the real Docker
    stderr plus a tail of the container's own logs — so a broken daemon / failed image
    pull / crashing entrypoint shows the root cause in the step's failure card and the
    provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
    Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

  - **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
    detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
    `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
    readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
    failure — instead of polling the full 120s and then mis-tagging a deterministic failure
    (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
    120s hang. The recoverable timeout/terminated paths are also enriched with the latest
    pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

  - **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
    provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
    step failure: the errored environment (with the provider's verbatim `lastError`) is
    persisted and stamped onto the step, and the run records a new `environment`
    `AgentFailureKind` — instead of a green step with the error buried in its prose output.
    A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
    reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
    which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
    failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
    symmetric with the `dispatch` (container-failed-to-start) failure.

  **Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
  Pre-1.0, no migration — stale failure rows simply don't use the new kind.

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0

## 0.48.3

### Patch Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0

## 0.48.2

### Patch Changes

- fc324d2: Add Kubernetes support for executor containers via a universal "agent runner backend"
  abstraction.

  The self-hosted runner pool is generalized into a discriminated runner-backend
  connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
  `kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
  backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
  new table, service, controller, or integration window.

  The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
  per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
  subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
  apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
  fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
  both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
  existing runner-backend Integrations window via a backend-type selector.

  BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
  discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
  table gains a `kind` column (existing rows backfill to `manifest`). The
  `executor-harness` image is unchanged (no image/tag bump).

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0

## 0.48.1

### Patch Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0

## 0.48.0

### Minor Changes

- 704c99e: Fill the gaps in Linear support:

  - **Connection pagination**: the Linear task source now walks the `children` and
    `comments` GraphQL connection cursors, so an epic with more than one page of
    sub-issues imports its full child set (no longer silently capped at ~50) — matching
    the Jira provider's epic-children pagination.
  - **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
    endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
    UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
    UUID.
  - **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
    in addition to a personal API key. The OAuth app credentials (client id / secret /
    redirect URL) are configured **per account in the UI** (account Deployment settings,
    sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
    env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
    API-key path is offered. The exchanged access token is stored as the connection and
    used as a `Bearer` token across import, search, ticket filing and PR writeback.
  - **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
    resolves and surfaces that exact issue first (de-duped against the term hits), like the
    GitHub Issues source.

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0

## 0.47.11

### Patch Changes

- de480e1: Turn the "add a service from a GitHub repo" picker into a typeahead combobox:
  type to search repositories with a debounced, case-insensitive substring match
  over `owner/name` (matches any part of either). Replaces the separate filter
  input + dropdown. The min-length search gate only applies to large lists — a
  small set of repos (25 or fewer) stays fully browseable up-front without typing,
  and the combobox gets a clear-selection control.

## 0.47.10

### Patch Changes

- 7a527e9: Localize the agent-window surfaces (i18n phase 8).

  Migrated all user-facing copy in the ten dedicated agent result/decision windows to
  `@nuxtjs/i18n`: the requirements-review window, the clarity / brainstorm review loops,
  the consensus session view, the service-spec window, the follow-up companion, the
  human-test and visual-confirmation gates, the test-report window, and the block focus
  view. New keys under `requirements.*`, `clarity.*`, `consensus.*`, `brainstorm.*`,
  `spec.*`, `followUp.*`, `humanTest.*`, `testing.*`, `visualConfirm.*` and `focus.*` in
  all five bundled locales (en/es/fr/pl/uk), in full parity. Count readouts use plural
  forms (3-form for pl/uk), severity/status/category/strategy/outcome enums resolve via
  exhaustive `Record` maps of literal `t()` keys to keep the typed-key drift guard live,
  inline emphasis uses `<i18n-t>` slots, dates go through `d(...)` and percentages through
  `n(..., 'percent')`.

## 0.47.9

### Patch Changes

- a8cbb76: Fix `Failed to resolve component` console errors on the board page.

  Several components that live in subdirectories of `components/` were used by their bare basename in templates without an explicit import. Nuxt's path-prefixed auto-import registers them under a prefixed name (e.g. `LayoutTranslationWarningBanner`, `PipelineIterationCapPrompt`), so the bare tags never resolved. Added the missing explicit imports for `TranslationWarningBanner` (index.vue), `TaskEstimateBadge` (InspectorPanel.vue), and `IterationCapPrompt` (AgentStepDetail.vue, BrainstormWindow.vue, ClarityReviewWindow.vue, RequirementsReviewWindow.vue).

## 0.47.8

### Patch Changes

- 21f24ec: Localize the pipeline, palette, and gate surfaces (phase 7 of the app i18n migration).

  All user-facing copy in the `pipeline/**`, `palettes/**`, and `gates/**` components now
  resolves through `@nuxtjs/i18n` instead of hard-coded strings, under the new `pipeline.*`,
  `palette.*`, and `gates.*` namespaces:

  - The pipeline builder (`PipelineBuilder`): the slideover, agent palette + draft chain with
    the per-step companion/approval/consensus/follow-up toggle tooltips, estimate-gating
    thresholds, the consensus strategy picker + participants, the saved-pipeline library
    (archive/clone/edit, label filters), the add-agent modal, and every toast.
  - The pipeline-progress timeline (`PipelineProgress`): instance/step status labels,
    background review stages, subtask + follow-up readouts, restart controls, and the
    approval / decision prompts.
  - The pipeline-health advisory (`PipelineHealthModal`): the invalid / outdated sections and
    reseed / delete actions.
  - The agent palette (`AgentPalette`) and the shared iteration-cap prompt
    (`IterationCapPrompt`, its three default choice labels).
  - The gate result window (`GateResultView`): the CI / conflicts / human-review variants —
    subtitles, the rolled-up display status, failing-check list, approval progress, the
    request-a-fix box, the attempt timeline, and the sidebar state/budget/footer.

  New keys ship in all five bundled locales (en/es/fr/pl/uk). Count readouts use plurals with
  the correct forms (3-form one/few/many for pl/uk); the local status/state/strategy/outcome
  enum lookups resolve via exhaustive `Record` maps of literal `t(...)` keys so the
  typed-message-key drift guard stays live; the "agents complete" count uses an `<i18n-t>`
  slot for its bold figure; and timestamps go through the vue-i18n date formatter.
  `pipeline/AgentKindIcon.vue` carries no own strings (it resolves everything from the shared
  catalog, deferred to phase X), so it needs no migration.

## 0.47.7

### Patch Changes

- c2ec53b: Local mode: env-PAT sign-in that's remembered across restarts.

  Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
  GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
  paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
  became the operational clone/push token, which comes from env), so it was a dead-end. When
  neither PAT is configured, the login screen shows an informational notice (with scopes-preset
  token-creation links) instead of an empty form; email/password sign-in is unchanged.

  The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
  on a later load the SPA silently re-mints a session from the env PAT without showing the login
  screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
  so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
  server.

  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
  auto-generated per process). The per-process auto-generation was the original cause of "re-enter
  the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
  a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
  actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
  both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

  **Breaking (pre-1.0, no migration):**

  - the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
    `configured` + `setupUrls` remain.
  - local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
    in the environment (generate via `pnpm secrets`).

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1

## 0.47.6

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/contracts@0.45.0

## 0.47.5

### Patch Changes

- d33f1af: Localize the integration surfaces (phase 6 of the app i18n migration).

  All user-facing copy in the `github/**`, `slack/**`, `documents/**` and `tasks/**`
  components now resolves through `@nuxtjs/i18n` instead of hard-coded strings, under the
  `github.*`, `slack.*`, `documents.*` and `tasks.*` namespaces:

  - GitHub: the onboarding gate (`GitHubOnboarding`), the installation connect flow
    (`GitHubConnect`), the integration panel with repos/pulls/issues browsing
    (`GitHubPanel`), the add-service-from-repo modal (`AddServiceFromRepoModal`), and the
    repo tree browser (`RepoTreeBrowser`).
  - Slack: the routing/members panel (`SlackPanel`), including the routable
    notification-type labels and role options.
  - Documents: the context-document picker, import modal, source-connect modal, spawn
    preview, and the task context-docs list.
  - Tasks: the context-issue picker, task context-issues list, import modal, and the
    source-connect modal.

  New keys ship in all five bundled locales (en/es/fr/pl/uk), in full key parity. Count
  readouts use plurals with the correct forms (3-form one/few/many for pl/uk); statically
  known enum labels (PR/issue state, Slack notification types) resolve via literal `t(...)`
  keys so the typed-message-key drift guard stays live; and structural emphasis uses
  `<i18n-t>` slots rather than HTML in message bodies. A few icon-only buttons gained
  `aria-label`s in the process.

## 0.47.4

### Patch Changes

- 503dcef: Fix crash when opening "Add from selected repo" on the board: the open-watch ran
  its `immediate` callback (`resetSelection()`) during setup before the selection
  refs were initialized, throwing `Cannot access 'selectedDirectory' before
initialization`. The watch is now declared after the refs it touches.

## 0.47.3

### Patch Changes

- d4a3ca8: Merge the two Integrations-Hub infrastructure entries (self-hosted runner pool + ephemeral
  environment provider) into one tabbed **Infrastructure** window, and add a full in-app
  **manifest editor** so any manifest-driven provider (incl. a runner pool) can be registered,
  tested, and rotated entirely in-app instead of dead-ending on a "use the API" disclaimer.

  - One hub row ("Infrastructure", `i-lucide-server-cog`) showing a combined per-concern
    summary, opening a single modal with **Container agents** / **Test environments** tabs
    (each gated on its own availability probe). The local-mode delegation toggles move to the
    top of the window (cross-cutting), removing the old runner-pool ⇄ env cross-link hint.
  - New `ProviderManifestEditor.vue`: a JSON manifest editor + write-only secrets sub-form,
    validated client-side against the SAME Valibot wire contract the backend enforces
    (`RunnerPoolManifest` / `EnvironmentManifest`), seeded from the saved manifest or a static
    per-kind starter. Native (flat-form) providers are unchanged. The server stays
    authoritative (register re-validates).
  - Adds `data-testid`s on the tabs + editor for e2e coverage. Pure frontend; no backend or
    store changes (`register`/`test` already carry a raw `{ manifest, secrets }`).

## 0.47.2

### Patch Changes

- 6210599: Refresh the model catalog when a personal (individual-usage) subscription is connected or
  disconnected, so the AI-readiness surfaces react immediately.

  Connecting a personal subscription (Claude / GLM / Codex) in `PersonalSubscriptionSection`
  now calls `models.refresh(workspaceId)`, mirroring the direct-API-key flow. Previously the
  per-workspace catalog stayed stale, so the "No AI model configured" banner persisted even
  though the connected subscription already made its models usable.

  With the catalog refreshed, the existing reactive readiness signals do the rest:

  - The "No AI model configured" banner clears once a subscription makes a model usable.
  - If the workspace default preset still points at models the subscription doesn't cover,
    the default-preset-mismatch banner + dialog surface immediately, with the link to pick a
    different preset.

  Starting tasks with an incompatible preset was already blocked server-side
  (`providers_unconfigured`), which accounts for the initiator's personal subscriptions.

## 0.47.1

### Patch Changes

- a160c84: Localize the AI provider surfaces (phase 5 of the app i18n migration).

  All user-facing copy in the `providers/**` components now resolves through `@nuxtjs/i18n`
  instead of hard-coded strings, under the `providers.*` namespace:

  - The default-preset mismatch dialog (`AiPresetMismatchDialog`) and the AI-provider
    onboarding modal (`AiProviderOnboardingModal`, the keys/OpenRouter/local-runner routes).
  - The personal-credential password prompt (`PersonalCredentialModal`, the reason-keyed
    title + connect-vs-unlock bodies).
  - The direct/proxy provider API-keys section (`ApiKeysSection`, per-vendor labels + guided
    steps, scope/provider pickers, caching note, connected-key usage).
  - The pooled LLM-vendor credentials modal (`VendorCredentialsModal`, tabs, pool intro,
    per-vendor guided steps, connected-token usage).

  New keys ship in all five bundled locales (en/es/fr/pl/uk). The connected-key/token usage
  readouts use plurals with the correct forms (3-form one/few/many for pl/uk) and format the
  token count through the vue-i18n number formatter; per-vendor labels/steps resolve via
  literal `t(...)` keys so the typed-message-key drift guard stays live.

## 0.47.0

### Minor Changes

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

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- 503da24: Localize the settings panels (phase 4 of the app i18n migration).

  All user-facing copy in the workspace/account settings surface now resolves through
  `@nuxtjs/i18n` instead of hard-coded strings, under the `settings.*` namespace:

  - Model configuration presets editor and account settings tabs.
  - Provider connection panel (ephemeral-environment + runner-pool, local delegation),
    service fragment defaults, and the issue-tracker panel (filing / linking / writeback).
  - User secrets, merge-threshold presets, the observability connection + incident
    enrichment, and local-mode tuning (warm container pool + checkout reuse).
  - The OpenRouter catalog, the workspace settings (waiting / task-limit / observability
    / retention / Kaizen / budget), and the local model endpoints.

  314 new keys ship in all five bundled locales (en/es/fr/pl/uk). Plurals use the correct
  forms (3-form one/few/many for pl/uk) on the model-override, enabled-model, runner-model
  and connection counts; spend currency formats through the vue-i18n number formatter; and
  enum-keyed lookups (tracker vendor, invitation status, provider-config reason, task-limit
  mode) use exhaustive `Record` maps (the tier-2 drift guard).

- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/contracts@0.44.0

## 0.46.12

### Patch Changes

- b919df4: Localize the layout + auth components (phase 3 of the app i18n migration).

  All user-facing copy in the auth screens and the layout chrome now resolves through
  `@nuxtjs/i18n` instead of hard-coded strings:

  - **Auth** (`auth.*`): the login / signup / forgot-password screen, the
    reset-password screen, the auth gate loading state, and the user menu.
  - **Layout** (`layout.*`): the account-level deployment / fragment / team settings,
    the AI-providers / GitHub-PAT / provider-config / spend-warning banners, the board
    switcher, the command bar (command labels plus search keywords), the integrations
    hub (status, groups, per-item labels), the integration back-title, the
    notifications inbox (per-notification-type actions), and the personal-setup modal.
  - **SideBar** is now fully migrated: it switched off the global `$t` to the
    destructured `t`.

  New keys ship in all five bundled locales (en/es/fr/pl/uk). The connected-count in
  the personal-setup modal uses correct plural forms (3-form for pl/uk); the spend
  warning formats currency through the vue-i18n number formatter; and enum-keyed
  lookups (notification type, invitation status, provider-config reason) use exhaustive
  `Record` maps (the tier-2 drift guard).

## 0.46.11

### Patch Changes

- 4dd3ad6: Localize the inspector + step/observability panels (phase 2 of the app i18n migration).

  All user-facing copy in the panel surface now resolves through `@nuxtjs/i18n`
  instead of hard-coded strings:

  - **Inspector** (`inspector.*`): container/service summary, epic children, recurring
    schedule settings, service fragments, release-health config, test-infrastructure
    config, agent config, dependencies, estimate, the task execution pipeline list,
    run settings, and task structure.
  - **Step / result panels** (`panels.*`): the step-detail overlay (review/approve and
    conclusion-editing flows), decision modal, generic structured result view, test
    report, step metadata/run-meta cards, restart control, and the inspector panel
    chrome.
  - **Observability** (`observability.*`): the model-activity / provided-context panel,
    the per-call metrics bar, and the step metrics bar.

  New keys ship in all five bundled locales (en/es/fr/pl/uk) with correct plural forms
  (3-form for pl/uk) for call/error/warning/truncation/correction counts. Dates use
  the vue-i18n datetime formatter and percentages the number formatter; enum/status →
  key lookups use exhaustive `Record` maps (the tier-2 drift guard).

## 0.46.10

### Patch Changes

- f74f8dc: Localize the board surface (phase 1 of the app i18n migration).

  All user-facing copy in the board components — the canvas empty state and drop
  toasts, the toolbar (level-of-detail readout, spend indicator, decision/service
  controls), the add-task and recurring-pipeline modals, the service/module frames,
  task cards, epic nodes, the decision/approval badges, and the shared agent
  failure/stop controls — now resolves through `@nuxtjs/i18n` under the `board.*`
  namespace instead of hard-coded strings. New keys ship in all five bundled locales
  (en/es/fr/pl/uk), with correct plural forms for task/module counts and the
  attachment-link warning. Spend is now formatted via vue-i18n's number formatter.

## 0.46.9

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

## 0.46.8

### Patch Changes

- fb339db: Lower the personal-subscription password minimum from 8 to 6 characters.

  The personal password that gates the second encryption layer on individual-usage
  subscription credentials now requires at least 6 characters (was 8). Updated the
  `personalPasswordSchema` contract and the matching client-side guards/labels in the
  store and unlock UIs. The account login/reset password is unaffected.

- fb339db: Move the Personal Subscriptions settings copy into i18n.

  Every hardcoded label, hint, button, toast, renewal notice and vendor onboarding step in
  `PersonalSubscriptionSection.vue` now resolves through `@nuxtjs/i18n` under a new
  `personalSubscriptions` namespace, with full translations for all supported locales
  (en, es, fr, pl, uk). Literal token-format placeholders (the `sk-ant-…` / Codex `auth.json`
  examples) and brand names stay verbatim; the day-count renewal notice uses pluralized forms
  (3-form for Polish/Ukrainian).

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2

## 0.46.7

### Patch Changes

- 89f9ad5: Pre-bundle `fast-querystring` so the SPA doesn't throw at runtime.

  The app layer's HTTP client (`@toad-contracts/frontend-http-client`) imports the named
  `stringify` export from `fast-querystring`, a CommonJS module. In Vite dev it was served raw
  from `@fs`, where `cjs-module-lexer` can't detect the named export — `fast-querystring`
  reassigns its exports (`module.exports = x; module.exports.stringify = …`) — so any
  deployment extending this layer threw at runtime:

  `SyntaxError: … fast-querystring/lib/index.js does not provide an export named 'stringify'`.

  Force Vite to pre-bundle it via `optimizeDeps.include` so esbuild emits an ESM wrapper with
  proper CJS interop (`needsInterop`). The specifier is resolved from the consumer app's root,
  where under pnpm's strict layout only `@cat-factory/app` is hoisted, so it is anchored there
  using Vite's nested `a > b > c` syntax.

- 13693b9: Fix infinite recursion in the UI store's `resetHubReturn` (it called itself instead of clearing the `cameFromIntegrations` marker), which crashed with `Maximum call stack size exceeded` when opening hub-spawned panels (e.g. "configure environment provider").

## 0.46.6

### Patch Changes

- ab146e5: Suppress the real-time self-echo for board moves/reparents so dragging a task several
  times in quick succession is reliable. The SPA now tags every request with a stable
  per-tab connection id (`X-Connection-Id`) and the realtime WebSocket connect with the
  matching `?cid=`; the board `move`/`reparent` controllers forward it through
  `BoardService` to `boardChanged`, and both realtime hubs (the Cloudflare
  `WorkspaceEventsHub` Durable Object and the Node `NodeRealtimeHub`) skip delivering the
  coarse `board` event back to the connection that caused it. The originating client keeps
  its optimistic state plus its own authoritative REST response instead of refreshing off
  its own move (a mid-flight snapshot of which carried a stale position, snapping the block
  back). Other subscribers still receive the event and refresh.

## 0.46.5

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1

## 0.46.4

### Patch Changes

- 0ca66fa: Make the board canvas usable by touch (phase 3 of the mobile-friendly work). On a
  touch-capable surface the Vue Flow pane now pans with one finger and zooms with a pinch:
  `panOnDrag` is widened from the precise-pointer button list (`[0, 2]`) to `true` — the
  button-array form silently blocked single-finger panning because a touch `touchstart`
  carries no `event.button` — while pure-mouse desktops keep the left/right-drag (never
  middle) restriction. The switch is gated on `any-pointer: coarse` (so touchscreen laptops
  and 2-in-1s, whose primary pointer is the trackpad, also get finger-panning) and lives in a
  unit-tested pure helper. The pane gets `touch-action: none` and every custom
  drag/resize/connect affordance (task drag grip, service/module header + resize edges/corner,
  drag-to-connect handle) gets `touch-none`, so a gesture is owned by the board instead of
  being stolen mid-drag by the browser as a page scroll (which fires `pointercancel`). The
  minimap is removed altogether — a precise-pointer affordance that's too small to hit on
  touch and a width hog on narrow windows, it earned its keep on neither desktop nor mobile;
  the toolbar's zoom-out / zoom-in / fit-view controls are the camera navigation on every
  viewport.

## 0.46.3

### Patch Changes

- b799df6: Fix Slavic (pl/uk) pluralization and tidy the `en` catalog. Wire a CLDR one/few/many
  `pluralRules` selector for `pl`/`uk` in `i18n.config.ts` — vue-i18n's built-in pluralizer
  never selects the correct few/many form, so 3-form entries like `board.toolbar.decisionWord`
  rendered the wrong word for counts like 2-4. Also add ARB-style `@key` translator-context
  notes next to the genuinely ambiguous `en` keys (inert at runtime — never resolved via
  `t()`), and fix `nav.modelConfiguration` casing to match the sentence-case of the other nav
  labels.

## 0.46.2

### Patch Changes

- 2bfac8d: Make touch targets and overlays phone-friendly (phase 2 of the mobile-friendly work).
  On a coarse pointer (phones/tablets) the board's small drag/resize affordances grow to a
  comfortable tap size — the task drag grip, the service/module resize edges + corner, the
  drag-to-connect handle, and the frame-header action buttons (`xs` → `sm`) — driven by the
  `pointer: coarse` media query so precise-pointer (mouse) desktops are unaffected. The
  hand-rolled overlay windows (requirements/clarity/spec/consensus/brainstorm review windows
  plus the follow-up, test-report, visual-confirmation, gate, generic-structured and
  human-test result views), the Pipeline builder, and the full-screen Model Configuration and
  Agent Step Detail panels are now capped to the dynamic viewport (`dvh`) so their content and
  controls — including the Agent Step Detail review rail's bottom-sheet gate buttons — stay
  reachable above the mobile browser chrome instead of being clipped; the centred review
  windows use `max-h-[90dvh]` (so they can't overflow unreachably on very short viewports) and
  the Pipeline builder's three columns stack and scroll as one on compact viewports.

## 0.46.1

### Patch Changes

- 0527f37: Add a language switcher (sidebar) for the supported locales and persist the explicit
  choice across reloads (the app still defaults to English; no browser auto-detect). When
  a non-English locale is active, a slim top banner warns that the translation is
  unofficial and may be inaccurate, with a link to the cat-factory repository for reporting
  mistakes or opening fix PRs.

## 0.46.0

### Minor Changes

- c0337b0: Add Spanish (`es`), Polish (`pl`), Ukrainian (`uk`), and French (`fr`) locales to the
  i18n layer. Each ships a full translation of the base `en` message catalog under
  `i18n/locales/<locale>.json`, is registered in the `nuxt.config.ts` `i18n.locales`
  array, and gets matching `numberFormats`/`datetimeFormats` entries in `i18n.config.ts`.
  `en` remains the `defaultLocale` and `fallbackLocale`. A downstream deployment can still
  override any of these by dropping its own `i18n/locales/*.json` (the per-layer deep-merge).

## 0.45.3

### Patch Changes

- 5408cb3: Make the board shell responsive on phones (phase 1 of the mobile-friendly work). Below
  `lg` (1024px) the navbar collapses into an off-canvas drawer toggled by a hamburger, the
  inspector panel becomes a bottom sheet with its existing close button as the dismiss
  affordance, the board toolbar collapses its labels to icons so it never overflows, and the
  notifications popover is capped to the viewport width. Adds a shared `useViewport`
  composable (`isCompact`/`isTouch`) and a `mobileNavOpen` flag on the UI store.

## 0.45.2

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0

## 0.45.1

### Patch Changes

- 78a9daa: Add a `vue-i18n-extract` CI guard (`i18n:check`) that fails when an i18n key is used in
  code but missing from the catalog, and reports unused catalog keys as non-blocking
  warnings. Closes the planned tier-3 i18n drift guard.

## 0.45.0

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

## 0.44.0

### Minor Changes

- aeefe0a: Flesh out the tester-generated screenshot review UI — more robust, convenient, and
  powerful, with the common review actions made pleasant.

  - New reusable `ArtifactLightbox.vue` — a full-screen zoom/pan viewer over a SET of stored
    screenshots, with keyboard nav (Esc/←/→/+/-/0), wheel + double-click zoom, pointer pan,
    and per-image loading/error/retry states.
  - New reusable `ImageCompare.vue` — actual-vs-reference comparator with four modes:
    side-by-side, overlay (onion-skin opacity slider), swipe (draggable split), and a
    client-side canvas pixel-difference (degrades to overlay if the canvas is ever tainted).
  - New `useArtifactBlobs` composable — extracts the authed artifact-blob → object-URL
    caching (with in-flight dedupe + status tracking) out of the visual-confirm store so both
    review windows own and revoke their own blob cache on unmount.
  - `VisualConfirmationWindow` reworked to use the comparator + lightbox, drag-and-drop a
    reference straight onto a pair (view pre-filled) or pick by view via a datalist, and
    attach per-view findings that are composed into the Fixer's findings alongside a freeform
    box.
  - `TestReportWindow` now renders the UI tester's captured screenshots (previously hidden):
    thumbnails mapped under the matching scenario, an "ungrouped" gallery for the rest, and
    click-to-zoom via the shared lightbox.
  - New `useFocusTrap` composable — both review windows and the lightbox now move focus inside
    on open, trap Tab, and restore focus on close (the window hands the trap off to the lightbox
    while it's open, so nested surfaces don't fight over Tab).
  - Comparator robustness: overlay/swipe fit the actual within the reference box
    (`object-contain`) so a differing aspect ratio no longer stretches it; the diff render
    guards against stale async draws; drag-dropped references are restricted to the same
    PNG/JPEG the picker accepts; the "upload a reference for any view" picker now requires a
    view name (an empty one can't pair and was silently orphaned); and the blob cache revokes a
    fetch that resolves after the window unmounts instead of leaking it.

  Frontend-only; no backend/contract changes (the per-view findings compose into the existing
  `findings` string).

## 0.43.0

### Minor Changes

- 63e2177: Add Linear support as a document source and issue tracker. Linear Docs can be
  imported as task context (mirroring Notion/Confluence); Linear issues can be
  imported and linked to board blocks (mirroring Jira/GitHub Issues); the `tracker`
  pipeline step can file issues into Linear; and PR writeback comments on and
  resolves the linked Linear issue. Authentication is a per-workspace personal API
  key (sealed at rest), behind a shared GraphQL client shaped so OAuth can be added
  later. Adds one nullable `linear_team_id` column to `tracker_settings` (mirrored
  across D1 and Postgres) for the team new issues are filed under.

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0

## 0.42.1

### Patch Changes

- 5b3fe44: Add `run-stop`/`run-reset` test ids to the task inspector's run-lifecycle controls so the e2e suite can drive the cancel/reset flow.

## 0.42.0

### Minor Changes

- d1027ec: Add internationalization (i18n) foundation to the SPA via `@nuxtjs/i18n`. The Nuxt layer
  now ships a `i18n/` config + `en` locale catalog and resolves user-facing copy through
  vue-i18n message keys. Downstream deployments can override or add locales by dropping their
  own `i18n/locales/*.json` (per-layer deep-merge, consumer wins).

  Note for consumers: the published layer now depends on `@nuxtjs/i18n` (and pulls in
  vue-i18n), so a downstream `extends` of `@cat-factory/app` gains that dependency weight.

  Maintainability is guarded in two tiers. Typed message keys
  (`i18n.experimental.typedOptionsAndMessages`) make a statically written unknown `t()` key a
  `nuxt typecheck` failure. Because that cannot see a key assembled at runtime, enum→key
  lookups are additionally guarded by an exhaustive `Record<TheEnum, string>` keyed off the
  source-of-truth union — adding an enum value without a key fails the typecheck on the map.

  To make that source of truth reachable by the SPA, the `ConflictReason` wire vocabulary
  moves from `@cat-factory/kernel` to `@cat-factory/contracts` (kernel re-exports it, so
  backend imports are unchanged).

  First migrated surface: the pipeline-error toast (`usePipelineErrorToast`), which now
  resolves conflict titles from `errors.conflict.*` keys via an exhaustive `ConflictReason`
  map and shows raw backend prose only as an untranslated fallback. Most other components
  still hold inline strings — the sweep is incremental.

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1

## 0.41.0

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

- 32c653f: Harden + complete the Visual Confirmation gate / binary-artifact storage after review.

  - **Security (artifact serving):** the artifact upload + blob endpoints now pin the content
    type to a raster-image allow-list (`png`/`jpeg`/`webp`/`gif`, SVG/HTML rejected `415`) at the
    write boundary, and serve blobs with `X-Content-Type-Options: nosniff` + a clamped
    `Content-Type`/`Content-Disposition` — closing a stored-XSS vector where an attacker-controlled
    type could be served inline same-origin. Shared `imageArtifacts.ts` keeps the workspace upload
    and the in-container ingest paths consistent.
  - **Configurable artifact retention (new):** a per-workspace `artifactRetentionDays` setting
    (default 14, bounded 1–3650), editable in the workspace settings panel. A daily Cloudflare cron
    / hourly Node timer sweep prunes each workspace's screenshots + reference images past its window
    — BOTH the metadata rows and the bytes (`BinaryArtifactStore.pruneOlderThan`), so the store no
    longer grows unbounded. Mirrored D1 ⇄ Drizzle (migration `0018` / a generated Drizzle migration)
    and asserted by the cross-runtime binary-artifacts conformance suite.
  - **tester-ui ingest seam (backend half):** `ContainerAgentExecutor` injects an `artifactUpload`
    `{ url, token }` into the `tester-ui` job body, reusing the run's existing container session
    token + proxy base URL, and a new container-token-authed `POST ${proxyBaseUrl}/artifacts/ingest`
    route stores the bytes as a run-scoped `screenshot`. (The UI-tester image routing + harness env
    passthrough remain the deploy-time follow-up — see the handover doc.)
  - **Gate UX:** a `request-fix` that can't dispatch (no PR branch / no async executor) now surfaces
    a reason + records a failed round instead of silently re-parking; after a fix the gate flags that
    the shown screenshots predate it (recapture to refresh); the unused `headSha` placeholder is
    dropped; and the gate window revokes its cached screenshot object URLs on unmount.

### Patch Changes

- 32c653f: Third review pass on the Visual Confirmation gate / binary-artifact storage:

  - **Frontend build fix.** `VisualConfirmationWindow.vue` still referenced the `capturing`
    phase that round 2 removed from `visualConfirmStepStateSchema` (a TS2353 excess-property
    on `PHASE_LABEL` and a TS2367 no-overlap comparison in `working`), which broke
    `nuxt typecheck`. Dropped both.
  - **Reference re-upload now wins.** `VisualConfirmationController.gatherPairs` kept the
    OLDEST reference image per view (`?? ref.id`), so a human re-uploading a corrected
    reference for a view they already populated never saw it. References are now assigned
    last-writer (newest), matching the oldest-first `listByBlock` ordering.
  - **Upload buffering is now actually bounded.** The `Content-Length` precheck was
    bypassable by a chunked / header-less body, after which `formData()` buffered the whole
    request into memory before the per-file ceiling ran. Both upload routes (workspace +
    in-container ingest) now wrap the body in `hono/body-limit`, which counts bytes as the
    stream is read, so a missing/spoofed `Content-Length` can't buffer past the ceiling.
  - **Per-run screenshot cap holds under concurrency.** The container-ingest cap was a
    check-then-act race; concurrent ingests could each pass it before any row landed. A
    post-insert reconcile now rolls back (deletes) any insert that lands in the overflow
    tail, so the store is bounded to exactly the cap per run without dropping earlier shots.
  - **Removed the vestigial `headSha`** from `visualConfirmStepStateSchema` (and its
    `begin()` initializer) — it was always null and never read; round 1 claimed it was
    dropped but it wasn't.
  - **Reuse:** the harness ingest route now uses the exported `bearerToken` helper instead
    of a fourth private copy of the `Bearer` parser.

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
  - @cat-factory/contracts@0.40.0

## 0.40.0

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

## 0.39.0

### Minor Changes

- 6d829bb: Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
  reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
  and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

  Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
  migration and a Drizzle column), the snapshot ships the current catalog versions
  (`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
  built-in's canonical definition while preserving its labels/archive state.

  BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
  "update available" once until reseeded — intentional adoption of the now-versioned definitions.

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0

## 0.38.0

### Minor Changes

- 714b7c9: Add "forgot my password" self-service reset for password-based logins.

  A user can request a reset link by email (`POST /auth/forgot-password`) and set a new
  password via a one-time, expiring token (`POST /auth/reset-password`). Tokens are stored
  hashed (SHA-256), single-use, and mirror the invitation flow; the reset email is sent
  through a new deployment-level **system** email sender configured via
  `EMAIL_SYSTEM_PROVIDER` / `EMAIL_SYSTEM_FROM` / `EMAIL_SYSTEM_API_KEY` (when unset, the
  link is logged for local/dev). The request endpoint never reveals whether an email is
  registered.

  Schema addition (both runtimes): a new `password_reset_tokens` table (D1 migration
  `0017_password_reset_tokens.sql` ⇄ a Drizzle Postgres migration). No data migration is
  needed — the table starts empty.

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0

## 0.37.3

### Patch Changes

- 16eee33: Frontend performance pass on the real-time board hot path and initial bundle:

  - **Indexed block queries** — `useBlockQueries` now builds a single `parentId → children`
    (and `epicId → members`) index per `blocks` change, so per-frame queries (`tasksOf`,
    `modulesOf`, `childrenOf`, `allTasksUnder`, `epicMembers`) are O(1) lookups instead of
    full-array scans. A streamed single-block upsert no longer costs O(frames × N).
  - **Grouped gate lookups** — the execution store exposes `decisionsByBlock` /
    `approvalsByBlock` maps, and `BlockNode` resolves its badges via those instead of
    re-filtering the global open-decision/approval lists once per frame. `BlockNode` also
    computes its merged/PR task counts in a single pass.
  - **In-place board reconcile** — `board.hydrate` reuses the existing object for any
    unchanged block, so a coarse full-refresh doesn't hand every frame/task a new reference
    and re-render the whole board.
  - **Lazy panels** — the ~25 heavy, rarely-open settings/integration/provider/sandbox
    panels in the board page are now `defineAsyncComponent` + `v-if`-gated on their open
    flag, so they code-split out of the initial bundle and don't run setup/watchers while
    closed. Each such panel's load-on-open watcher (`watch(open|executionId, …)`) is now
    `{ immediate: true }` so it still fetches on first open — under `v-if` the panel mounts
    with its flag already true, so the `false→true` flip the watcher keyed on no longer
    fires within its lifetime.
  - **Per-workspace cache cleanup** — the requirements, clarity, brainstorm, consensus and
    GitHub stores gained a `reset()` that runs on a workspace switch, so a switched-to board
    no longer shows the previous workspace's stale reviews/sessions/repos.
  - Smaller cleanups: single-pass fixture/grade joins in the sandbox results table,
    `toRaw`-based manifest cloning, and dropped redundant `deep: true` settings watchers.

## 0.37.2

### Patch Changes

- efbd910: Fix the SPA error handling broken by the `@toad-contracts/*` migration.

  The contract client (`sendByApiContract`) reports a contract-declared non-2xx as a plain
  `{ statusCode, headers, body }` value (not an `Error`), with the `{ error: { code, message,
details } }` envelope under `body`. The old `$fetch` threw an ofetch `FetchError` with the
  body under `data` and was always an `Error`. Several handlers still read the old shape, so:

  - `parseCredentialError` returned `null` for every 428, so the personal-subscription
    password modal never opened and individual-usage runs (Claude/Codex/GLM) could not be
    started or retried.
  - `parseConflict` returned `null` for every 409, so run-control conflict toasts lost their
    tailored guidance (including the `providers_unconfigured` "Configure AI" jump).
  - `instanceof Error` message extraction across many catch blocks rendered `"[object Object]"`
    for declared 4xx/5xx, and the login/account/tracker-probe handlers dropped the server's
    message.

  `sendContract` now wraps a bare non-2xx into a real `ApiError` (an `Error` carrying
  `statusCode`, the parsed `body`, and the server's message), and a shared
  `apiErrorEnvelope` / `apiErrorStatus` reads the envelope from either client shape. The
  provisioning-logs query now validates through the contract schema so an invalid query
  returns the standard `{ code: 'validation' }` 400 like every other route. `@cat-factory/contracts`
  gains a `singleStringParam` helper that collapses the one-key path-param schemas the route
  files each re-declared (typing preserved).

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0

## 0.37.1

### Patch Changes

- 692ccb4: Extract two shared store patterns the SPA stores were hand-rolling.

  - `useUpsertList()` — a keyed list with find-by-key `upsert` / `remove` / `get` / `hydrate`,
    replacing the per-store `findIndex → replace-or-(un)shift` boilerplate. Adopted in the
    `notifications`, `documents`, and `tasks` stores.
  - `useSourceIntegration()` — the document-source / task-source integration lifecycle
    (`available` gate, `connections` list, `descriptorFor` / `connectionFor` / `isConnected`,
    and `probe()`), so both stores share one implementation. This also standardizes probe-error
    handling: the documents store now records _why_ a probe failed (`probeError`) like the tasks
    store already did, instead of swallowing it.

  Behaviour is unchanged for existing consumers; the helpers are additive and adopted
  store-by-store.

## 0.37.0

### Minor Changes

- 9bee900: Restructure the Integrations menu for usability. The hub is now purely
  workspace-scoped: per-user connections (personal GitHub token, local model
  runners, personal subscriptions) move into a new user-scoped **My setup** hub
  reached from the user menu (with a "Personal (only you)" fallback group in the
  hub when auth is disabled, so nothing becomes unreachable). The hub gains a
  search filter, an explicit per-row state ("Connected" / amber "Disabled" /
  muted "Not connected") with connected rows sorted first, a "Get started" cue
  recommending GitHub + a model provider on an empty workspace, and demotes the
  issue-tracker settings entry to a quiet footer link.
- a4ea607: Adopt `@toad-contracts/*` for end-to-end typed, validated API contracts.

  The HTTP boundary is now a single source of truth. Each route is defined once with
  `defineApiContract` in `@cat-factory/contracts` (`src/routes/*`) and consumed by both
  sides: the backend mounts it with `@toad-contracts/hono`'s `buildHonoRoute` (method,
  path and request validation derived from the contract; the handler's `c.req.valid(...)`
  inputs and `c.json(body, status)` return are type-checked against it), and the SPA calls
  it with `@toad-contracts/frontend-http-client`'s `sendByApiContract` over `wretch`
  (runtime-validating every response). The frontend wire-type mirror in
  `frontend/app/app/types/*` no longer hand-redefines shapes — it re-exports the inferred
  types from `@cat-factory/contracts`, so backend and frontend can't drift.

  Breaking / notable:

  - `@cat-factory/server` no longer exports `jsonBody`, and drops the
    `@hono/valibot-validator` dependency (request validation now comes from the contract
    via `buildHonoRoute`); request-validation failures still return the same
    `{ error: { code: 'validation', issues } }` 400 envelope, mapped centrally in
    `handleError`.
  - `updateBlockSchema` now accepts `responsibleProductUserId` (it was silently dropped on
    the wire despite the domain block carrying it and the mapper persisting it).
  - The runtime-internal endpoints that are not request/response JSON APIs (the WebSocket
    event stream, the LLM/web-search proxies, the GitHub webhook, the Slack OAuth callback)
    are intentionally left on plain Hono routing.
  - The wire-returned shapes that the kernel ports also describe (`ProvisionedRepo`,
    `AgentContextSnapshot`/`AgentContextFile`/`AgentContextFragment`) now have their single
    source of truth in `@cat-factory/contracts` valibot schemas; the `@cat-factory/kernel`
    ports re-export the inferred types, so the route contract and the port can't drift. The
    `/auth/config` `localMode` field is now a real schema (`localModeConfigSchema`) instead
    of `v.unknown()`, and `AppConfig.localMode` derives its type from it.

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0

## 0.36.0

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

## 0.35.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

## 0.34.0

### Minor Changes

- 7ec536b: Add account-tier prompt-fragment management to the unified **Account settings** panel.
  Account-level fragments (hand-authored, document-backed living fragments from
  Confluence/Notion/GitHub, and linked guideline repos) are now configurable for both personal and
  org accounts, as a new "Context fragments" tab alongside the existing team/access tab (members,
  roles, invitations, email sender, account API keys). The panel is reachable from the SideBar, the
  account dropdown and the command bar. The fragment-library UI was made scope-aware (the store is
  now an owner-keyed factory plus the active-board singleton) and the manager extracted into a
  reusable `FragmentLibraryManager` shared by the board modal and the account panel. The backend
  already served the account scope (`/accounts/:accountId/...`); this wires up the missing frontend.
  Workspace settings → "Service best practices" now cross-links to both libraries (the account link
  deep-links to the fragments tab).

## 0.33.0

### Minor Changes

- eb48652: Local-mode infrastructure delegation + native runner-adapter seam.

  Local mode now lets a workspace opt, independently, into delegating its container agents
  and/or its Tester ephemeral environments to an external service instead of running
  everything on the host container runtime. Two new per-workspace settings drive it
  (`delegateAgentsToRunnerPool`, `delegateTestEnvToProvider`, both default off), surfaced as
  toggles on the Ephemeral environments screen (local mode only) and enabled only once the
  respective provider — a self-hosted runner pool / an environment provider — is registered.

  - **Agents**: when delegated, container jobs dispatch to the workspace's registered runner
    pool instead of host Docker (a clean 409 at start, and the existing dispatch error, when
    delegated with no pool registered).
  - **Environments**: the toggle sets the local-mode default Tester environment — `local`
    (host Docker / DinD) by default, `ephemeral` (the provider) when on; per-service / per-task
    choices still win. An `ephemeral` run is refused at start when delegated with no provider
    connected.
  - **Native runner-adapter seam**: an injected `runnerPoolProvider` now drives the actual
    dispatch transport on both the Cloudflare and Node facades (falling back to the generic
    `HttpRunnerPoolProvider`), fully symmetric with `environmentProvider`. A wrapper can thus
    ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. Kargo) to
    serve both concerns with native code on every runtime.

  BREAKING (pre-1.0, internal): an un-pinned Tester task in local mode now defaults to the
  `local` (DinD) environment instead of `ephemeral`. New `workspace_settings` columns are
  added on both runtimes (D1 migration + Drizzle migration); local mode now defaults
  `ENVIRONMENTS_ENABLED=true` so the env module assembles for the opt-in.

- 518aff7: Surface account & team management in the UI

  The existing per-account management features (members + roles, email invitations, and the
  transactional email sender) are now reachable from a dedicated **Account settings** entry
  in the SideBar Configuration section (and the account switcher), instead of being buried in
  an org-only "Manage team…" dropdown item. On a personal account the panel prompts the user
  to create an organization, since members/roles/invitations are org-scoped.

  Email provider configuration no longer requires the `EMAIL_ENABLED` env var: the email
  module is available whenever an encryption key is set (`ENCRYPTION_KEY`, used to seal the
  per-account provider API key). **Breaking:** the `EMAIL_ENABLED` flag is removed — deployments
  that set it can drop it; email becomes available based on `ENCRYPTION_KEY` presence alone.

## 0.32.2

### Patch Changes

- baf6078: Remove the redundant Vue Flow `<Controls>` zoom widget from the bottom-left of the
  board. The floating top toolbar already provides zoom in/out and fit-view (plus the
  zoom percentage and semantic LOD label), so the bottom controls were a strict subset.
  Drops the now-unused `@vue-flow/controls` dependency and its CSS import.

## 0.32.1

### Patch Changes

- c72e7b0: Make the whole service-card header a drag handle. The stats line below the title row
  (`N/M implemented · modules · PR ready`) sat outside the drag handle, so a pointer-drag
  starting there fell through to the Vue Flow pane and panned the board instead of moving
  the service. The title row and the stats line are now wrapped in one `nopan` grab handle.

## 0.32.0

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

## 0.31.0

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

## 0.30.6

### Patch Changes

- 3f9cca9: Board: make hover-to-front for services authoritative over selection. Vue Flow
  elevates a selected node's z-index by +1000 by default, so a frame stayed pinned on
  top after a click and hovering another overlapping frame could never surface it. Turn
  off `elevate-nodes-on-select` so frame stacking is driven purely by hover/drag; the
  selection highlight remains the ring, not z-index.

## 0.30.5

### Patch Changes

- 3a304ce: Board: services are now freely draggable and overlap is managed by hover. The whole
  service header bar is the drag handle (previously only the title cluster moved the
  frame, which read as undraggable), with the action buttons opting out so they still
  click. Moving a service no longer shifts any other service: the render-time
  auto-displacement that pushed expanded frames apart is removed, so frames render at
  their stored position, can overlap freely, and the dragged one tracks the cursor 1:1.
  The frame under the pointer (the un-obscured one) is lifted above overlapping
  neighbours via its Vue Flow node z-index, and the dragged frame sits above everything,
  so overlapping services can always be reached and reordered.

## 0.30.4

### Patch Changes

- 60fea92: Board: fix task-card expansion picking the wrong card, and stop task titles from being
  cut off. The "centre-most task wins" expansion gate had regressed: ranking cards by
  their distance to the projected footprint scored every footprint the screen centre fell
  inside at 0 (a tall card bleeding its expanded extent down from above ties with the card
  whose band actually holds the centre), so the tie broke by document order and a stacked
  neighbour could expand instead of the card you were looking at. Ranking is now by centre
  ownership — the card whose band holds the centre wins, and a card you've scrolled into
  keeps its grant — extracted to a pure helper with unit tests so it can't silently
  regress again.

  Task titles now wrap to two lines instead of truncating to an unreadable stub (full text
  still on hover), and task cards are a little wider to give titles more room.

## 0.30.3

### Patch Changes

- 4d8439f: Add `data-testid` test hooks to more board surfaces so the `@cat-factory/e2e` Playwright
  suite can target stable selectors: the notifications inbox (bell, item + `data-notification-type`,
  act/dismiss), the add-task modal (modal, title, submit) + the frame "Add task" button, and the
  agent step-detail approval rail (overlay + "Approve & proceed"). Additive only — inert attributes,
  no behaviour change.

## 0.30.2

### Patch Changes

- b82304e: Remove per-model price overrides from the workspace budget. A workspace's budget is
  now just a currency + monthly limit overlaid on the built-in `DEFAULT_SPEND_PRICING`
  table; the `spendModelPrices` setting, its contracts/schemas, and the
  `workspace_settings.spend_model_prices` column (D1 + Postgres) are dropped. Also fixes
  the budget save in the UI throwing `spendMonthlyLimit.trim is not a function` when the
  number input emits a numeric value.

  **Breaking:** the `spend_model_prices` column is dropped on both runtimes with no
  migration of existing override data (pre-1.0); any stored overrides are discarded and
  budgets fall back to the built-in price table.

## 0.30.1

### Patch Changes

- df0d331: Fix a build-breaking Vue SFC error in 13 integration panels/modals: their
  `IntegrationBackTitle` `@back` handler was written as two statements across newlines
  (`open = false` ⏎ `ui.openIntegrations()`), which the Vue 3.5 / Vite SFC compiler rejects
  (`Unexpected token, expected ","`) — both `nuxt dev` and `nuxt build` failed. Replaced the
  duplicated inline handler with a shared `useIntegrationBack(open)` composable wired as a
  named `@back="back"` handler in each panel; no behaviour change.

  Also add `data-testid` / `data-status` test hooks to the board components (board canvas,
  task card, decision badge + decision modal) so the new `@cat-factory/e2e` Playwright suite
  can target stable selectors. Additive only.

## 0.30.0

### Minor Changes

- 765cc42: Capture the complete context provided to each container agent as observability, in an
  isolated telemetry store.

  - New `agent_context_snapshots` table records, per container-agent dispatch, the fully
    fragment-composed system + user prompts, the best-practice fragment bodies folded in,
    and the full content of the files injected into the container (`.cat-context/*`) — the
    gap the per-call LLM telemetry can't see (the agent reads those files via tools). The
    snapshot is a redacted allow-list projection of the dispatched job (never any token or
    credential-bearing URL). Recorded best-effort at dispatch by `ContainerAgentExecutor`
    via the new `AgentContextObservabilityService`, gated by the deployment prompt-recording
    switch (`LLM_RECORD_PROMPTS`) AND a new per-workspace `storeAgentContext` setting
    (on by default; a toggle in Workspace settings). Surfaced on demand via
    `GET /workspaces/:ws/executions/:executionId/agent-context` and a "Provided context"
    view in the observability panel.
  - Telemetry now lives in an isolated store, separate from the transactional domain
    (append-heavy/high-volume/short-retention write profile). `llm_call_metrics` and the new
    `agent_context_snapshots` table both move there: a dedicated `telemetry` Postgres schema
    on Node (same connection) and a separate, **required** `TELEMETRY_DB` D1 database on
    Cloudflare. Both ride the existing `LLM_CALL_METRICS_RETENTION_DAYS` retention window.

  BREAKING (pre-1.0, no migration provided): the Cloudflare Worker now requires a
  `TELEMETRY_DB` D1 binding (provision with `wrangler d1 create cat_factory_telemetry` and
  add the `[[d1_databases]]` entry pointing `migrations_dir` at
  `telemetry-migrations`). `llm_call_metrics` is dropped from the main D1 / `public` schema;
  existing rows are not migrated.

## 0.29.1

### Patch Changes

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

## 0.29.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

## 0.28.2

### Patch Changes

- 7337d33: Add a "Back to Integrations" control to every integration sub-panel opened from the
  Integrations hub. Picking a row used to close the hub and reveal that integration's own
  panel (GitHub, Slack, vendors, OpenRouter, local runners, document/task sources, the
  provider/observability connections, the tracker settings tab) with no way back: the only
  exit was the close button, which dropped you to the board. Each panel's modal header now
  renders a back arrow next to its title that closes the panel and reopens the hub.

  The control only shows when the panel was actually reached from the hub. A new
  `ui.cameFromIntegrations` flag is set by `ui.openFromIntegrations` (the hub's row handler)
  and cleared by every direct `open*` action, so panels opened from the command bar,
  sidebar, a banner or an inspector link don't grow a dead Back. The shared
  `IntegrationBackTitle` component renders the title + optional back arrow in the modal's
  `#title` slot.

## 0.28.1

### Patch Changes

- ed3a673: Requesting Requirement-Writer recommendations is now asynchronous, like every other
  requirements-review operation. The request returns at once with `pending` placeholder
  recommendations and the user is handed back to the board; the Writer runs per finding in
  the durable driver (signalled through the parked requirements gate, mirroring the
  incorporate flow), filling each placeholder (`pending` → `ready`) with live progress and
  raising a notification when the batch is ready. The review window shows "N / M ready" plus
  per-finding "generating…" placeholders, and the board's "Recommending…" badge is now driven
  by server state (a `pending` recommendation), so it survives closing the window. A finding's
  typed answers are flushed before the request and preserved across the async cycle, so the
  user's explicit answers are still there when they return to confirm recommendations.
  Re-requesting a single recommendation rides the same async path; rejecting one now reopens
  its source finding so it can be answered manually. No schema migration (recommendation
  status lives in the existing JSON column) and no prompt/image change.

## 0.28.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

## 0.27.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

## 0.26.7

### Patch Changes

- a62044d: Tag 409 conflicts with a distinct, machine-readable `reason` (kernel `ConflictReason`, surfaced under `error.details`) so the SPA can tell run-control conflicts apart. The "no configured provider" start refusal now shows an actionable toast naming the model(s) with a "Configure AI" jump (same remedy as the no-AI startup banner); the other run/bootstrap conflicts get worded toasts. The toast handling is centralised in the execution/agentRuns stores, so every start/restart/retry/merge surface (including the fire-and-forget board menus) gets it.

## 0.26.6

### Patch Changes

- ab4b9ab: fix: avoid DataCloneError when testing/saving an infrastructure provider connection

  `buildManifestPayload` cloned the manifest base with `structuredClone`, but the base is a
  Vue reactive proxy — `structuredClone` refuses proxies with a `DataCloneError`, so clicking
  **Test connection** (or Save) in the ephemeral-environment / runner-pool provider window
  threw immediately. Clone via a JSON round-trip instead, which unwraps the proxy and
  deep-clones the plain-JSON manifest.

## 0.26.5

### Patch Changes

- 3671fa2: Drop the "Imported issues" list from the task-import modal — it was irrelevant noise. The modal now focuses on searching/pasting an issue to create a task from it.

## 0.26.4

### Patch Changes

- a0d5efc: Fix dragging services / modules / tasks on the board: grabbing a frame's header (or a
  module/task handle, or a resize edge) panned the canvas instead of moving the block.
  Vue Flow pans the pane on a left-drag via d3-zoom's `mousedown`, and the custom drag
  handles only `stopPropagation` the `pointerdown` event, which can't suppress that
  separate `mousedown`. The handles now carry Vue Flow's `nopan` class (its sanctioned
  opt-out), so a left-drag from a handle drives the block move/resize while the rest of
  the frame still pans the canvas.

## 0.26.3

### Patch Changes

- 2aae8bc: Fix the OpenRouter key panel falsely reporting "connected" on a rejected key, and add Kimi K2.7 as a curated OpenRouter model.

  - The OpenRouter setup panel (`OpenRouterCatalogPanel`) used to fire its "OpenRouter key connected" success toast — and flip the panel into the connected state — _before_ probing OpenRouter, since the save endpoint stores keys without validating them. A wrong/expired key therefore showed a 401 "could not reach OpenRouter" toast **and** a "connected" status simultaneously. `connectKey` now probes OpenRouter with the freshly stored key first, only announces success when it's reachable, and rolls the key back on rejection so the form stays for a retry. (The Vendors & keys → Proxies screen shares the same store-only save codepath; it never showed the bug because it doesn't probe OpenRouter after saving.)
  - `kimi-k2.7` now carries an `openrouter` flavour (`moonshotai/kimi-k2.7-code`, 256K context per OpenRouter's catalog), so it routes through the OpenRouter gateway out of the box once an OpenRouter key is connected. It's added to the OpenRouter panel's "Enable recommended" slugs and the spend price table (billed at Moonshot's upstream rates).

## 0.26.2

### Patch Changes

- 319c3d4: Board: make zoom navigation predictable. Service frames are now always expanded to
  their task canvas at every zoom level, so the layout is fixed — panning never shifts
  it and zooming has no expand/collapse transition, which removes the snap-back where
  scrolling across one service or zooming in toward another would throw you onto a
  neighbour. Frames are spaced apart with compressed space (an expanded frame pushes its
  neighbours away by its growth) so they never overlap; the offset is render-only and
  stored positions are untouched.

  Task cards inside a service keep the older "centre-most wins" gating: when two expanded
  pipeline lists would overlap, the card closest to the screen centre expands and the
  other stays compact until you scroll it closer. The per-pan camera compensation, sticky
  frame grants, and the on-screen frame-expansion driver are gone.

## 0.26.1

### Patch Changes

- f4f954b: Drop an unnecessary empty-object fallback in a spread in `ProviderConnectionPanel`
  (`...(x ?? {})` → `...x`); spreading a falsy value is already a no-op, so this is a
  behaviour-neutral lint fix (oxlint `no-useless-fallback-in-spread`).

## 0.26.0

### Minor Changes

- ce81233: Surface optional/default config values and unconfigured-provider warnings for the
  ephemeral-environment and self-hosted runner-pool providers.

  - `ProviderConfigField` gains an optional `default`; a field that has one is optional
    (the connect form shows it blank with a "defaulted to …" hint and falls back to it).
  - `ProviderDescriptor` gains `missingRequired` (required-without-default keys not yet
    supplied — the loud-banner signal), an optional `manifestTemplate` scaffold, and the
    current `savedManifest` (non-secret) so the native connect form overlays edits onto the
    real stored manifest — preserving previously-saved `providerConfig` (incl. nested values
    the flat form doesn't render) instead of silently dropping it on a re-save.
  - A native `EnvironmentProvider` / `RunnerPoolProvider` may implement
    `describeManifestTemplate()` so the SPA renders a flat `describeConfig` connect form yet
    still persists a single full manifest (per `backend/docs/native-environment-adapter.md`).
  - Both connection services compute `missingRequired` server-side from the saved secret
    bundle + manifest `providerConfig` + manifest `baseUrl` (so a required `baseUrl` field,
    which is stored on the manifest rather than in providerConfig/secrets, can clear).
  - Frontend: a generic descriptor-driven connect panel for both providers (under
    Settings ▸ Integrations) and a loud `ProviderConfigBanner` that fires when a provider is
    wired for the instance but mandatory fields are missing.

## 0.25.0

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

## 0.24.0

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

## 0.23.1

### Patch Changes

- 1320905: Merge-policy dropdowns (add-task modal + task inspector) now show each preset's actual
  thresholds alongside its name — auto-merge ceilings (complexity / risk / impact) plus the
  CI-fix budget — so you can compare presets without opening the settings panel. The default
  option also surfaces the resolved default preset's thresholds.

## 0.23.0

### Minor Changes

- 54a2827: Creating a task from a GitHub/Jira issue now surfaces the issue's description.
  Previously only the title was prefilled and the issue body reached agents solely
  via the context link, so the add-task form's description was empty. The form now
  shows each linked issue's description in a read-only field above the editable one
  (relabelled "Additional notes" when an issue is linked) and folds that body into
  the new task's saved description, so the original description is visibly included
  and the user can add notes on top. A search-hit issue's body is fetched (imported)
  when the form opens so it can be previewed.

## 0.22.0

### Minor Changes

- 2c24da8: Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
  ephemeral environment and PARKS for a person to validate the change in the live URL before
  the run continues. From the dedicated window the human can confirm (tear the env down +
  advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
  re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
  conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
  back to a degraded manual mode (no live env, still parks for confirmation) when no
  ephemeral-environment provider is wired.

  New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

  Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
  "pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
  a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
  identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
  flow.

## 0.21.0

### Minor Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

## 0.20.0

### Minor Changes

- 1a1d1af: Make OpenRouter a first-class provider in the UI.

  - The "Models & providers" group now sits at the top of the Integrations hub, with **OpenRouter** as its lead item (showing a "Key connected" badge once a key exists), ahead of "Vendors & keys" and "My local runners".
  - The OpenRouter panel is now a self-contained one-stop setup: connect your OpenRouter key inline (no detour through Vendors & keys), the live catalog auto-refreshes the moment a key exists, and a one-click "Enable recommended" ticks the popular gateway models. Saving the enabled set refreshes the model picker immediately. The Vendors & keys → Proxies tab remains a valid secondary entry point for the key.

## 0.19.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

## 0.18.1

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

## 0.18.0

### Minor Changes

- aa06003: Service-level default test environment. A service frame now carries a
  `defaultTestEnvironment` (docker-compose **local** vs **ephemeral**) that a task is
  spawned with; each task can still override it per-task via its `tester.environment`
  agent config. The engine resolves the effective environment at run time (task pin →
  service default → built-in `ephemeral`) and materialises it onto the run context, so
  the Tester job body, the prompt and the start-time infra gate all agree. Set the
  default in the service inspector's Test infrastructure panel; the task inspector shows
  the inherited value and labels it "inherited from service" until overridden.

  The cloud-provider and instance-size controls are now explained as **hints for
  ephemeral-environment provisioning** and tucked into a collapsed-by-default section.

  Persisted on both runtimes (D1 migration `0009_default_test_environment` ⇄ Drizzle
  `default_test_environment` column); the cross-runtime conformance suite asserts the
  inheritance + per-task override on each.

### Patch Changes

- aa06003: Pipeline builder: widen the slideover and use a three-column layout (palette ·
  current pipeline · saved library) so each column gets its own full-height scroll
  instead of being crammed into two narrow columns. Much roomier on wide screens.

## 0.17.2

### Patch Changes

- bedb7d4: Board: gate zoom-driven service-frame expansion to on-screen, centre-most frames.
  Previously every frame expanded at once past the `close` zoom band, so a large
  off-centre service would snap out over the smaller one the user was focused on,
  and services that weren't on screen expanded too. A new frame-expansion driver
  (the frame-level analogue of the existing task-expansion gate) only opens frames
  that overlap the viewport, preferring the one nearest the screen centre when two
  expanded footprints would collide.

## 0.17.1

### Patch Changes

- 8786b8c: Fix the flashing pipeline on a task stacked above another when zoomed in.

  The board's expansion driver tested overlap with each card's live rect, which
  collapses the moment a card is denied. A top task directly above another would
  no longer overlap once collapsed, get re-granted, expand, overlap again, and get
  denied — flashing its pipeline every frame. The driver now caches each card's
  expanded height while it's granted and projects the footprint with it, so a
  denied card is still tested at its expanded extent and stays compact.

## 0.17.0

### Minor Changes

- 0ac64b8: Selecting an issue now opens the prefilled task form instead of creating the task immediately.

  In the "Create task from issue" modal, clicking an issue row selects it as the task source:
  it opens the add-task form with the title prefilled and the issue staged as linked context,
  so the user still confirms the pipeline and presets before the task is created. The issue
  itself is only linked (its body is not copied into the description). Viewing the issue on
  GitHub moved to a dedicated external-link button on each row, and long issue titles now
  truncate instead of overflowing under the status badge.

- 0ac64b8: Add a "Create task from issue" button on service frames, and scope issue search to
  the service's repo.

  A service frame header now carries a ticket button (shown when a tracker is offered)
  that opens the tracker-issue modal pinned to that service: the new task is created in
  that frame, and the issue search is scoped to the service's linked GitHub repository
  instead of the whole installation. The same repo scoping applies to the
  attach-an-issue-as-context picker in the add-task form.

  Within a scoped GitHub search:

  - a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
    issue and is offered first instead of being fuzzy-matched — but only within the
    searching workspace's own GitHub App installation, so a URL naming another account is
    never fetched across tenants;
  - a bare issue number (`11`) resolves against the service's repo and is offered first;
  - free-text hits are restricted to the service's repo (`repo:owner/name`).

  A service is always created from (or with) a repo, so a GitHub search scoped to a block
  now REQUIRES that link: if the service isn't linked to a repo the search is refused with
  a clear error rather than silently widening to the whole installation. The
  block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
  both runtime facades so the shared task-search controller can resolve the scope.

## 0.16.1

### Patch Changes

- a20ab54: Surface the need to configure an AI model provider in the SPA. AI only works out of the box
  on a Cloudflare deployment with Workers AI enabled; every other deployment must onboard a
  source (provider key, pooled/personal subscription, OpenRouter/LiteLLM proxy, Bedrock, or a
  local runner). Previously nothing told the user this — the model picker silently showed every
  model as unselectable and tasks failed deep in the run.

  Two new prompts, both driven by a `useAiReadiness` composable that reads the existing
  per-workspace catalog `available` flag and the workspace's model presets (no backend change):

  - **No usable AI source** → an auto-opening `AiProviderOnboardingModal` plus a persistent,
    dismissible `AiProvidersBanner`, explaining the situation and routing to each configuration
    panel (LLM vendors, OpenRouter, local runners; Bedrock/Workers AI noted as operator-level).
  - **Default model preset references unavailable models** → an `AiPresetMismatchDialog` (and the
    banner's secondary state) offering to edit/switch the preset or configure vendors, plus an
    inline warning in the task inspector's model-preset picker (`TaskRunSettings`).

  The per-workspace model catalog is now loaded on workspace-ready (it was lazily loaded per
  component) so the readiness signals are populated regardless of which picker mounts; both
  prompts clear themselves automatically once a usable source / valid preset exists.

## 0.16.0

### Minor Changes

- 5e8ed88: Fix attaching a context document during manual task creation.

  The "Add a task" form attaches context documents through a new inline search picker
  (`ContextDocumentPicker`) instead of opening a second modal on top of the form.
  Stacked page-level modals don't interact here, which is why the old "Import a page…"
  entry appeared to open something but nothing was clickable — the same latent bug that
  was fixed for context issues. The picker searches the connected source, lists
  already-imported documents, and accepts a pasted URL/ID, staging the choice so it
  imports + links once the task is created. This brings the Context documents section to
  parity with the Context issues picker.

## 0.15.0

### Minor Changes

- 38fac0f: Make creating a task from a tracker issue (GitHub Issues / Jira) discoverable, and
  fix attaching a context issue during manual task creation.

  - The import modal now searches the tracker by title (using the existing search
    endpoint), so you can find an issue and "Create task" from it directly — the new
    task is seeded from the issue's title/description and linked back for writeback,
    without having to know the issue key.
  - The "Add a task" form attaches context issues through a new inline search picker
    (`ContextIssuePicker`) instead of opening a second modal on top of the form.
    Stacked page-level modals didn't interact, which is why the old "Import an issue…"
    path appeared to open something but nothing was clickable. The picker searches,
    lists already-imported issues, and accepts a pasted URL/key, staging the choice so
    it links once the task is created.

## 0.14.0

### Minor Changes

- fde0437: Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
  also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
  workspace can both configure issue tracking in one place and see _why_ a source isn't
  working.

  **Panel (frontend).** One discoverable home that gathers what used to be scattered:

  - **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
    (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
    recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
  - **Linking sources** — the per-workspace on/off toggle for each task source, making
    explicit that filing and linking are independent.
  - **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
    standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

  **Live "Check setup" (backend, all runtimes).** A new
  `POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
  against the source and reads a slice of its issues API, returning a classified verdict —
  `ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
  `error` — with an actionable message. For GitHub Issues it escalates three probes
  (validate the App credentials → mint the installation token + list repos → read issues on a
  repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
  **Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
  from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
  error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
  migrated") instead of a blanket "install integration first".

  Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
  by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
  (integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
  controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
  Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
  then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
  from availability.

## 0.13.0

### Minor Changes

- 82d771e: Add a "View Requirements" button to a selected service in the inspector that opens a
  structured navigation window over the service's prescriptive spec tree (modules → feature
  groups → requirements + Given/When/Then acceptance criteria + domain rules). When the spec
  is present on the service repo's default branch, a toggle switches to the rendered Gherkin
  scenarios.

  A new read-only endpoint `GET /workspaces/:ws/blocks/:blockId/spec` reassembles the sharded
  `spec/` artifact off the repo default branch via the existing checkout-free `RepoFiles`
  resolver (`resolveRunRepoContext`), now surfaced on the `ServerContainer` and wired
  symmetrically on both runtime facades. It returns `{ present: false }` when GitHub is not
  connected or no spec exists yet, so the window shows an empty state rather than erroring.

### Patch Changes

- 82d771e: Pin the SPA to dark mode so Nuxt UI's own chrome matches the board. The app is a
  single dark-themed surface (neutral mapped to `slate`, everything hand-styled in
  slate), but color mode was unpinned and followed the visitor's system preference,
  so every Nuxt UI overlay and form control (modals, inputs, selects, dropdowns)
  rendered light/white with washed-out text. Color mode is now pinned to dark, and
  overlays (`UModal`/`USlideover`) get a shared layered dark palette via `app.config`
  (a deep slate-950 surface with slate-800 chrome) matching the agent-run-details
  reader.

## 0.12.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

## 0.11.0

### Minor Changes

- 084a699: Split provider credentials into horizontal tabs and give proxies their own section.
  OpenRouter and LiteLLM are intermediaries, not direct vendors, so they no longer sit
  under "Direct provider API keys" — they move to a dedicated "Proxies" tab. The vendor
  credentials modal now uses horizontal tabs (Workspace pool / Direct providers / Proxies /
  Personal subscriptions) instead of one long vertical scroll, and account settings expose
  both direct and proxy account keys.

## 0.10.0

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

- 4de2f5f: Declutter the left navbar: collapse every integration into a single "Integrations" hub.

  The per-integration buttons that used to be spread across the navbar (GitHub, Slack, the
  dynamic document/task sources + their import actions, Issue-tracker writeback, Post-release
  health/Datadog, Vendors & keys, My local runners, OpenRouter models) are gone from the rail.
  They are replaced by ONE **Integrations** button that opens a new `IntegrationsHub` modal —
  a grouped list (source control, communication, documents, task trackers, observability,
  model providers) of every external system the workspace can enable/link. Each row reuses the
  existing per-integration `ui.open*` panel handlers, so the integrations themselves are
  unchanged; a row shows its connected status and opening one dismisses the hub to reveal that
  integration's own panel. Sections gate on the same `available` probes the navbar used, so a
  backend-disabled system simply doesn't appear. The Configuration section keeps only true
  workspace settings (merge thresholds, workspace settings, default models, default service
  best practices).

- 4de2f5f: Declutter settings/navbar and make post-release health a pluggable observability integration.

  **Frontend**

  - Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
    and **Default service best practices** moved from standalone modals into tabs (their navbar/
    command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
  - Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
    (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
    unsupported `external` / `environment` block types.
  - The new-task form now shows **Context documents** and **Context issues** sections (inspector-
    style) **ungated** — the _Attach_ button is disabled with a tooltip until the relevant
    integration is connected. (`ContextPicker.vue` removed.)
  - Post-release health is no longer a Datadog-named window: the **connection** is an
    **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
    picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
    inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
    entry, disabled with a hint until a connection exists).

  **Backend — pluggable observability (Datadog = one adapter)**

  - The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
    per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
    provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - Persistence: the `datadog_connections` table is **dropped** and replaced by
    `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
    - a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
  - Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
    `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
  - Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
    `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
  - HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
  - Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
    (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
    `cat-factory:observability`.

  Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
  (it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
  and ship mirrored D1 + Drizzle migrations.

### Patch Changes

- 4de2f5f: Review fixes for the declutter/observability pass:

  - **Board no longer crashes on `external`/`environment` blocks.** Those types stay
    user-uncreatable, but the backend still emits them (the seeded third-party service and
    the environments integration), so they are restored to the frontend `BlockType` union +
    `BLOCK_TYPE_META` for display parity with the contracts `blockTypeSchema`. `blockTypeMeta()`
    adds a safe fallback so an unknown/legacy block type degrades instead of throwing on the board.
  - **Integrations hub gates the Observability row on availability.** The `releaseHealth` store
    now probes an `available` flag (mirroring the other integration stores); the hub hides the
    "Post-release health" entry when `OBSERVABILITY_ENABLED` is off, instead of showing a dead
    row that only 503s.
  - **De-duplicated release-health loads.** `ensureLoaded()` coalesces repeated hub opens /
    frame-inspector mounts so they reuse the resolved connection + configs rather than re-fetching
    the whole configs list on every service selection.
  - **Vendor-neutral gate message.** The post-release-health pipeline guard now says "Connect an
    observability provider" instead of the leftover "Connect Datadog".
  - **Validated credentials at the registry boundary.** `parseDatadogCredentials` validates the
    decrypted blob in the observability registry, so a drifted/corrupted row fails with a clear
    error instead of deep inside the Datadog client during a live probe.

## 0.9.1

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.

## 0.9.0

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

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

## 0.7.4

### Patch Changes

- d36a79e: Show the gate helper's working state on the board drill-down. The board task card's
  pipeline mini-view (`TaskPipelineMini`) rendered a polling gate's surfaced subtasks (e.g.
  the conflict resolver's "0/7" todos) but never the gate's companion node, so a gate
  actively working its `ci-fixer` / `conflict-resolver` (or the Tester's `fixer`) read as a
  frozen checklist. It now renders the same companion line the inspector and focus pipeline
  already show — a spinning "Conflict Resolver · Running" — via the shared `gateCompanionFor`
  helper.

## 0.7.3

### Patch Changes

- 6cbbf89: Unify the step-backed result windows (CI/conflicts gate, tester report) with the agent
  step detail. Extracted two shared embeddable pieces — `StepModelActivity` (the LLM
  model-activity rollup + "View all calls →" link) and `StepRunMeta` (run id, model,
  timing, step position, and the embedded observability rollup) — and wired them into the
  gate view, the tester report window, and the canonical `StepMetadataCard`. The gate and
  tester windows now show the run id, live duration, and embedded model-activity exactly
  like every other step instead of hand-rolling partial sidebars (the tester window had no
  run id or observability at all).

  Every step window now reaches observability the same way: `StepModelActivity` shows the
  "Model activity" header + "View all calls →" link for any step that belongs to a run, and
  renders the metrics bar only when the step itself recorded LLM calls. This drops the
  bespoke "Open observability" fallback button the gate view used to show (a gate's
  programmatic precheck records no per-step calls, so it always hit that fallback) — the
  "View all calls →" link is run-scoped and reaches the helper agents' calls just the same.

  Also raised the observability drill-down above the result windows (`z-[60]` vs the
  windows' `z-50`) so opening "View all calls →" from a gate/tester window no longer renders
  the panel behind the still-open window (the panel mounts once at app init, so on-demand
  windows that mount later were winning the equal-z-index stack).

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.

## 0.7.0

### Minor Changes

- fe53445: Add an existing GitHub repository to the board as a service, with no bootstrap
  run. A new "Add from existing repo" button (sidebar, Repositories section) opens
  a picker of repos the GitHub App can access — including ones the workspace
  doesn't track yet — plus a link to grant the App access to more repos. Importing
  links + syncs the repo into the workspace (if needed), creates a `ready` service
  frame titled after the repo, and links the repo projection to it so tasks dropped
  on the frame target that repo. Backed by `POST /workspaces/:ws/blocks/from-repo`
  (`BoardService.addServiceFromRepo` + `GitHubSyncService.linkRepo`).
- d94e75c: Agent step-detail overlay, with execution timing.

  Clicking any agent — in the inspector's pipeline list (`TaskExecution`) or the
  zoomed-in pipeline (`PipelineProgress`) — now opens a full-screen detail overlay
  for that step instead of expanding a cramped inline teaser. The overlay resolves
  the step live from the execution store and always shows its metadata: state,
  **execution duration** (counting up live while the step runs), started/finished
  timestamps, model, step position, the live subtask breakdown, applied standards,
  and any decision/approval. When the agent produced prose (architect, researcher,
  reviewer, …) the overlay also renders it as markdown (via `markdown-it`,
  `html: false` so raw HTML is escaped), split into **collapsible sections** at each
  heading with an **auto-generated table-of-contents sidebar**; clicking an entry
  expands and scrolls to its section, and the in-view section stays highlighted as
  you scroll.

  To support this, pipeline steps now track timing: `PipelineStep` gains
  `startedAt` / `finishedAt` (epoch ms), stamped by `ExecutionService` when a step
  transitions to `working` / `done`. Both are set-once so a Workflows replay or an
  approval-gate re-assertion preserves the agent's true execution window; an explicit
  "request changes" re-run clears them so the fresh attempt is timed from scratch.
  Steps persist as JSON, so no migration is required.

- 3d9a9d8: Requirements incorporation + re-review now run asynchronously instead of freezing the
  review window.

  Previously, clicking "Incorporate answers" fired two sequential LLM calls (fold the answers,
  then re-review) inside the HTTP request, locking the user in the modal until the round
  resolved. Now the request records the human's intent on the parked run, signals the durable
  driver, and returns at once with the review in a new transient `incorporating` status. The
  fold + re-review run in the same durable driver the rest of the pipeline uses (where the
  initial reviewer pass already runs), so the user goes straight back to the board. They are
  summoned again — via the existing `requirement_review` notification — only when the
  re-review raises new findings (`ready`) or hits the iteration cap (`exceeded`); a converged
  re-review (`incorporated`) just advances the pipeline with no interruption.

  - **Engine.** The `requirements-review` gate is now re-entrant: a parked gate carrying a
    `pendingIncorporation` marker re-evaluates on wake, runs `incorporate()` + `reReview()`,
    then advances or re-parks. New `ExecutionService.incorporateRequirements` validates the
    findings are settled, flags the review `incorporating`, and signals the driver. An
    off-path inspector review with no parked run still incorporates inline (there is no driver
    to offload to).
  - **Live event.** New optional `ExecutionEventPublisher.requirementReviewChanged` +
    `{ type: 'requirements' }` `WorkspaceEvent`, so an open window/inspector tracks the status
    transitions live (Cloudflare pushes via the DO hub; Node reconciles on poll, as today).
  - **API.** Incorporation moves to the block-scoped `POST
/blocks/:blockId/requirement-review/incorporate` (was the reviewId-scoped
    `/requirement-reviews/:reviewId/incorporate`) and returns the `incorporating` review
    rather than `{ review }`.
  - **Conformance.** A new cross-runtime assertion proves the async-incorporate route is
    mounted on every facade and refuses incorporation while a finding is unanswered.

  Breaking (pre-1.0, no migration): the new `incorporating` review status, the `requirements`
  event variant, the transient `pendingIncorporation` field on a pipeline step, and the moved
  incorporate endpoint are new wire shapes. Old clients and any in-flight review rows on the
  old endpoint shape simply break; stale state is acceptable per the no-backwards-compat
  policy.

- 979f89c: Board: spatial drill-down into a task's build steps and live subtasks.

  The semantic-zoom ladder gains two deeper bands beyond `close`. Keep zooming into
  an in-flight task and its full build-pipeline steps appear on the card (`steps`
  band); zoom one notch further and each step expands its live todo breakdown —
  done / in-progress / pending — the same way a zoomed-in bootstrap card reads
  (`subtasks` band). Max canvas zoom is raised to 3 to give the new bands room, and
  the toolbar's level indicator labels them ("Build steps" / "Subtasks"). The data
  already streamed per step; this surfaces it spatially instead of only in the
  inspector. The `far`/`mid`/`close` thresholds are unchanged.

- 3bc8c79: Capture the model's reasoning / "thinking" trace in LLM observability. A reasoning
  model (e.g. `@cf/moonshotai/kimi-k2.7-code`) can spend its whole output budget in a
  separate reasoning channel and return an empty completion — previously those output
  tokens were unaccounted for (`response_text` empty, no trace), which made an empty
  spec-writer/blueprint failure undiagnosable. The LLM proxy now records `reasoningText`
  alongside `responseText`: the Workers AI in-process path reads it from the AI SDK
  (`generateText`'s `reasoningText`), and the OpenAI-compatible buffered + streamed paths
  read `reasoning_content` / `reasoning`. Stored in the new `reasoning_text` column
  (`llm_call_metrics`, D1 migration `0002_llm_reasoning_text` ⇄ Drizzle), surfaced in the
  metrics export and the Observability panel, and used as the Langfuse trace output when
  the response text is empty.

  Breaking: the `llm_call_metrics` table gains a non-null `reasoning_text` column (old
  rows default to `''`).

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

- 0972696: Surface external context sources in the add-task popup, with search + a new GitHub
  repo-doc source.

  The task-creation popup gains a `ContextPicker`: pick a connected source
  (Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
  catalogue by title/content**, paste a page/issue URL, or pick something already
  imported — chosen items are imported and linked to the new task as agent context
  when it's created. Previously the popup could only tick already-imported items and
  there was no in-UI way to reach the catalogue.

  - **Search** is a new optional capability on the document/task source providers
    (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
    Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
    (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
    gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
    knows when to offer a search box.
  - **GitHub repo docs** are a new `github` document source: link a Markdown/text
    file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
    by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
    (no credentials of its own) and is wired only when the GitHub integration is on.

- e9b9356: Create board tasks directly from imported GitHub issues or Jira tickets.

  Previously an imported issue could only be attached to an _existing_ task block as
  agent context. The task-source integration now also materialises an issue as a
  brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
  (title `KEY: summary`, description = a source-reference line + the issue body)
  inside a chosen service frame or module via `BoardService.addTask`, then links the
  issue to the new task so every agent step still sees the full issue (description,
  comments, metadata) as context. The issue stays the source of truth — re-importing
  refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
  (`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
  task-source import modal gains a "create tasks in" container picker and a per-issue
  "Create task" action.

  The new task carries `createdBy` (the signed-in user, threaded through the widened
  `BoardWritePort.addTask`) for notification routing, the container is resolved in the
  request workspace so the workspace-scoped issue link always resolves at execution
  time, and creating a second task from an already-linked issue is refused (`409`)
  rather than silently re-pointing the single issue→block link. The shared
  cross-runtime conformance suite now asserts the whole create-task-from-issue flow
  (seeded over a deterministic task source) against BOTH the Cloudflare/D1 and the
  Node/Postgres facades.

  Also closes two cross-runtime parity gaps in the task-source layer so the feature
  works identically on both facades:

  - **GitHub issues as a task source now work on the Node runtime.** The
    runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
    `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
    shared `@cat-factory/integrations`, the Node facade wires it whenever a GitHub
    client is available (the App is configured) — mirroring the Worker's
    `config.github.enabled` gate — AND `github` was added to the Node facade's
    task-source allow-list (it had been omitted, so the provider could never register).
    Previously only the Worker offered GitHub issues.
  - **Jira search now works on the Node runtime.** The duplicated per-runtime
    `JiraProvider` was hoisted into the shared `@cat-factory/integrations` (it is a thin
    runtime-neutral `fetch` shell, like `GitHubIssuesProvider`), so both facades now
    compose the SAME class — including `search()`, which the legacy Node copy had
    silently dropped.

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

- 4cf51f8: Add a post-login GitHub onboarding gate. When the GitHub integration is enabled
  but the workspace has no App installation, the board is withheld behind a
  full-screen prompt to install the cat-factory GitHub App (account-level install
  via `github.com/apps/<slug>/installations/new` — the user grants all or a subset
  of repos), reusing the existing `GitHubConnect` discover-and-link surface. The
  page now probes the integration before mounting the board so an unconnected user
  can't slip past, with a "Sign out" escape hatch to switch accounts. Previously an
  unconnected user landed silently on a board they couldn't act on.
- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 57d70fa: Issue-tracker writeback: comment on a task's linked tracker issue when its PR
  opens, and comment + close the issue as resolved when the PR merges.

  Two independent toggles configured at the **workspace** level (on the existing
  tracker settings) and overridable **per task** in the inspector
  (`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
  The linked issue(s) come from the existing task projection (`linkedBlockId`), so
  writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
  is best-effort — a tracker outage never fails a run.

  GitHub issues close natively (`state_reason: completed`); Jira issues transition to
  the first status in their standard **Done** category (no manual status mapping). The
  new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
  wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
  `closeIssue` method.

  **Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
  `writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
  gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
  ⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
  unaffected.

- 48d2f0d: Redesign the left panel from draggable palettes into a navbar + command bar. The
  draggable block and pipeline palettes are gone; blocks and pipelines are now
  created through a ⌘K command bar (`CommandBar.vue`) and the existing task-card /
  inspector run affordances. The sidebar becomes navigation: a command-bar
  launcher, a Create section (build pipeline / add block), repository management,
  integration management (GitHub, document + task sources grouped under
  Integrations), a Workspace-context section linking the workspace-wide context
  fragment library, and a Configuration section.

  Configuration adds two new settings panels: **Merge thresholds**
  (`MergeThresholdsPanel.vue`, full CRUD over the merge-preset library) and
  **Default models** (`ModelDefaultsPanel.vue`), the per-agent-kind default model
  overrides for the workspace — hydrated from the snapshot's `modelDefaults` and
  edited via the new `modelDefaults` store against `GET|PUT
/workspaces/:ws/model-defaults`. Saved-pipeline management (list + delete) moved
  into the pipeline builder.

  Agent-kind icon rendering is consolidated into one safe path: a new
  `agentKindMeta()` accessor (total over palette archetypes, the engine "system"
  kinds — `ci`/`ci-fixer`/`merger`/`blueprints`/`conflicts` — and unknown/custom
  kinds) backs a reusable `AgentKindIcon.vue` used everywhere the pipeline builder
  lists steps. This fixes a crash where the saved-pipelines list indexed
  `AGENT_BY_KIND` for a system kind present in every seeded pipeline. The default-
  models panel also no longer mislabels a pinned-but-uncatalogued model as
  "Deployment default".

- 88b3170: Separate reusable libraries from deployment. The libraries now publish to npm
  (`main`/`exports` point at built `dist`, with `files` + `publishConfig`); the
  worker is no longer private and exposes its handler + Durable Object / Workflow
  classes for deployments to re-export, and ships its D1 migrations. The frontend
  SPA is now the `@cat-factory/app` Nuxt layer. Deployments live in `deploy/backend`
  and `deploy/frontend`; the runner image publishes to GHCR. Releases are managed
  with changesets.
- fe0b7f8: Live model-activity: push per-call LLM activity over the workspace event stream.

  The "Model activity" panel fetched once when it opened and never updated, so a running
  step's calls only appeared on a manual reopen — and when a durable driver was evicted
  mid-run the board badge (which rides the poll loop) froze too, making a stalled driver
  look identical to a wedged agent. But the proxy records every call the moment it
  returns, independent of the execution driver, so the data was live the whole time;
  only the read side was stale.

  The proxy now emits a compact `llmCall` event per model call, sourced where the metric
  is already recorded:

  - New `LlmCallActivity` contract + `llmCall` `WorkspaceEvent` variant — the per-call
    summary (id, run, agent kind, provider/model, tokens, finish reason, ok/status, the
    latency split) WITHOUT the prompt/response bodies, so the stream payload stays small.
  - `ExecutionEventPublisher` gains an optional `llmCallObserved`; the proxy mints the
    call id (so the live row and the persisted metric share it) and pushes through the
    same realtime publisher execution events use. `DurableObjectEventPublisher` fans it
    to the `WorkspaceEventsHub` on Cloudflare; `FanOutEventPublisher` forwards it; Node's
    no-op publisher leaves it inert until Node gains a real-time transport. The emit is
    best-effort and fires even when the persistence sink is off.
  - SPA: `useWorkspaceStream` folds the event into the observability store, so an open
    panel updates in real time and keeps updating during a driver eviction. Live-appended
    rows carry no bodies; the panel lazy-loads those (by id) from the persisted metrics
    endpoint when a row is expanded.

  Both runtimes' real Hono apps are covered by a proxy-emit integration test asserting
  the identical compact activity event (each over its own app), so the shared controller's
  emit can't silently work on one runtime and not the other. The Cloudflare-specific
  publish leg — `DurableObjectEventPublisher.llmCallObserved` fanning the event to a live
  socket as an `llmCall` `WorkspaceEvent` — has its own dedicated hub spec.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- db336b1: LLM observability for container-based agent execution.

  Every container agent talks to models only through the runtime-neutral LLM proxy, so
  that single chokepoint now records one rich metric per call — the full prompt and
  response, token usage, how close the call ran to its output-token limit (truncation),
  and the latency split between transport/proxy overhead and actual model execution —
  plus errors and warnings (non-2xx, in-process failures, spend-gate refusals,
  `finish_reason: length`/`content_filter`).

  - New `LlmCallMetricRepository` kernel port + `LlmObservabilityService`
    (orchestration), composed only when a metric repository is wired (default-off, so
    tests and unconfigured facades are unaffected). Persisted on both runtimes: a new
    D1 table (`llm_call_metrics`, migration 0026) and a Drizzle/Postgres table, kept in
    lock-step by a cross-runtime conformance repository-parity suite.
  - The proxy is instrumented across the buffered, streaming, and in-process (Workers
    AI) paths; recording is scheduled off the response path so it never adds latency.
  - The execution engine rolls the per-run, per-agent-kind aggregates onto each
    pipeline step (`step.metrics`) and ships them over the existing execution event, so
    the board shows tokens, an output-limit headroom bar, a transport-vs-execution split
    and error/warning badges live — on the step cards, the pipeline timeline and the
    step-detail overlay. A new drill-down panel (`GET …/executions/:id/llm-metrics`)
    lists every call with its full prompt + response, and an LLM-friendly JSON export
    (`…/llm-metrics/export`) bundles totals + per-agent insights + every call (with
    derived ratios) for handing a run straight to a model to analyse.
  - The full request/response bodies make the table heavy, so it is pruned aggressively
    by the retention cron — default 3 days (`LLM_CALL_METRICS_RETENTION_DAYS`).

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- f0a847d: Local mode can link GitHub repos with the PAT, lighting up the "Add from existing
  repo" board flow (previously the GitHub integration was App-only, so it returned 503
  and the button stayed hidden — repos could only be linked via the `linkRepo` CLI).

  With a `GITHUB_PAT` set, the local facade now serves the GitHub read/link endpoints
  through the PAT-backed client:

  - `config.github.enabled` is forced on in local mode when a PAT is present (the Node
    loader only enables it for a configured GitHub App).
  - A workspace's installation is auto-provisioned from the PAT on first read
    (`AutoProvisioningInstallationRepository`), so `GET /github/connection` reports
    connected with no connect flow. The synthetic installation id matches the `linkRepo`
    CLI's, so CLI- and UI-linked repos share one installation.
  - The repo picker lists repos via `/user/repos` (`PatGitHubClient.listInstallationRepos`),
    the PAT analogue of the App-only `/installation/repositories` (which 403s for a PAT).
  - The connection reports `workflows: write` granted (the local PAT carries `workflow`
    scope), suppressing the advisory "missing workflows permission" banner.

  `@cat-factory/node-server` gains a `githubInstallationRepository` option on
  `buildNodeContainer` (default unchanged) so the local facade can wrap the repository,
  and re-exports `DrizzleGitHubInstallationRepository`. This is a local-mode differentiator
  (like the Docker runner and PAT token source); the Cloudflare/Node-proper facades keep
  using the GitHub App.

  The "Add from existing repo" picker also gains a search/filter input (filter by
  owner/name, with a "showing X of Y" count), since a PAT or wide App install can expose
  hundreds of repos that overflowed the plain dropdown.

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

- 2cca821: Default models picker: show each model's list price alongside its name and context.

  The per-agent-kind model dropdown in the "Default models for agents" settings
  window previously labelled each option with only the model name, provider, and
  context window (e.g. `Qwen3 · DashScope · 32K`). It now also appends the model's
  informational list price — already resolved from spend pricing on the catalog —
  so you can weigh cost while picking (`Qwen3 · DashScope · 32K · 1.1/5.5 EUR per
Mtok`). Quota-based subscription models render their quota burn rate instead.
  Reuses the existing `costLabel` helper; no backend change (the catalog already
  carries `cost`).

- a691853: Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

  A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
  D1 migration `0044` ⇄ Drizzle), which lets it back **more than one** board service —
  each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
  modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
  `GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
  directory of the service you want — and add several (a subset of the repo's services).
  `PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

  The chosen subdirectory is **fed to the agents that build the service** when the repo is
  a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple frames can
  target one repo) and returns its `serviceDirectory`, which flows through the container
  job body into the harness. The implementation agents — **coder, mocker and ci-fixer**
  (everything routed through `runCodingAgent`) — run with their working directory set to
  that subtree and are told, in their AGENTS.md context, that they're in a monorepo and to
  scope their work (and build/test commands) to it. The cross-cutting agents keep operating
  at the repo root by design: the **conflict-resolver** and **merger** act on the whole
  merge / diff, and the **blueprint** and **requirements** agents write repo-root artifacts.
  Non-monorepo repos keep the historical whole-repo behaviour.

  Known limitation: the in-repo blueprint (`blueprints/`) and requirements (`requirements/`)
  artifacts are still written at the repo root, so two services backed by the same monorepo
  share — and would overwrite — those files. Per-service artifact paths are a follow-up.

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

- 70e8ef0: Frontend for in-org shared services.

  The board can now mount org services, shows which frames are shared, and lays them out
  per-board.

  - The workspace snapshot carries `mounts` (the services this board mounts, with the
    per-board frame layout) and `serviceCatalog` (the org's services it can mount from, each
    annotated with `mountCount`). `Service` gains a derived `mountCount`.
  - SPA: a `services` Pinia store (mounts + catalog + mount/unmount/updateLayout), hydrated from
    the snapshot; an **"Add service"** menu on the board toolbar that mounts an org service; a
    **"Shared"** badge on a frame mounted on more than one board; and a frame drag now writes
    the **per-board mount layout** (so moving a shared frame doesn't move it on other boards).

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

- b156b4b: Pipeline-builder + default-models UI polish.

  Pipeline builder: saved pipelines no longer render every agent-kind icon inline
  (which overflowed the narrow panel) — each is a collapsed row showing its name and
  step count that expands to the full ordered step list on click. Draft steps now
  truncate their label so the per-step controls (gate / reorder / remove) always stay
  reachable, and a "Configure models" button opens the default-models settings panel
  straight from the builder. The left-nav action buttons are unified on the
  primary-soft style of "Build a pipeline".

  Default-models panel: restyled from a light modal into the dark full-screen window
  used by the agent-output review overlay (readable regardless of the OS colour-mode
  preference), with a filter box that narrows every kind's model picker. A kind left
  on its deployment default now names the model that default actually resolves to
  ("Model · Provider (default)") instead of the opaque "Deployment default".

  To support that, the workspace snapshot now carries `deploymentModelDefaults` — the
  deployment's env-routing defaults as `provider:model` refs (`default` plus the
  per-kind `byKind` overrides) — derived in the shared workspace controller from
  `config.agents.routing`, so it is identical across the Worker and Node facades. A
  cross-runtime conformance assertion guards that both surface it.

- 7cf2a2d: Improve the pipeline builder experience:

  - **Grouped, collapsible agent palette** — archetypes are now organized into
    meaningful categories (Review & triage, Design & research, Implementation,
    Testing, Documentation, Gates & observability) that collapse/expand, with the
    collapsed state remembered across builder opens.
  - **Pipeline labels + archive/unarchive** — pipelines (built-in and custom) carry
    free-form labels and an archived flag for organizing the library: filter by
    label, hide archived behind a toggle, and archive without deleting. Exposed via
    a new `PATCH /workspaces/:ws/pipelines/:id/organize` endpoint (the only mutation
    a read-only built-in accepts). New `pipelines.labels` / `pipelines.archived`
    columns mirror across D1 and Drizzle/Postgres.
  - **Dependent companions are now gated toggles on their producer** — the three
    companions (reviewer→coder, architect-companion→architect, spec-companion→
    spec-writer) leave the free palette and are attached to their producer step in
    the builder. Each can be optionally **gated on the task estimate** (run only when
    complexity/risk/impact ≥ a threshold, OR across axes) via a new per-step
    `gating` array; a gated step is transparently skipped at runtime when the
    estimate falls below the bar. A pipeline with any enabled gating **requires a
    `task-estimator` earlier in the chain** or it refuses to save/start. Gating is
    additionally restricted to **companion steps** (skipping a producer would starve
    its downstream steps) and **requires at least one axis threshold** (an enabled gate
    with none would always skip); both are enforced by the shared `validatePipelineShape`
    at save, clone, and run start. A companion must now run **immediately after** an
    enabled producer it can review — `validatePipelineShape` enforces strict adjacency
    (over the enabled subset) on every facade, matching the builder, which surfaces
    companions as toggles attached to their producer. A pipeline that slips another step
    between a producer and its companion is rejected at save / clone / run start.

  **Breaking (pre-1.0, no migration):** the `Pipeline` wire shape gains optional
  `gating`, `labels`, and `archived` fields, and `PipelineStep` gains `gating` /
  `skipped`. The built-in pipelines are unchanged in behaviour.

- 2d66d34: Pipeline builder: clone pipelines, edit custom ones, and disable steps without
  removing them.

  - **Clone any pipeline** (built-in or custom) into a new, editable copy:
    `POST /workspaces/:ws/pipelines/:id/clone` (`PipelineService.clone`). The copy is
    never `builtin`, so this is how a read-only default template is "made editable".
    The builder shows a Clone action on every saved pipeline.
  - **Edit a custom pipeline in place**: `PATCH /workspaces/:ws/pipelines/:id`
    (`PipelineService.update`, new `PipelineRepository.update` on both stores). The
    builder loads a custom pipeline into the draft and saves changes back to the same id
    (preserving its catalog position). Built-in catalog pipelines are **read-only** —
    the API rejects both editing and deleting them (422) and the UI offers Clone
    instead (no edit/delete affordance on a built-in); pipelines now carry a `builtin`
    flag (true for the `seedPipelines()` catalog) to drive this.
  - **Disable a step without removing it**: a new per-step `enabled[]` array (parallel
    to `agentKinds`, like `gates`/`thresholds`). A step flagged `enabled[i] === false`
    is kept in the saved pipeline (and can be toggled back on) but skipped at run start —
    `ExecutionService` builds the run only from the enabled steps, reading gates/
    thresholds by each kind's original index so they stay aligned. A pipeline must keep
    at least one step enabled, and an enabled companion must still have an enabled
    producer to grade (disabling a producer while leaving its companion on is rejected).
    The builder adds an enable/disable toggle and dims disabled steps.

  Persistence: new `enabled` + `builtin` columns on the `pipelines` table, mirrored on
  both runtimes — folded into the squashed baselines (D1 `0001_init.sql` ⇄ the Drizzle
  schema + a regenerated migration) rather than a standalone migration. Cross-runtime
  conformance asserts a disabled step is skipped at run on every facade.

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

- f16ae62: Board cleanup, resizable service frames, and an explicit container start-up phase.

  - **No more sample services + no "reset to sample board".** New boards start
    empty: workspace creation no longer seeds the sample architecture blocks (the
    SPA passes `seed: false`), and the toolbar's "Reset board to sample" button (and
    the `workspace.reset()` action behind it) is gone. The built-in **pipeline
    catalog is still always provisioned** — it is product config, not sample data —
    so an empty board can still run pipelines. The `seed` flag (now sample _blocks_
    only, default true) remains for demo boards and the test fixtures.

  - **Resizable service frames (Miro-style).** A frame can be resized by dragging
    its right / bottom edges or the bottom-right corner. `Block` gains an optional
    `size` (`{ w, h }`); when set it is the user's dragged size, used as a floor over
    the frame's content extent so a frame grows but is never dragged smaller than its
    tasks/modules. The size is persisted (new `width`/`height` columns on `blocks` —
    D1 migration `0027`, Drizzle migration for Postgres) and updated via the existing
    `PATCH /blocks/:id` (which now accepts `size`).

  - **Explicit "Spinning up container…" phase.** Container-backed steps (`coder`,
    `mocker`, `playwright`, `blueprints`, `merger`, …) now surface an explicit
    cold-boot phase instead of a blank "working" state. `PipelineStep` gains
    `startingContainer`, set the moment the job is dispatched (the dispatch blocks
    until the per-run container is up and has accepted the job, so it covers the whole
    boot window) and cleared on the first successful poll, when the container is
    provably up. The board shows "Spinning up container…" during that window — an
    accurate signal that does not rely on the absence of subtasks. Steps persist as
    JSON, so this needs no migration.

- 36018cb: Restart a pipeline run from a chosen step.

  Both the run's step-detail overlay (`AgentStepDetail`) and each step on the pipeline
  timeline (`PipelineProgress`, a hover-revealed side button) now offer **"Restart from
  here"**: re-run the pipeline from that step onward — even on a finished run — resetting
  the chosen step plus every later step's iteration counters (companion attempts,
  gate/test attempts, eviction recoveries) and re-driving a fresh run. The steps
  BEFORE the chosen one are preserved verbatim, so their outputs (and resolved
  decisions) still reach the restarted step as its `priorOutputs` handoff context.

  Unlike retry (which resumes at the first FAILURE), restart rewinds to an arbitrary
  human-picked step, so it can re-run steps that already completed. A block's
  incorporated requirements are deliberately NOT touched — they live on the
  requirement-review record, not the run — so a restarted `spec-writer`/`coder`
  still receives the incorporated requirements document (or the base description when
  none was generated). Restarting AT the `requirements-review` gate itself re-runs the
  reviewer, which mints a fresh iteration-1 review (its `review()` replaces the prior
  one) — exactly the "reset the iterations counter from this step" semantics.

  Backed by `POST /workspaces/:ws/executions/:executionId/restart` (`{ fromStepIndex }`,
  `restartFromStepSchema`) → `ExecutionService.restartFromStep`, which tears down any
  still-live driver/container for the run it replaces (so restarting a RUNNING run
  never orphans a container or a parked Workflows/pg-boss driver), then mints a new run
  id and re-drives like a retry. Like start/retry, an individual-usage (Claude/GLM/
  Codex) block needs the initiator's personal password (prompted, then retried, on a
  428). Runtime-neutral (shared `@cat-factory/server` + orchestration), so both facades
  get it; a cross-runtime conformance assertion pins the restart + the requirements
  handoff on every runtime.

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

- 7157fd7: Rework run timing, add task types, and add a per-service running-task limit.

  **Run timing.** A run parked waiting for a human is no longer auto-failed after a
  fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
  (the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
  drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
  removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
  open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
  waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
  park now also guarantees an open notification, so a waiting run is never silently
  stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

  **Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
  `recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
  repro, a spike's time-box). `recurring` is created through the existing recurring-
  pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

  **Per-service running-task limit.** A new per-workspace settings object
  (`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
  concurrently under one service — off, a single shared bucket, or one bucket per task
  type. Starting a task over the limit is refused with a human-readable 409. Managed via
  `GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
  new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
  conformance assertions for the task type round-trip and the limit enforcement.

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

- 0b38aa6: Service selection/deletion UX: browse the repo for the docker-compose path, configure
  a new service inline, send the monorepo flag with the add request, and delete blocks
  optimistically.

  - **docker-compose path picker**: the service inspector's docker-compose field now has a
    "browse" button that opens the GitHub repo tree (the same navigator used for the monorepo
    directory picker, extracted into a reusable `RepoTreeBrowser`) so you pick the compose
    file directly instead of typing it. The path is stored relative to the repo root (the
    Tester runs `docker compose -f <path>` from the clone root), starting the browse inside
    the service's subdirectory for a monorepo service.
  - **Configure a service while adding it**: after adding a service from a repo, the modal now
    shows the same configuration controls as the inspector (test infra + compose path +
    provider/size, and best-practice fragments) bound to the just-created service.
  - **Monorepo flag travels with the add request**: flipping the "this is a monorepo" toggle
    is now modal-local and sent as part of `POST /blocks/from-repo` (`isMonorepo`) instead of
    persisting a separate up-front `PATCH`. The backend persists the flag when the service is
    added. The now-unused frontend `setMonorepo` action + API method are removed (the backend
    PATCH endpoint stays).
  - **Optimistic deletion**: deleting a task, module, service, or recurring pipeline hides it
    immediately and only reappears — with an error toast — if the backend rejects the delete.

- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- 2dd7e56: Step observability + a discoverable iteration-cap decision.

  - Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
    the step-detail panel (copyable) so a lone step in a log line or view names its run.
    It is a read-time projection (always equals the enclosing run's id), stamped on read
    and on emit; not persisted independently.
  - A step's duration now stops counting once it is terminal OR parked on a human. The
    engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
    gate and clears it when the step resumes or finishes, so elapsed time no longer
    accrues while the run waits for input (the symmetric counterpart of the terminal
    freeze). A step finished directly out of a parked approval is billed to the pause
    instant, not the later human decision.
  - An iterative gate that spends its automatic budget (a quality companion at its rework
    cap, or the requirements reviewer at its iteration cap) now raises a
    `decision_required` notification. Previously the three-choice decision was reachable
    only by drilling into the parked step, so the run looked silently stuck; the inbox
    item now opens that step's decision surface (companion → step detail with the
    iteration-cap prompt; requirements → the review window).

  No DB migration: the step fields ride in the existing execution `detail` JSON, and the
  notification `type` column is free text in both runtimes.

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

- d0697d1: Surface CI and conflict gate conclusions in the run-detail UI through one universal gate
  window.

  The polling gates (`ci`, `conflicts`) already tracked phase/attempts/headSha on
  `step.gate`, but the frontend type didn't even declare the field, so none of it rendered —
  and the gates' actual conclusion (which CI checks failed, whether the PR conflicts) was
  computed in `evaluateGate` only to be handed to the helper agent and then discarded. A
  user opening a CI or Conflicts step saw a generic prose panel with nothing about why the
  gate was looping.

  Backend: `gateStepStateSchema` now persists the precheck outcome — `lastVerdict`,
  `lastFailureSummary`, and (CI only) the structured `failingChecks` list — written on every
  probe in `evaluateGate` and preserved across the helper dispatch. Gate state lives in the
  execution `steps` JSON, so both runtimes pick this up with no migration. (The conflicts
  gate carries no structured detail because GitHub reports mergeability as a single verdict,
  not a file list.)

  Frontend: a single `GateResultView` window, registered on the shared `resultView` seam for
  both the `ci` and `conflicts` kinds, shows the verdict, the helper attempt budget, the
  gated commit, and — for CI — the failing checks. The two board views (`TaskExecution`,
  `PipelineProgress`) now also render each gate's helper (`ci-fixer` / `conflict-resolver`)
  as a possible/running/completed/skipped sub-node, the same treatment the Tester's fixer
  already had.

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

- 3841315: Tasks are now authored by the user instead of being auto-generated. Removed the
  random `TASK_NAME_BANK` placeholder titles: "Add task" opens a modal where the
  user enters the task's title and description. A new task is created in `planned`
  state and is never launched implicitly — the user starts a pipeline on it
  explicitly, and can keep editing its title and description (in the inspector)
  until it has started, after which those details are locked. `addTask` now
  requires a `title` and accepts an optional `description`.
- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 1b37890: Explain what each agent does on hover. Hovering an agent step now surfaces its
  catalog description as a tooltip everywhere a step is rendered — the pipeline
  builder palette + assembled draft chain, the board task card's build-step rows
  (`TaskPipelineMini`), and the "Default models for agents" window. The shared
  `AgentKindIcon` carries the tooltip (label + description) so any current/future
  renderer that goes through it gets the explanation for free. All default agents
  (palette archetypes + engine system kinds) already carry a populated
  `description` in the frontend catalog.
- db77061: Refuse to pool individual-use-only subscriptions on a workspace.

  Some subscriptions are licensed for individual use only, so a single credential may not
  be shared across a workspace (any member's run leasing it). `SUBSCRIPTION_VENDORS` now
  carries an `individualOnly` flag, set — from each vendor's own terms of service — for
  `claude` (Anthropic consumer Pro/Max), `glm` (Z.ai's GLM Coding Plan is "licensed only
  to the individual natural person") and `codex` (a ChatGPT `auth.json` is a per-seat
  credential, sharing prohibited at every tier). The genuinely org-permitted coding-plan
  vendors `kimi` (Moonshot explicitly permits authorized enterprise use) and `deepseek` (a
  commercial API platform) stay poolable.

  `ProviderSubscriptionService` enforces it account-agnostically: `addToken`/`leaseToken`
  throw a `ConflictError` (HTTP 409) for any `individualOnly` vendor, and `hasToken` always
  reports it unavailable so the executor's "subscriptions always win" routing never
  auto-selects a vendor a lease would reject. The rule is asserted in the cross-runtime
  conformance suite against an org-owned workspace, and the LLM Vendors UI offers only the
  poolable vendors (the individual-use ones are connected per-user in the Personal
  subscriptions section). Organizations needing shared, programmatic access use a direct
  provider API key instead, which is unaffected by the flag.

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

- ad9ba9e: Quality companions (Spec Reviewer, coder's Reviewer, Architect Companion) no longer
  get stuck when they spend their automatic rework budget — they park for a human, the
  same way the requirements reviewer does at its iteration cap.

  Previously a companion that stayed below its quality bar after `maxAttempts` automatic
  reworks failed the run (`companion_rejected`), leaving the task stuck with no path
  forward. Now it parks on a shared iteration-cap gate offering the same three choices as
  the requirements reviewer:

  - extra-round — raise the budget by one and loop the producer back for one more pass;
  - proceed — advance the pipeline accepting the producer's current output;
  - stop-reset — cancel the run and return the task to phase zero (editable), the
    producer's latest output preserved on its branch.

  The two gates now share one mechanism rather than duplicating it: the choice contract
  (`iterationCapChoiceSchema` / `resolveIterationCapSchema`), the parking
  (`parkStepOnDecision`), the gate-resume advance (`advancePastResolvedGate`, also used by
  the generic approval gate), the three-way dispatch (`dispatchIterationCap`, where
  stop-reset is uniformly `cancel()`), and the guard that stops the generic
  approve/request-changes/reject resolvers from short-circuiting an iterative gate
  (`assertNotIterativeGate`). The frontend renders both with one `IterationCapPrompt`
  component.

  `companion_rejected` now means only a genuinely unparseable companion verdict (truncated
  / malformed even after a repair retry) — exhausting the rework budget is no longer a
  failure. New `companion.exceeded` flag marks a parked companion gate;
  `POST /executions/:executionId/steps/:approvalId/resolve-exceeded` resolves it. No new
  persistence — the gate reuses the existing execution row + durable decision-wait, so both
  runtime facades get it; the cross-runtime conformance suite asserts the parking and all
  three resolutions against both.

- 0f49ad1: Add a "Connect a source" button to the add-task popup's context picker.

  The `ContextPicker` (the "Extra context" section of the add-task modal) now offers
  an explicit **Connect a source** dropdown listing every configured document/issue
  source, so a user can set up (or reconnect) an integration without leaving the
  popup — previously connecting was only reachable by selecting an unconnected source
  from the source dropdown. Connecting refreshes the picker in place once the source
  comes online.

- 36722cb: Refactor (no behaviour change): decompose the ~1,260-line
  `AgentStepDetail.vue` step-detail overlay so the component is orchestration only.
  The live elapsed-time clock, the prose reader (heading outline / collapse /
  scroll-spy), and the GitHub-style approval-review state machine each move into a
  focused composable (`useStepTimer` / `useStepProse` / `useStepApproval`), and the
  two cleanly-presentational sections (`StepMetadataCard`, `StepTestReport`) move into
  child components. The template's DOM relationships (scroll-spy refs + in-document
  review highlights) are preserved byte-identically; only the script logic and two
  display sections are extracted.
- 3a12f15: Store LLM observability prompts as a delta instead of the full re-sent conversation.

  A container agent re-sends its whole growing message history on every model call, so
  storing each call's full prompt was hugely redundant — in a real 30-call run the
  serialised prompts were ~21× larger than storing the conversation once. The
  observability sink now stores only the messages a call APPENDED beyond
  `promptPrefixCount`, with a `promptHash` of the full array so the next call can verify
  it genuinely extends the previous one before its prefix is elided (a fresh
  conversation on retry, or a context-compacted prompt, safely falls back to storing the
  full array). The full prompt is rebuilt from the chain's deltas on export, and the
  drill-down panel shows just the new messages per call (with an "N earlier omitted"
  note) — less noise as well as far less storage.

  `LlmCallMetric` gains `promptPrefixCount` + `promptHash`; `LlmCallMetricRepository`
  gains `latestChainTip(...)`. D1 migration `0027` and a Drizzle migration add the two
  columns to `llm_call_metrics`. The cross-runtime conformance suite asserts the delta
  round-trip and chain-tip lookup against both real stores.

- a3f84a1: Make dragging tasks between containers reliable. Tasks can now be dropped into a
  module, moved between modules, or pulled back out to the service — previously the
  reparent silently no-op'd because the drag handle (which sits in the task's wrapper
  above the card) stayed hit-testable, so the drop always resolved to the task's
  current container. The whole dragged task is now non-interactive while dragging, so
  `elementFromPoint` resolves the zone actually beneath the cursor.

  Also stop tasks jumping after a drag. Position is now previewed locally during the
  drag and persisted with a single write on release, instead of firing one move
  request per pointer event — the old burst raced, and an out-of-order response could
  land a stale position last and snap the block back (worst when dragging far, e.g.
  toward the end of a service frame). A reparent now also optimistically drops the
  block into its new container so it doesn't briefly flash back to its old home; if
  the reparent request is rejected the block is restored to its old container and an
  error toast is shown, rather than leaving it in the wrong place until re-hydrate.

- 2662bb2: Remove the redundant manual "Review requirements" entry points. The reviewer now always
  runs automatically as the first pipeline gate step, so the inspector panel's "Review
  requirements" button and the review window's "Run review" button (and the dead
  `requirements.review` store action + `reviewRequirements` API client they used) are gone.
  The window's empty state now explains the reviewer runs automatically when the task's
  pipeline starts; the inspector still probes the review so a task's description can freeze
  in favour of the reworked requirements document.
- e5b4bca: Render a failed run's mid-flight agent as "Failed" with a red cross, not "Working".

  A step (or gate helper like the conflict-resolver) left in `working` state when its
  run terminates as `failed` used to keep showing the "Working" label and a frozen
  loader in the inspector, the focus-view pipeline, and the board card drill-down. It
  now reads "Failed" with a red cross (`i-lucide-circle-x`), and a gate companion caught
  mid-run reports "Gave up" instead of "Running". Centralised the shared verdict in
  `pipelineRender` (`isFailedStep`, `FAILED_STEP_META`, a `failed` `CompanionState`).

- 62a94e8: Two requirements-review / failed-run UI fixes.

  When a run fails, the step left mid-flight keeps `state: 'working'`, so the step-detail
  overlay's State badge still read "Working". It now reads "Failed" (red) for a working
  step on a failed run, matching the rest of the failure surface.

  While an iterative reviewer gate (requirements-review / clarity-review) folds answers /
  re-reviews in the background, no human is needed, so its parked approval must not invite
  action. `PipelineProgress` and `TaskPipelineMini` now suppress the "Review & approve"
  button during that background stage (showing a working indicator in the focus pipeline),
  matching the suppression already done in `BlockNode`, `TaskCard`, and `TaskExecution`.

- 268c15d: Fix the async requirements incorporation getting stuck "incorporating" forever, and visualize
  the reviewer's two background stages on the board.

  The async incorporate/re-review cycle could hang permanently: `incorporateRequirements`
  signalled the durable driver to wake but left the run `blocked` from the gate park, and
  `advanceInstance` no-ops on any non-`running`/`paused` run — so the woken driver returned
  `noop` and ended WITHOUT running the re-entrant fold + re-review, leaving the review stuck
  `incorporating`. It now re-arms the run to `running` before signalling, exactly like every
  other resume path (e.g. `advancePastResolvedGate`).

  The cycle also now reports its two stages distinctly. A new transient `reviewing` review
  status is set (and pushed via `requirementReviewChanged`) once the answers are folded and
  the reviewer is RE-reviewing the document, so the UI can tell which of the two LLM calls is
  running instead of one conflated "incorporating and re-reviewing" message.

  - **Board / inspector.** A `requirements-review` gate that is mid-cycle (`incorporating` /
    `reviewing`) no longer shows the "Approval needed" badge or the "Review & approve" button
    on the task card, frame badge, or inspector step list — it shows a working indicator
    ("Incorporating answers…" / "Re-reviewing…") instead, since no human action is needed
    until the reviewer comes back.
  - **Review window.** The single background banner is split into two distinct messages keyed
    on the stage, and edits stay frozen during both.

  Breaking (pre-1.0, no migration): the new `reviewing` review status is a new wire value;
  the `status` column is free text on both runtimes, so no schema change is required.

- d869d53: Fix zoomed-in board cards (and the inspector / focus view / step overlays) failing
  to render a run's pipeline steps.

  The default pipelines now include engine "system" steps (`ci`, `merger`,
  `blueprints`, `conflicts`, `conflict-resolver`) that live in `SYSTEM_AGENT_META`,
  not in `AGENT_BY_KIND`. Several run-step renderers still indexed `AGENT_BY_KIND`
  directly, so a step of one of those kinds resolved to `undefined` and threw on
  `.icon`/`.color`/`.label` during render. The thrown render killed the whole steps
  list: zooming a task in on the board (`TaskPipelineMini`) showed no build steps and
  no current-step indicator, and the same crash hit `PipelineProgress`,
  `TaskExecution`, `AgentStepDetail`, `AgentChip` and `DecisionModal`.

  All of these now resolve display metadata through `agentKindMeta()`, the total
  lookup that already covers palette archetypes, system kinds and unknown/custom
  kinds, so a kind missing from the archetype map can never blow up a renderer.
  `ObservabilityPanel` switches to the same lookup so system steps show their real
  labels instead of a generic fallback.

- 23b9fb6: Stop a failed run's pipeline step from looking like it's still executing.

  When a run fails, the step that was in flight stays `state: 'working'` (and may
  still carry `startingContainer`) with no `finishedAt`, because the failure path
  records the fault without normalising the live step. The run-step renderers keyed
  their live affordances purely off that step state, so a failed task kept spinning
  the last agent, showed "Spinning up container…", and counted its elapsed time up
  forever next to the error card.

  `PipelineProgress`, `TaskPipelineMini`, `TaskExecution` and `AgentStepDetail` now
  gate those live affordances on the instance not being `failed`: no working spinner,
  no "spinning up" phase, and the step-detail duration freezes at the failure time
  instead of ticking. The failure banner + retry is the only live surface left.

- b5a3c2c: Inspector: read an agent's prose output without leaving the panel.

  The inspector's task-execution view listed every pipeline role (architect,
  researcher, reviewer, …) but only ever showed their state and subtask counts —
  the prose those agents produce was reachable solely from the full-screen focus
  view. Each step that produced output now carries a chevron + two-line teaser that
  expands to the full text inline, mirroring the focus view's `PipelineProgress`.

- 0caf2ee: Inspector: add a quick-link to a task's work branch on GitHub, shown once the
  agent has pushed one (a PR branch is recorded on the block). The repo is resolved
  via the task's owning service frame, falling back to deriving the repo base from
  the PR url. Complements the existing service-repo link on a frame's inspector.
- 954c850: Fix `use*Store is not defined` at app boot when the layer is consumed via
  `extends`. `@pinia/nuxt`'s default `storesDirs` is an absolute path resolved
  against the consumer's `srcDir`, so once the SPA was split into this layer +
  example deployment the layer's own `stores/` were never auto-imported. Set a
  relative `pinia.storesDirs` (`['stores']`) so the module re-resolves it against
  each layer's app directory and the layer's Pinia stores auto-import in any
  consumer.
- 7a9cabf: Local mode now warns when no GitHub PAT is configured — in the UI, not just the
  console. At boot, `startLocal()` still logs a warning, but the local facade also tags
  its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
  (classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
  The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
  dismissible banner with a one-click link straight to the token-creation page, so the
  prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
  facade and `LocalModeConfig` from `@cat-factory/server`.
- 711c57b: Board UX: optimistic task start, clearer failure surfacing, and readable agent
  work on a task's focus view.

  - **Optimistic "Start"** — the task card's Start button flips to a spinning
    "Starting…" state the instant it's clicked, before the server confirms. If the
    start call faults it reverts and shows an error toast; otherwise the run's
    `in_progress` push naturally replaces the button.
  - **Failed runs stop pretending to work** — a task whose run has failed now renders
    the shared failure banner + retry (`AgentFailureCard`) instead of a stuck progress
    bar, so a terminated run never looks like it's still running or "awaiting a
    decision".
  - **Subtask todo breakdown on zoom** — a running step's per-todo list (status icon,
    struck-through when done) now renders under the subtask count in `PipelineProgress`,
    matching how the bootstrap card shows its subtasks.
  - **Readable agent prose** — in a task's focus view, every pipeline agent is listed
    and clicking one (architect, researcher, reviewer, …) expands the full prose it
    produced instead of a three-line teaser.

- b156b4b: Personal-password prompt: per-user dual-mode resolution + accurate model context sizes.

  The individual-usage credential gate now prompts for a personal password exactly when
  dispatch will actually lease one, per user:

  - A subscription-only individual model (Claude / Codex) always needs the personal
    credential (no fallback).
  - A DUAL-MODE individual model (GLM, which also has a Cloudflare base) is per-user: a user
    who has connected their own GLM subscription runs on it (gated on their password), while
    a user without one falls back to Cloudflare GLM with no prompt. Dispatch
    (`ContainerAgentExecutor.resolveEffectiveRef`) and the gate now share this decision via a
    new `hasPersonalSubscription(userId, vendor)` seam wired in both runtime facades, so the
    two can't drift. Previously GLM-on-Cloudflare always prompted (the gate keyed off "the
    model has an individual subscription flavour" rather than "this user will use it").
  - A block pinned to any non-subscription model (Cloudflare / Bedrock / direct) is never
    gated just because a workspace per-kind default happens to be an individual model — a
    resolvable block pin wins for every step, mirroring `resolveStepModelRef`.

  The precedence is a pure, unit-tested `resolveIndividualVendors` +
  `personalCredentialVendorForModelId`.

  Frontend: cancelling the personal-password modal now reverts the task's optimistic
  "Starting…" state instead of leaving it stuck until reload. `withCredential` awaits the
  prompt and reports whether the action ran or was cancelled.

  Model catalog context windows corrected from each provider's own docs (the field is now
  documented as the per-flavour served window, which can be larger or smaller per provider):
  Llama 3.1 7,968; Qwen3-30B 32,768; Kimi K2.6 / K2.7 256K on Cloudflare; DeepSeek R1 distill
  80K on Cloudflare; DeepSeek V4 Pro 131,072; GLM-5.2 256K on Cloudflare and the full 1M via a
  Z.ai subscription. The "cut NNK on Cloudflare" wording in the Kimi/GLM/DeepSeek descriptions
  was inaccurate and is rewritten.

  Also: the board shows an empty-state invite (bootstrap a repo / add from an existing repo)
  when it has no service frames.

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

- 311a110: Requirements review: dedicated window + iterative convergence loop, and a universal
  result-view seam.

  The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
  generic approve/reject panel. It now drives the purpose-built structured review window: the
  reviewer raises findings (each with a severity), the human answers or dismisses them, an
  incorporation companion folds the answers into one standard-format document, and the
  reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
  remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
  with a freeform "do it differently" comment.

  Two new per-task knobs live on the merge-threshold preset:

  - `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
    its own and the human picks: one more round / proceed anyway (with the last incorporated
    document) / stop and reset the task to phase zero (editable; the last incorporated
    document stays on the inspector as a base).
  - `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
    below this severity, the findings are recorded but the run advances automatically (no
    human gate, companion skipped).

  Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
  id and register a window component, and the renderer dispatches to it instead of the generic
  prose panel — requirements review is the first consumer, not a hardcoded special case.

  Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
  (convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
  gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
  `requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
  (D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
  dropped, the new columns take defaults, so existing rows are not lost but their old review
  state is re-created on the next run).

- 16f764d: Fix a race in the requirements-review window where opening it the first time showed
  "No review yet" even though a review existed — the initial `load()` fetch is async, so
  the window rendered the empty state until the request resolved (forcing a reopen). The
  store now tracks a per-block `loading` flag, and the window shows a spinner ("Loading the
  review…") while the fetch is in flight, then renders the review as soon as it arrives.
- 645a63a: Fix the requirements-review window showing empty results when opened from a pipeline step
  ("Requirements Reviewer") or the focus view's "Review & approve" button, and stop a
  task-card click from popping the review open.

  The window is mounted fresh by `StepResultViewHost` every time it opens, but its block
  watch wasn't `immediate`, so the initial `load()` fetch never ran — the review only
  appeared when the cache had already been warmed by selecting the task (which the task-card
  path did first, but the pipeline-step path did not). The watch is now `immediate`, so the
  window loads its review on open regardless of entry point.

  Clicking a task card now only selects the task (opening the inspector to interact with it)
  instead of also opening whatever it's parked on; the decision/approval/review is opened
  explicitly via the card's action button.

  The store also coalesces overlapping `load()` calls for the same block, so the inspector
  badge watch and the review window opening together share one request instead of two.

  The `resultView` seam contract (open/blockId/close + Escape + load-on-open) is now a shared
  `useResultView` composable that both result windows build on, so a future custom window
  can't reintroduce the route-dependent empty state: it declares an `onOpen` loader that
  fires on every open regardless of how the window was navigated to.

- c9d3f49: Requirements-review UX + Default Models coverage:

  - Stop toasting on every saved review answer (the cleared draft already confirms the save);
    only failures still toast.
  - Incorporating answers now re-reviews automatically in one action instead of leaving the
    review parked in a `merged` state behind a manual "re-review" click. If the re-review
    itself fails the review stays `merged`, where the manual re-review / redo buttons remain
    as the recovery surface.
  - Surface the engine-driven kinds that still run an LLM (Spec Writer, Blueprinter, Conflict
    Resolver, CI Fixer, Fixer, Merger) in the Default Models settings so their per-workspace
    model can be pinned. They remain absent from the pipeline-builder palette (they're
    auto-inserted seeded steps, not user-addable), and the pure gates (CI, Conflicts) stay out
    since they run no model.

- 30b4a55: In the requirements-review window, the "Looks good — re-review" button now relabels to
  "Re-reviewing…" while the reviewer pass runs. After incorporation finishes and the
  incorporated document is shown, the auto re-review starts immediately; previously the
  button kept its old label with just a spinner, so it was not clear the re-review was
  already in progress.
- 79b0a28: Make module boundaries inside a service resizable, Miro-style, exactly like
  service frames. A module frame can now be resized by dragging its right / bottom
  edges or the bottom-right corner; `ModuleFrame.vue` reuses the existing
  `useFrameResize` composable, so the drag is zoom-aware, clamped to the module's
  content extent (never shrunk below its tasks) and persisted once on release via
  the existing `PATCH /blocks/:id` `size` field. No backend or contract changes:
  `Block.size` and its `width`/`height` persistence already cover any block.
- d50c84c: Make "Restart from here" reachable from every pipeline step window.

  The restart-from-step control was only wired into the generic prose step panel
  (`AgentStepDetail`), but several common step kinds — `tester`, the `ci`/`conflicts`
  gates, and `requirements-review` — open DEDICATED result windows (`TestReportWindow`,
  `GateResultView`, `RequirementsReviewWindow`) via the `resultView` seam, which never
  got the button. So when a user zoomed into a pipeline and clicked one of those steps,
  no "Restart from here" affordance appeared at all.

  Extracted a shared `StepRestartControl` (the same two-click confirm + gating: hidden
  for an off-path open with no run, or while THIS step is parked on an unresolved
  approval gate) and dropped it into all four step windows, so restart is now reachable
  from every step a human can click into. No backend change — the existing
  `POST …/executions/:id/restart` endpoint and store action are unchanged.

- 2d66d34: Spec Writer no longer requires human review by default; its companion (renamed
  **Spec Reviewer**) is the optional automatic quality gate instead.

  - **Default pipelines.** The `spec-writer` step is no longer human-gated. In
    "Full build" (`pl_full`) the `spec-companion` is now inserted right after the
    `spec-writer` (which runs before the architect on the shared work branch), ungated,
    so the spec is reviewed, rated and — below threshold — the spec-writer is
    automatically re-invoked with the reviewer's feedback folded in, instead of pausing
    for a human; the architecture human gate is unchanged. In "Complex fullstack
    feature" (`pl_fullstack`) the `spec-companion` step is likewise ungated (the
    architecture gate, on `architect-companion`, is unchanged).
  - No engine change: this reuses the existing companion review/rework loop
    (`evaluateCompanion`), whose configurable per-step threshold (default 0.8,
    overridable in the pipeline builder) governs when the spec-writer is looped back.
  - The `spec-companion` palette label is renamed from "Spec Companion" to
    **"Spec Reviewer"** and its description updated to reflect that it replaces the
    human spec review rather than preceding it.
  - Cross-runtime conformance gains an assertion that a `spec-writer` → `spec-companion`
    pipeline reworks the spec automatically and completes with no `waiting_decision`
    human gate.

  Breaking: the `seedPipelines()` catalog only seeds a workspace at creation, so
  existing workspaces keep their previously-seeded `pl_full` / `pl_fullstack` rows
  (still gating the spec, and without the `builtin` flag) — there is no re-seed or
  migration. Per the pre-1.0 no-backwards-compat policy that stale shape is acceptable;
  only newly-created workspaces get the ungated, built-in-flagged catalog.

- ac9f407: Refactor (no behaviour change): split the ~1,150-line `useApi.ts` client into
  cohesive per-domain factory modules under `composables/api/*` (auth, fragments,
  models, accounts, workspaces, board, execution, documents, tasks, reviews,
  notifications, presets, releaseHealth, recurring, github, slack, bootstrap),
  each taking a shared `ApiContext` (the authed `$fetch` instance + the path/header
  helpers). `useApi()` builds the context once and spreads every group into the
  same flat client, so all call sites stay `useApi().someMethod(...)` and every
  endpoint's request/response shape is byte-identical.
- 0954a69: Two task-control improvements on the inspector's execution panel:

  - Stop without deleting. The "Stop" button now halts the run but KEEPS it
    (`POST /agent-runs/:id/stop` → `stopRun`): the run stays readable and retryable
    and the block goes `blocked`, instead of the old behaviour that deleted the run
    and reset the task to `planned`. That destructive reset is still available as a
    separate, explicit "Reset" button.
  - Surface the companion iteration-cap decision. When a companion (e.g. the Spec
    Reviewer) spends its rework budget it parks for a human, but the inspector showed
    it as a generic "Approve" gate. It now reads "Needs decision" with a distinct
    "Decide" button that opens the three-way iteration-cap prompt (one more round /
    proceed / stop & reset), so the parked decision is no longer mistaken for a plain
    approval or hidden behind the verdict log.

- 0e0f5cf: Surface pending approval gates on board task cards, and stop the `blocked` status
  from universally reading "Decision needed".

  A task parked on a step's **approval gate** (`requiresApproval`) showed up on the
  board as "Decision needed" with no badge and a click that did nothing — the task
  card only ever handled agent-raised _decisions_, never approvals, so an
  approval-gated run looked stuck with nothing to act on. (The frame badge,
  inspector and focus view already surfaced it; only the task card was a dead end.)

  `TaskCard.vue` now derives what a `blocked` task is actually waiting on — a
  decision, an approval, or a terminal failure — and shows the matching label
  ("Decision needed" / "Approval needed" / "Failed"), an amber attention pulse, and
  a **Resolve**/**Approve** action that opens the right modal (clicking the card
  does the same). The generic `STATUS_META.blocked` label is now the neutral "Needs
  attention" so no surface implies a decision when the run is really awaiting an
  approval or has failed.

- 861d363: Only expand a task card's full build-pipeline list on deep zoom when the card is
  actually on screen, and when two expanded cards would overlap, expand only the one
  closest to the screen centre.

  Deep-zoom (`steps`/`subtasks`) grows each task card downward, and cards are
  absolutely positioned in their frame, so several expanded cards stacked vertically
  used to pile heavily on top of each other. A board-level driver (`useTaskExpansion`)
  now recomputes a permitted set every frame from live DOM rects (so it tracks pan /
  zoom / drag / resize): off-screen cards stay compact, and among visible cards that
  would overlap, only the centre-most expands (greedy, nearest-to-centre first).
  `TaskPipelineMini` reads the permitted set; with no board driver mounted it falls
  back to the plain zoom behaviour.

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

- b98923c: Deleting a service from the board now unlinks its backing GitHub repo, so the
  repo becomes addable again via "Add from existing repo" instead of dangling to a
  deleted block (which left it invisible yet flagged "already on board").
  `BoardService.removeBlock` clears `github_repos.block_id` for any doomed frame.
  The inspector's delete control now names what it removes — "Delete task",
  "Delete module" or "Delete service" — so deleting a selected task no longer reads
  as removing its whole service.
