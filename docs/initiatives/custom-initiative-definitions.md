# Initiative: Custom initiative definitions — org-registered presets, robust end-to-end

**Status:** planned · **Owner:** orchestration · **Started:** 2026-07-07

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR. Companion docs:
> [`initiative-presets-and-docs-refresh.md`](./initiative-presets-and-docs-refresh.md) (the
> preset system this extends), [`initiatives-feature.md`](./initiatives-feature.md),
> [`registry-di-migration.md`](./registry-di-migration.md), and the developer doc
> `backend/docs/initiative-presets.md`.

## Goal & rationale

Organizations should be able to define **proprietary initiative definitions** — a
create-time form, a fixed multi-phase methodology, custom research agents that commit repo
artifacts, and phases that are "the built-in Coder/Tester with very specific org
instructions" — and register them programmatically in their own cat-factory instance,
exactly like custom agent kinds. cat-factory ships **mechanisms only**: no domain prompts,
no org phases, no built-in "connector" anything.

The motivating consumer (kept org-side, never shipped) is a 4-phase "build a new
integration/connector" initiative: (1) business analysis of a named 3rd-party tool with a
GO / GO_WITH_CAVEATS / NO_GO verdict + a committed research doc, where NO_GO must stop the
initiative; (2) implementation analysis producing a committed machine-readable
build-handoff artifact; (3) create the connector — essentially Coder under org
instructions, PR out; (4) validate the connector — essentially Tester + CI gating under
org instructions.

The existing **initiative-preset seam** (`registerInitiativePreset`: descriptor plus
`detect`, `seedPlan`, `promptAdditions`, `phaseTemplate`, `policyDefaults`, spawn
decoration, per-run gate overrides) already covers most of this. This initiative closes
the remaining gaps **without inventing parallel mechanisms**, per the repo principle
"respect the existing seams" and the preset system's governing rule: **the loop never
branches on a preset id** — every deviation is descriptor data or a hook at a well-defined
moment.

**Locked decisions** (made with the product owner at design time):

- **Verdict gating is a human checkpoint, not machine parsing.** The engine gains a
  declarative phase `checkpoint` (pause + notification at the success-side phase
  boundary); resume = GO, cancel = NO_GO. The engine never interprets an LLM verdict, and
  an LLM verdict never auto-cancels an initiative.
- **The initiative-preset registry migrates to app-owned DI as part of this initiative**
  (the `registry-di-migration.md` agent-kind pilot's shape). Pipelines / gates /
  step-resolvers stay on that tracker as coordinated separate work.
- **Augment, don't fork, built-in agents.** Org steering of coder/tester rides the
  existing `promptAdditions` seam (widened to spawned runs) + item descriptions +
  fragments; wholesale replacement of a kind is already possible by re-registering its id
  on the app-owned `AgentKindRegistry` and gets no second mechanism.

## Validated facts & corrections to the initial gap analysis

Verified against the code (files cited are the authorities):

1. **Preset `promptAdditions` today reach ONLY initiative-level (planning) runs.**
   `AgentContextBuilder.resolveInitiativeContext` (orchestration
   `modules/execution/AgentContextBuilder.ts:350–397`) returns `undefined` unless
   `block.level === 'initiative'`, so a spawned task's coder/tester never sees the preset.
   (It also reaches the interviewer separately via
   `InitiativeInterviewService.presetInterviewerSteering` — a second, non-context-builder
   read site to keep in mind for the DI slice.)
2. **The tester kinds are NOT `code-aware`.** `STANDARD_AGENT_TRAITS`
   (`agents/src/agents/kinds/traits.ts:93–122`) gives `tester-api`/`tester-ui`/`playwright`
   only `spec-aware`; `resolveFragments` (AgentContextBuilder.ts:610) folds fragments only
   for `code-aware`/`doc-aware` kinds. So "lean on `registerPromptFragment` +
   `spawn.fragmentIds`" **cannot** carry org tester instructions at all — strengthening the
   case for extending `promptAdditions`. (Coder IS code-aware, and fragments remain the
   right vehicle for org _coding standards_; they are the wrong vehicle for _role/task
   methodology_.)
3. **The failure-side stop already exists; only the success-side stop is missing.** A
   failed spawned run → `reconcileItem` flips the item `blocked` → `phaseIsHalted` stops
   all further spawning in that phase → `deriveCurrentPhase` never advances past it →
   `item_blocked` notification, and `pause`/`resume`/`cancel` endpoints exist with the
   right status gates (`InitiativeService.ts:317–356`). What does NOT exist: a way to stop
   **after a phase completes successfully** so a human can read the phase's
   artifact/verdict before the next phase spawns.
4. **Artifact durability hinges on the item's pipeline merging.** `postOps` (`RepoOp`)
   commit onto `ctx.branch` — the run's work branch. A later phase's container agents
   clone the default branch, so a research artifact is only visible to phase N+1 if phase
   N's pipeline carries the merge tail (`conflicts → ci → merger`) and the item settles
   `done` (merged) — which phase sequencing already awaits (`deriveCurrentPhase` holds the
   phase until items are terminal). So artifact flow needs **no new mechanism**, only a
   documented pattern. Gotcha: `pl_org_audit` in `example-custom-agent`
   (`[org-reviewer, security-auditor]`, no merge tail) commits its report to a branch that
   never merges — fine for a terminal report, wrong shape for cross-phase artifacts.
5. **The hardcoded planner pipeline menu is in the STATIC system prompt**
   (`INITIATIVE_PLANNER_SYSTEM_PROMPT`, server `agents/prompts.ts:122–145` — "Available
   pipelines: pl_quick…"), while preset steering rides the USER prompt
   (`initiativeContextLines` → "## Initiative preset:" section, plus `planShapeLines`). In
   practice presets already dominate pipeline routing without touching the menu:
   `promptAdditions[initiative-planner]` steers, `descriptor.policyDefaults` overrides the
   policy at ingest, `seedPlan` stamps `item.pipelineId`, and `assertPipelinesExist`
   validates. Only a small, data-driven prompt improvement is warranted (slice 4), not a
   new seam.
6. **The initiative-preset registry is module-global and is not even a row on the
   DI-migration checklist** (`registry-di-migration.md` predates it). The phantom-Map
   gotcha that motivated that migration (an externally published org package bundling its
   own copy of `@cat-factory/kernel` registers into an invisible Map) is _exactly_ the
   org-package scenario this initiative exists to make robust. Read sites:
   `AgentContextBuilder`, `InitiativeService` (create/ingest),
   `InitiativeInterviewService`, `WorkspaceController` (snapshot descriptors),
   `InitiativeController` (probe).
7. **Existing coverage that needs no work** (validated): create-form generically rendered
   (`initiativePresetFieldSchema` + `InitiativePresetFields.vue`); interview steering for
   full-interview presets; skip-interview qa seeding; phase-template prompt fold + ingest
   normalizer; spawn decoration incl. per-run `gates` override threaded by the loop; the
   preset-satisfiability start guard (`inline-harness-and-preset-satisfiability.md`)
   applies to custom pipelines automatically; per-item `spawn.agentConfig` for custom
   kinds' config; the follow-up harvest + mid-flight curation for research-surfaced work.
8. **A limit to note (not fix): `seedPlan(draft, inputs)` sees only the frozen form
   inputs**, not the interview `qa` — so anything a `seedPlan` must derive
   deterministically (artifact paths, gate arrays) has to come from a **form field**
   (e.g. the tool name), not a free-form interview answer. The connector use case fits
   (the tool name is the form's required field).

## Target pattern — per-gap design decisions

### D1. Preset prompt additions for spawned execution runs — extend the existing seam

**Decision: resolve `promptAdditions[agentKind]` for ANY run whose block belongs to an
initiative** — not a new `spawn.instructions` field, and not fragments.

- Rationale: `promptAdditions` is already `Partial<Record<AgentKind, string>>` over _all_
  kinds — the restriction to planning kinds is purely in the resolution site, so this is
  widening an existing mechanism, not adding one. Fragments are trait-gated (testers get
  none — see fact 2) and semantically "standards", not role methodology. A per-item
  `spawn.instructions` would duplicate what `item.description` already is: the
  planner-authored, `seedPlan`-augmentable, human-visible text that becomes the spawned
  block's description and reaches every agent's user prompt. Layering therefore stays:
  **preset-level per-kind additions = standing methodology; item-level specifics =
  `item.description` (via planner steering and/or `seedPlan`)**.
- Mechanics:
  - `AgentContextBuilder.resolveInitiativeContext`: when `block.level !== 'initiative'`
    but `block.initiativeId` is set (stamped by `buildTaskBlock`), read the initiative via
    the already-wired `deps.initiatives.getByBlock(workspaceId, block.initiativeId)` and
    return a **preset-only** context: `{ preset: { label, promptAddition } }` — no
    goal/qa/analysis fold for spawned runs (keeps spawned prompts minimal; the item
    description is the task contract). Gated on `block.initiativeId`, so the
    non-initiative hot path gains zero reads; one point-read per initiative-spawned step
    (no loop → no N+1).
  - Render: a shared `initiativePresetSection(context)` in `@cat-factory/agents`
    (`catalog.ts`), emitted as the same `## Initiative preset: <label>` section, appended
    in BOTH `renderStandardUserPrompt` (built-in coder/tester/spec-writer/…) and the
    generic fallback prompt in `buildBaseUserPrompt` (custom kinds). Kinds with fully
    bespoke user prompts that bypass the generic builder (e.g. the doc writers) pick it up
    where they compose from `userPromptFor`; audit during implementation.
  - `AgentRunContext.initiative` (kernel `ports/agent-executor.ts`) needs no shape change
    — only doc updates (it is now populated, preset-only, on spawned runs).
  - Overriding vs augmenting: this is deliberately **augment-only**. Replacing a built-in
    kind's system prompt wholesale is already possible today by registering a same-id kind
    on the app-owned `AgentKindRegistry` (replace-by-id) — that existing seam IS the
    "override" story; do not build a second one.
- Verified by: orchestration unit tests (context builder resolves preset for a spawned
  block; absent for non-initiative blocks; unknown preset ⇒ unchanged), agents unit test
  (section renders for standard + custom kinds; absent ⇒ byte-identical prompt), and one
  conformance assertion that a spawned run's step context carries the preset addition on
  both runtimes.

### D2. Phase checkpoints + the NO_GO stop — declarative data, existing lifecycle

**Decision: a declarative `checkpoint` flag on phases, honored generically by the loop via
the existing `paused` status — no new preset code hook, no engine special-case, no verdict
plumbing in the engine.**

- Model:
  - `initiativePresetTemplatePhaseSchema` and `initiativePhaseSchema` (+ the draft phase
    schema) gain `checkpoint?: boolean` — "when this phase's items all settle, pause the
    initiative for human review before the next phase spawns". Rides the `doc` blob: no
    migration, runtime-symmetric by construction.
  - Ingest: the phase-template normalizer (or `applyPlanDraft`) stamps `checkpoint` onto
    the persisted phase from the template (template-authored, the planner cannot unset
    it); a plain planner-authored `checkpoint` on a draft phase is also honored (generic —
    usable without a preset).
  - Entity bookkeeping: `InitiativePhase.checkpointClearedAt?: number` (set on resume), so
    a cleared checkpoint never re-fires; `applyPlanDraft` preserves it for an existing
    phase id (replay/re-plan safe).
  - Pure logic (`initiative.logic.ts`): `pendingCheckpoint(initiative): InitiativePhase | null`
    — the first phase, in declared order, with `checkpoint === true`, all its items
    terminal, and no `checkpointClearedAt`; plus `applyCheckpointCleared`.
  - Loop (`InitiativeLoopService.tick`): after reconcile, **before** complete/spawn — if
    `pendingCheckpoint` is non-null, CAS the status to `paused`, raise the existing
    `initiative` notification with a new `initiativeReason: 'checkpoint'` ("Phase X
    complete — review its output, then resume or cancel"), re-commit the tracker, stop the
    tick. Ordering matters: checked before the all-items-settled completion step, or a
    checkpoint on the LAST phase silently auto-completes (a preset that wants unattended
    completion simply doesn't checkpoint its last phase). A paused initiative is invisible
    to `listExecuting`, so nothing else changes.
  - Resume (`InitiativeService.resume`): additionally stamps `checkpointClearedAt` on the
    pending checkpoint phase inside the same CAS transform as `paused → executing` —
    resume IS the acknowledgment; a separate ack write would race the sweeper. Cancel is
    the NO_GO path (already exists).
- **How NO_GO stops the initiative** (registry-authored, zero engine verdict machinery):
  the org's phase-1 research kind returns its verdict in `structuredOutput`; its `postOps`
  render the research doc (verdict included) into the repo; an optional org
  `StepCompletionResolver` (`registerStepResolver`, the example package's
  `auditorSummaryResolver` pattern) turns the verdict into the step's human-readable
  output so the tracker/run detail read "Verdict: NO_GO — …". The phase declares
  `checkpoint: true`, so the initiative pauses when the research item merges; the human
  reads the committed research doc and **cancels** on NO_GO or **resumes** on GO. A
  business GO/NO_GO is a human decision by nature, so pausing (not auto-cancelling) is the
  right product semantic — and an org that truly wants a hard stop can have its resolver
  fail the run instead (failure → `blocked` item → halted phase, existing behavior).
- Considered and rejected: a preset `onItemSettled`/`onPhaseComplete` code hook inside the
  loop. It would add a third preset-code moment _inside execution_ — today preset code
  runs only at create and ingest — and everything it would do (pause/cancel/notify) is
  expressible as declarative data + the existing statuses.
- Verified by: pure unit tests (`pendingCheckpoint` ordering incl. halted phases,
  cleared-checkpoint idempotence, last-phase case), loop unit tests (pause fires once;
  resume advances), a conformance round-trip for the new phase fields + a checkpoint
  pause/resume assertion, and an e2e extension (slice 3).

### D3. Artifact flow between phases — no new mechanism; document the pattern

**Decision: nothing new is built.** The pattern, to be documented in
`backend/docs/initiative-presets.md` (and proven by the worked example):

1. A research kind is `container-explore` + `structuredOutput`; a `postOps` `RepoOp`
   renders the artifact deterministically and commits it via checkout-free
   `RepoFiles.commitFiles` with the byte-identical idempotency guard (the
   `example-custom-agent` `renderReportPostOp` is the copy-from citizen).
2. **Artifact paths are derived, not discovered**: `seedPlan` derives them from the frozen
   preset inputs (e.g. `docs/research/research-${slug(toolName)}.md`) and bakes them into
   the later phases' `item.description`s (and, where a single `.md` fits,
   `spawn.taskTypeFields.targetPath` — the docs-refresh rule: only derivable single-file
   `.md` paths get `targetPath`). Both producer and consumer derive from the same frozen
   inputs, so they cannot drift.
3. **The producing item's pipeline must merge** (carry the universal
   `conflicts → ci → merger` tail); phase sequencing then guarantees the next phase's
   clones contain the artifact. A D2 checkpoint between the phases doubles as the human's
   artifact review moment.

Considered and rejected: an initiative-level `artifacts` record (duplicates state the repo
already holds authoritatively; nothing would read it); threading artifact bodies through
`AgentRunContext` (container agents read the checkout — pre-injecting repo content is the
anti-pattern the custom-agents migration exists to remove).

### D4. Planner pipeline menu — data-driven fold, smallest possible

**Decision: keep `promptAdditions` + `policyDefaults` + `seedPlan` as the routing story
(already sufficient — no new descriptor field), and land one small generic prompt fix:**
when the resolved preset's `policyDefaults` names pipelines (`defaultPipelineId` /
`rules[].pipelineId`), the plan-shape fold (`planShapeLines` neighborhood in
`server/src/agents/prompts.ts`) appends a "Preferred pipelines for this preset" line
telling the planner those pipelines are pre-decided and it should not re-route items —
neutralizing the static system prompt's `pl_quick…` menu for preset runs. No preset ⇒
byte-identical prompt. This is rendering existing descriptor data, not a new mechanism.
Low priority — reassess after the pilot slices; drop if planner drift doesn't occur in
practice.

Verified by: prompt unit tests (with/without `policyDefaults`), and the existing ingest
`assertPipelinesExist` backstop.

### D5. Registration robustness — migrate the preset registry to app-owned DI here

**Decision: this initiative migrates the initiative-preset registry to the app-owned DI
pattern (the agent-kind pilot's shape), and adds the missing row to
`registry-di-migration.md`. Pipelines/gates/step-resolvers stay on that tracker as
coordinated separate work** (an org package still calls module-global `registerPipeline` /
`registerGate` / `registerStepResolver` until those rows migrate — acceptable, already the
documented state in `example-custom-agent`).

- Mechanics (copy the agent-kind pilot): `InitiativePresetRegistry` class in kernel
  (`register` / `get` / `all` / `descriptors`, generic preset always resolvable) +
  `defaultInitiativePresetRegistry()` preloading the built-ins (generic, docs-refresh,
  tech-migration — the built-ins' bottom-of-module self-registration side effects move
  into the factory); an optional defaulted `CoreDependencies.initiativePresetRegistry`
  threaded into `InitiativeService`, `InitiativeInterviewService`, `AgentContextBuilder`;
  attached to `ServerContainer` for `WorkspaceController` (snapshot descriptors) and
  `InitiativeController` (probe), wired symmetrically across Worker + Node + local. Delete
  the free `registerInitiativePreset` / `clearRegisteredInitiativePresets` exports
  (pre-1.0, breaking-flagged changeset); `registerExampleCustomAgents` gains the registry
  parameter (do NOT invent a new aggregate beyond what `CoreDependencies` already is).
- Rationale: "register programmatically like custom agents" is the headline ask; the
  module-global Map is the one known robustness hole for _published_ org packages (the
  phantom module instance). Doing presets now also de-risks the later pipeline/gate rows
  (same wiring sites).
- Verified by: the conformance suite injects a registry preloaded with a fake custom
  preset via the `makeApp` overrides seam and asserts the snapshot descriptor +
  create-with-preset behave identically on every runtime (replacing today's module-global
  conformance registration). Remember the DI tracker's gotchas: >1 construction site per
  facade, and rebuilt-container probes must re-thread the override.

### D6. Everything else found

- **Interviewer steering** already works for full-interview presets — after D5, ensure
  `InitiativeInterviewService` reads the injected registry (it is one of the read sites).
- **Satisfiability**: no work — the start guard covers custom pipelines/kinds generically.
- **Frontend**: near-zero — create modal/form are generic; the checkpoint pause reuses the
  existing paused-state UI + notifications; add a small "checkpoint" annotation on the
  tracker window's phase list (one component touch + i18n chrome).
- **Docs**: `backend/docs/initiative-presets.md` gains the spawned-run `promptAdditions`
  semantics, the checkpoint section, and the consumer walkthrough below;
  `backend/docs/custom-agents.md` cross-links; `registry-di-migration.md` gains the preset
  row.

## Per-slice status checklist

| #   | Slice (each one PR)                                                                                                                                                                                                                                                                                                                                                                                                                      | Scope  | Depends on | Status  | PR   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------- | ---- |
| 0   | This tracker doc                                                                                                                                                                                                                                                                                                                                                                                                                         | —      | —          | ✅ done | #942 |
| 1   | **Spawned-run preset prompt additions (D1, the pilot)**: `AgentContextBuilder` initiative-preset resolution for `block.initiativeId` blocks; shared `initiativePresetSection` render in `@cat-factory/agents` (standard + generic prompts); kernel context docs; unit + conformance                                                                                                                                                      | SYSTEM | —          | ✅ done | #944 |
| 2   | **Phase checkpoints (D2)**: contracts (`checkpoint` on template/entity/draft phases + `checkpointClearedAt`), ingest stamping, pure `pendingCheckpoint`/`applyCheckpointCleared`, loop pause + `checkpoint` notification reason, resume clears, tracker.md renders checkpoints; unit + conformance                                                                                                                                       | SYSTEM | —          | ✅ done | #949 |
| 3   | **Checkpoint SPA touch + e2e**: phase checkpoint badge / paused-at-checkpoint explanation; e2e: checkpointed fake plan → pause → resume → next-phase spawn (extends the `FakeProfile.initiativePlan` seam — do not add a second one)                                                                                                                                                                                                     | SYSTEM | 2          | ✅ done | #952 |
| 4   | **Planner preferred-pipelines fold (D4)**: `policyDefaults`-derived line in the plan-shape fold; prompt unit tests. Low prio — reassess after slices 1–2; drop if planner drift doesn't occur                                                                                                                                                                                                                                            | SYSTEM | —          | ⬜ todo |      |
| 5   | **Preset-registry DI migration (D5)**: kernel registry class + default factory; `CoreDependencies` field; thread into the 3 orchestration read sites + `ServerContainer` for the 2 controllers; symmetric facade wiring (Worker/Node/local); delete free registration fns (breaking changeset); conformance custom-preset injection; update `registry-di-migration.md`                                                                   | SYSTEM | 1, 2       | ⬜ todo |      |
| 6   | **Worked example + docs (the consumer proof)**: extend `example-custom-agent` with a minimal 2-phase "research → apply" preset exercising ALL new seams (custom container-explore kind + verdict resolver + artifact postOp on a merging pipeline, `checkpoint: true` research phase, a `coder` promptAddition, `seedPlan`-derived artifact path); expand `backend/docs/initiative-presets.md` (consumer walkthrough); cross-doc updates | BOTH   | 1, 2, 5    | ⬜ todo |      |

Pilot ordering: slice 1 is the pilot (highest-value, smallest blast radius, establishes
the "widen an existing seam, don't add one" shape). 2 is independent and can run in
parallel. 4 is a trivial standalone. 5 has the largest blast radius (facade wiring), so it
goes after the behavior slices are green rather than churning their read sites twice. 6
closes the loop and is the acceptance proof.

## Consumer walkthrough — assembling the connector factory (org-side, zero shipped prompts)

How an org builds the 4-phase connector initiative from the finished mechanisms, entirely
inside its own `@acme/connector-factory` backend package registered from its deployment's
composition root (the `example-custom-agent` trust model — a preset carries code, so it is
exactly as trusted as a custom agent):

1. **Two custom agent kinds** (`registry.registerAll` on the app-owned
   `AgentKindRegistry`):
   - `acme-biz-analyst`: `agent: { surface: 'container-explore' }`, org system prompt
     (multi-source research on the named tool), a `structuredOutput` schema
     (`verdict: GO | GO_WITH_CAVEATS | NO_GO`, plus summary / findings / openQuestions),
     `postOps: [renderResearchDocPostOp]` — renders
     `docs/research/research-<tool>.md` (verdict + findings + open questions) via
     `RepoFiles.commitFiles` with the byte-identical idempotency guard. A registered
     `StepCompletionResolver` folds "Verdict: NO_GO — …" into the step output so the
     tracker and the checkpoint review read it at a glance.
   - `acme-impl-analyst`: same surface; reads `docs/research/research-<tool>.md` from its
     checkout (the path is in its item description); `postOps` commit
     `docs/handoff/<tool>.build-handoff.yaml` rendered from its structured output.
2. **Two custom pipelines** (`registerPipeline`, until that registry's DI row lands):
   `pl_acme_research = [acme-biz-analyst, conflicts, ci, merger]` and
   `pl_acme_handoff = [acme-impl-analyst, conflicts, ci, merger]` — the merge tail is
   load-bearing: it lands the artifact on the default branch before the next phase clones.
   Phases 3–4 use **built-in** pipelines (e.g. `pl_full` for create, or a lean
   `pl_acme_validate = [tester-api, ci, merger]` reusing built-in kinds) — no new agent
   kinds.
3. **The preset** (after slice 5: `registry.register` on the injected
   `InitiativePresetRegistry`):
   - `fields`: `toolName` (text, required), `docsRoot` (path, default `docs/research`),
     `humanReview` (checkbox), plus org scoping fields; `interview: 'full'` so the
     interviewer collects the open unknowns up front,
     `promptAdditions[initiative-interviewer]` steering what to ask.
   - `phaseTemplate` (all `required: true`, `allowAdditionalPhases: false`):
     `business-analysis` (**`checkpoint: true`**), `implementation-analysis`
     (`checkpoint: true` if the org wants a second review gate before build spend),
     `create-connector`, `validate-connector`. Shared phase-id constants referenced
     verbatim in template + promptAdditions + seedPlan (the `tech-migration/phases.ts`
     pattern).
   - `promptAdditions`: analyst/planner steering ("emit exactly one research item naming
     the tool…") **plus, via slice 1**, `coder:` (org connector architecture, module
     layout, "consume `docs/handoff/<tool>.build-handoff.yaml` from your checkout") and
     `tester-api:` (org e2e validation methodology). Org _coding standards_ additionally
     ride `registerPromptFragment` + `spawn.fragmentIds` / `defaultFragmentIds` (coder is
     `code-aware`; remember testers are not — their steering lives in `promptAdditions`).
   - `seedPlan` (decoration only, never phases): route items to
     `pl_acme_research` / `pl_acme_handoff` / the build/validate pipelines by `phaseId`;
     derive the two artifact paths from the frozen `toolName` and append them to the
     phase-2/3/4 items' descriptions; emit the full-array `spawn.gates` from `humanReview`
     (gate the `merger` step, the docs-refresh `docsReviewGates` pattern).
   - `policyDefaults`: `{ maxConcurrent: 1, defaultPipelineId: 'pl_full' }` — serialized
     phases; the slice-4 fold tells the planner the routing is pre-decided.
4. **The run**: create from the picker (generic form) → interview → analyst/planner under
   preset steering → phase-template-normalized ingest → human approves the plan → loop
   spawns the research item on `pl_acme_research` → research PR (artifact + verdict)
   merges → **checkpoint pauses the initiative** with a notification → human reads
   `docs/research/research-<tool>.md`: **cancel on NO_GO** (existing endpoint — the
   initiative stops, tracker records it), resume on GO → phases 2–4 proceed the same way,
   phase 3 opening the connector PR with coder under org instructions, phase 4 validating
   with tester + the CI gate, `humanReview` gating each merge if opted in.

Zero cat-factory changes beyond the slices above; zero org prompts shipped in cat-factory.

## Conventions & gotchas (carry between iterations)

- **The loop never branches on a preset id, and preset CODE runs only at create + ingest.**
  Checkpoints are entity DATA the loop reads; verdicts are the org kind's own
  structured-output/resolver concern. Do not add loop-time preset hooks.
- **Plan SHAPE in `phaseTemplate`, DECORATION in `seedPlan`** — unchanged governing split;
  `checkpoint` is shape (template-authored).
- **Augment, don't fork, prompts**: preset-level = `promptAdditions[kind]` (after slice 1,
  any kind on initiative runs); item-level = `description`; standards = fragments
  (code/doc-aware kinds only — testers are NOT code-aware); full replacement =
  re-register the kind id on the `AgentKindRegistry`.
- **Only `initiative.preset` folds onto spawned-run context** — never goal/qa/analysis
  (items are self-sufficient by contract; bleeding planning context into children
  regresses prompt hygiene and token budgets).
- **Checkpoint check runs BEFORE completion** in `tick`, or a last-phase checkpoint
  silently auto-completes.
- **Resume IS the checkpoint acknowledgment** — stamp `checkpointClearedAt` inside the
  same CAS transform as `paused → executing`; a separate ack write would race the sweeper.
- **Artifacts live in the repo, nowhere else**; producing pipelines must carry the merge
  tail (`pl_org_audit`'s tail-less shape is for terminal reports only); paths are derived
  from frozen inputs in `seedPlan` (which never sees interview answers — enumerable facts
  must be form fields).
- **Keep the runtimes symmetric**: entity/doc-blob fields are symmetric by construction
  but still get conformance round-trips; the DI slice's controller/facade wiring lands
  Worker + Node (+ local inherits) + conformance in the SAME PR.
- **No N+1**: the spawned-run preset resolution is one `initiatives.getByBlock` per step,
  gated on `block.initiativeId` — never resolve per item/fragment in a loop.
- **Pre-1.0, no back-compat**: delete the free preset-registration functions in slice 5;
  breaking changeset; changesets per touched package; README catalog + knip + guard
  scripts per the repo checklist.
- **E2E reuses `FakeProfile.initiativePlan`** for planner output — never a second seam.
- **Slice 2 landed:** `checkpoint` / `checkpointClearedAt` ride the phase (no migration — the
  entity's `doc` blob), and the notification `initiativeReason` gained `'checkpoint'`. The pure
  `pendingCheckpoint`/`applyCheckpointCleared` live in `initiative.logic.ts`; the loop calls
  `pendingCheckpoint` in `tick` **after reconcile, before complete/spawn** (`pauseAtCheckpoint`
  re-checks on the fresh entity inside the CAS so a concurrent resume can't be raced), and
  `InitiativeService.resume` clears the pending checkpoint in the SAME CAS transform as
  `paused → executing`. `normalizeDraftAgainstPhaseTemplate` FORCES a template `checkpoint: true`
  onto the matched draft phase (planner can't unset it); `applyPlanDraft` carries a draft
  `checkpoint` through and PRESERVES an existing phase's `checkpointClearedAt` across a re-plan;
  `coerceInitiativePlan` carries a planner-authored `checkpoint` (the generic, preset-less path).
  Conformance: the store round-trips the new phase fields, and `resume`-clears is driven over each
  facade's real store (the pause itself is loop-driven, covered by the loop unit test). Note the
  item-less-checkpoint-phase rule: a checkpoint phase with zero items never fires (nothing to
  review) — it's skipped like any empty phase. NOT touched: the planner SYSTEM prompt (no prompt
  guidance that the planner may author a checkpoint — presets drive it via the phase template;
  revisit only if the generic planner-authored path proves useful in practice).
- **Slice 3 landed:** SPA + e2e only — no backend/wire change. The tracker window
  (`InitiativeTrackerWindow.vue`) recomputes the pending checkpoint LIVE from the entity via a
  frontend `pendingCheckpointPhase` (`app/utils/initiative.ts`) that MIRRORS the backend
  `pendingCheckpoint` (unit-pinned in `initiative.spec.ts` so it can't drift) — it does not read a
  derived flag off the wire. It renders a per-phase checkpoint badge (awaiting-review / reviewed /
  upcoming) and, when `status === 'paused'` at a pending checkpoint, a banner (`data-testid=
  initiative-checkpoint-pause`) with inline Resume/Cancel (reusing `initiatives.control` +
  `initiative.inspector.resume|cancel` copy — no new lifecycle). The initiative board card gained a
  live `data-status` for observability. New i18n keys live under `initiative.checkpoint.*`
  (translated across all 10 locales, parity-gated). E2E `initiative-checkpoint.spec.ts` reuses the
  `FakeProfile.initiativePlan` seam + `preset_generic` (converging fake inline interviewer + planner
  gate approved over REST) + a merger-tailed workspace pipeline (so a spawned item reaches `done` —
  the terminal that fires the checkpoint): phase-1 done → card `paused` + phase-2 UNSPAWNED (proving
  the gate) → tracker banner → Resume → phase-2 spawns. Added the `getInitiative` snapshot helper for
  backend-only progression a spec can't see on the board.
- **Slice 1 landed:** the shared renderer is `initiativePresetSection(context)` in
  `@cat-factory/agents` `prompts/standard.ts` (NOT `catalog.ts` — it lives beside the sibling
  section helpers `environmentSection`/`involvedServicesSection` and is re-exported from the
  package index). It renders ONLY `label` + `promptAddition` (never the phaseTemplate) and is
  emitted from `renderStandardUserPrompt` (standard phases), `buildBaseUserPrompt` (generic custom
  kinds), AND the server's `initiativeContextLines` (planning prompts) — so the preset section text
  is byte-identical everywhere. `AgentContextBuilder.resolveSpawnedPresetContext` resolves the
  spawned-run half (gated on `block.initiativeId`, one point-read, preset-only). The conformance
  app now exposes `initiativeRepository()` (all 4 facade harness impls) so the suite can seed an
  initiative + link a task's `initiativeId` without driving a planning loop; the `FakeAgentExecutor`
  `echoPreset` option surfaces the resolved preset for the assertion.

## Out of scope

- Migrating the pipeline/gate/step-resolver registries to DI (stays on
  `registry-di-migration.md`).
- Auto-cancel on a machine verdict (deliberate: checkpoint + human cancel is the product
  semantic; an org can still hard-fail via its own step resolver).
- Data-only / DB-authored presets; public-API preset exposure; templated pipelines with a
  swappable step (all already tracked as out of scope on the presets tracker).
- Any shipped domain content for the connector use case (org-side by design).
- Web-search tooling for research agents (the org kind's own concern via the container's
  network / the web-search gateway).
