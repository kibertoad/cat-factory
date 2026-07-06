# Initiative: Initiative presets & the Documentation-refresh preset (pilot)

**Status:** planning (slice 0 = this tracker) · **Owner:** orchestration · **Started:** 2026-07-05

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The product Initiative feature (`docs/initiatives/initiatives-feature.md`) plans a
cross-cutting body of work through one fixed pipeline — `pl_initiative`
(`initiative-interviewer → initiative-analyst → initiative-planner → initiative-committer`,
human approval after the planner) — then executes the approved plan as a loop of spawned
tasks (`backend/packages/orchestration/src/modules/initiative/InitiativeLoopService.ts`)
while mirroring a tracker into the target repo. That shape fits open-ended refactors, where
an interview is how the goal gets pinned down. It does NOT fit **task-shaped initiatives**
whose inputs are known up front and enumerable as a form: "refresh this service's
documentation", "sweep the dependency tree", "audit licensing". For those, the interview is
friction, the plan shape is predictable, and the run should be unattended by default.

This initiative introduces **initiative presets**: a preset is more than a pipeline — it
bundles (a) its **own form** the user fills at create time (rendered generically by the SPA
from a backend-supplied descriptor, zero frontend changes per preset), (b) a **planning
pipeline binding** (e.g. skip the interviewer — the form IS the interview), (c) **logic
deviations** as code hooks (a deterministic repo-detection probe that prefills the form, a
plan post-processor) and data (per-agent-kind prompt steering, execution-policy defaults,
default prompt fragments, a human-review default), and (d) **spawn decoration** so the tasks
the loop spawns come out as first-class typed tasks (docKind/targetPath/fragments/pipeline)
rather than bare description blocks. Deployments register their own presets through a new
public seam, exactly like custom agent kinds.

The pilot consumer proving the primitives is the **Documentation-refresh preset**: given a
service/frontend, audit its documentation against the implementation and drive it to a full,
current set — writing new docs to fill gaps and clarifying stale ones. The user checkboxes
what is desired (README files, mermaid diagrams, in-source comments, business
rules/constraints), placement defaults to `/docs` (root or per-service depending on monorepo
shape) with **autodetection** of the current layout and per-doc-type subfolder overrides,
human review is **off by default** (opt-in), and the recommended writing-style fragments
(`style.anti-llmisms`, `style.concise-actionable`) are on by default (configurable).

Everything in the preset system is generic; docs-refresh is the pilot the way acme-main
pilots `stack-recipes-and-shared-stacks.md`.

**Locked decisions** (made with the product owner at design time):

- **Human-review opt-in is a per-run gate-override engine seam**, not gated/ungated pipeline
  pairs. `ExecutionService.start` gains an optional gates override (validated against the
  pipeline shape, copied onto the run's steps); a preset registers ONE planning pipeline and
  its `humanReview` form value maps to overrides for the planning run and the spawned task
  runs. Cleaner long-term than doubling every preset's pipeline registrations.
- **Docs-refresh is a one-shot refresh.** "Synchronized" means: the audit found the gaps at
  plan time, and the initiative completes when every item's PR merged. Re-running = creating
  a new initiative from the same preset (the probe re-prefills the form, so it's cheap). A
  recurring drift-watch pairing is a follow-up, out of v1 (see Out of scope).
- **Custom presets are code-carrying backend packages only** (the
  `backend/internal/example-custom-agent` trust model): `detect`/`seedPlan` are code, and a
  preset can steer agents and read repos, so it is exactly as trusted as a custom agent.
  Data-only presets stay expressible (the descriptor/hook split keeps the pure-JSON subset
  well-formed) but are deferred until a non-code consumer exists.

## Validated facts the design builds on

- The `Initiative` entity rides a JSON `doc` blob (`backend/packages/contracts/src/initiative.ts`),
  so adding `presetId`/`presetInputs`/item `spawn` decoration needs **no migration** and is
  runtime-symmetric by construction (the slice-4 precedent in `initiatives-feature.md`).
- The pipeline⇄block guard is **kind-keyed** (`hasInitiativeKinds`), so a preset-registered
  planning pipeline without the interviewer is already legal on an initiative block.
- Form precedent: `ProviderConfigField` (`text/password/select/number/checkbox/textarea`) +
  `descriptor-driven-infra-forms.md`, which names "grouped/conditional fields" as its own
  prerequisite next step — the preset field vocabulary (`checkbox-group`, `path`, `showWhen`)
  IS that step; the two initiatives compound rather than fork.
- Reusable doc agents exist: `doc-writer` (+ `doc-quality` gate; `targetPath` overrides
  placement), `business-documenter` (default `docs/business-logic`; "an established location
  wins" is currently LLM judgment), `documenter`. **No** mermaid generation and **no**
  deterministic docs-folder detection exist today; prior art for bounded checkout-free repo
  detection is `provision-detect.logic.ts` and the board-scan reader.
- Style fragments exist: `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` = `style.anti-llmisms` +
  `style.concise-actionable` (`backend/packages/prompt-fragments/src/collections/style.ts`);
  blocks persist `fragmentIds` — but `InitiativeLoopService.buildTaskBlock` stamps only
  `estimate` today (spawn decoration is the gap).
- Backend-registered things reach the SPA via the workspace snapshot (`customAgentKinds`
  precedent) — preset descriptors ride the same channel.
- Per-run params reach agents only through `AgentRunContext`
  (`backend/packages/orchestration/src/modules/execution/AgentContextBuilder.ts`); preset
  inputs fold in via `resolveInitiativeContext`, and for skip-interview presets the create
  flow seeds the `qa` log from the form (so the tracker digest and planning prompts work
  unchanged).

## Target architecture

### The preset system (generic)

1. **Contracts** — new `backend/packages/contracts/src/initiative-preset.ts`:
   - `InitiativePresetField`: extends the `ProviderConfigField` family with `checkbox-group`
     (multi-select, value `string[]`), `path` (repo-relative dir, `isSafeDocPath`-style
     validation), and `showWhen: { key, equals? | includes? }` single-condition visibility
     (per-doc-type subfolders shown only when that type is checked — no recursive schema
     renderer).
   - `InitiativePresetDescriptor`: `{ id, presentation: {label, icon, color, description},
fields, planningPipelineId, interview: 'full' | 'skip', humanReviewDefault,
defaultFragmentIds, policyDefaults?: Partial<InitiativeExecutionPolicy>, probe? }`.
     Labels are backend-supplied English (the established descriptor convention); only the
     surrounding chrome is i18n.
   - `InitiativePresetInputs`: a bounded JSON record (`string | string[] | boolean | number`),
     validated against the descriptor on create.
2. **Kernel registry** — new
   `backend/packages/kernel/src/domain/initiative-preset-registry.ts`:
   `registerInitiativePreset({ descriptor, detect?, seedPlan?, promptAdditions? })` —
   module-global, replace-by-id, beside the pipeline/gate registries. `detect(repo: RepoFiles)`
   is a deterministic, bounded, best-effort prefill probe; `seedPlan(draft, inputs)` is a pure
   post-processor/validator of the planner's draft at ingest; `promptAdditions` is a
   per-agent-kind map of planning-prompt steering text (data, not code).
3. **Entity extension** — `Initiative.presetId` + `Initiative.presetInputs` and
   `InitiativeItem.spawn: { taskTypeFields?, fragmentIds?, agentConfig?, gates?, }` (+ the
   draft-item schema), all inside the `doc` blob. Rendered onto the in-repo `tracker.md` as a
   "Preset & configuration" section. Inputs are **frozen after create** (the `agentConfig`
   freeze precedent).
4. **Per-run gate overrides (engine seam)** — `ExecutionService.start` accepts an optional
   gates override, validated against the pipeline's step count and copied onto the run's
   steps; `InitiativeLoopService` threads item `spawn.gates` when starting spawned runs; the
   preset's review mapping computes overrides from the `humanReview` input (planning run: the
   plan-approval gate after `initiative-planner`; task runs: the gated variants of their
   pipelines). Conformance assertions on both runtimes.
5. **Create/planning flow** — `InitiativeService.create` resolves the preset, validates
   inputs against the descriptor (unknown preset ⇒ validation error; absent `presetId` ⇒
   today's behaviour byte-for-byte), persists both, and for `interview: 'skip'` presets seeds
   `qa` with one synthetic answered entry per filled field and templates `goal` from the
   inputs. New endpoint `POST /workspaces/:id/initiative-presets/:presetId/probe { frameId }`
   resolves the frame's repo (the `resolveRunRepoContext` seam) and runs `detect`,
   returning `{}` when GitHub is unwired — the form falls back to descriptor defaults, never
   blocks create. The snapshot carries `initiativePresets: InitiativePresetDescriptor[]`
   (attached by both facades, like `customAgentKinds`). `AgentContextBuilder` folds
   `{ id, label, inputs, promptAdditions }` into the planning steps' prompts. At ingest,
   `seedPlan` runs before `applyPlanDraft`; the loop's `buildTaskBlock` stamps the item's
   `spawn` decoration onto the spawned block.
6. **SPA** — `CreateInitiativeModal.vue` becomes a preset picker (defaulting to
   `preset_generic`, see 8) + a generic descriptor-driven field renderer (extend the
   `ProviderConnectionTab.vue` flat-field pattern with `checkbox-group`/`path`/`showWhen`),
   with probe prefill fired on preset/frame selection. The SPA starts planning with
   `descriptor.planningPipelineId` instead of the hardcoded `pl_initiative`.
7. **Custom presets** — a deployment package registers kinds/pipelines/gates/presets from
   its composition root, mirroring `backend/internal/example-custom-agent`; the worked
   example gains a tiny preset to prove the seam. Data-only (DB/UI-authored) presets are out
   of scope (see below).
8. **Strangler step** — register `preset_generic`: empty `fields`,
   `planningPipelineId: 'pl_initiative'`, `interview: 'full'`, `humanReviewDefault: true`, no
   hooks. The generic initiative becomes just the default preset; nothing in the
   planning/loop path branches on "has preset" — a preset only ever adds context.

### The Documentation-refresh preset (pilot)

9. **Form** (`preset_docs_refresh`):

   | Field              | Type           | Default                               | Notes                                                                                           |
   | ------------------ | -------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
   | `docTypes`         | checkbox-group | all four                              | `readme`, `diagrams`, `comments`, `business-rules`                                              |
   | `placementMode`    | select         | probe-detected                        | `root` (single `/docs`) vs `per-service` (monorepo)                                             |
   | `docsRoot`         | path           | `docs/`                               | probe-prefilled                                                                                 |
   | `diagramsDir`      | path           | `docs/diagrams`                       | probe-prefilled; `showWhen: docTypes includes 'diagrams'`                                       |
   | `businessRulesDir` | path           | `docs/business-logic`                 | probe-prefilled; `showWhen: includes 'business-rules'`; matches the business-documenter default |
   | `scopeHint`        | textarea       | empty                                 | optional "which services/areas" steer for the analyst                                           |
   | `humanReview`      | checkbox       | **false**                             | maps to the gate-override seam                                                                  |
   | `styleFragments`   | checkbox-group | `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` | options from the Writing-style fragment category                                                |

   READMEs get no placement field — they live beside the code by convention; the planner
   decides per-item `targetPath`s.

10. **Detection** — new pure `docs-detect.logic.ts` over `RepoFiles` (prior art:
    `provision-detect.logic.ts`): bounded (~10 `listDirectory` calls, no file reads beyond
    root workspace manifests), never throws. Root `docs/` + `README.md`; monorepo markers
    (`pnpm-workspace.yaml`/`lerna.json`/`turbo.json`, or sampled `packages|apps|services`
    children) → `placementMode` default (`per-service` when most sampled packages carry their
    own `docs/`); known dir names (`diagrams|architecture` → `diagramsDir`,
    `business-logic|business|domain` → `businessRulesDir`); an "existing mermaid" flag for
    the analyst. Detected values are **form defaults**; user overrides win; both freeze on
    `presetInputs` at create. The analyst confirms/refines placement during planning and
    records `decisions` when it deviates — it never silently rewrites the inputs
    (hybrid: deterministic probe-first, LLM confirmation at planning time).
11. **Planning** — `pl_initiative_docs` =
    `[initiative-analyst, initiative-planner, initiative-committer]`, gates all false (no
    interviewer — the form is the interview; review opt-in via the override seam). Prompt
    additions make the analyst a **documentation gap-auditor**: inventory existing docs per
    checked type × per service/module, compare against the implementation, classify each as
    missing/stale/adequate. Planner shaping (prompt additions + `seedPlan` enforcement):
    phase 1 "Foundations" (create/normalize missing placement dirs, usually 0–1 items), then
    one phase per checked doc type; bounded item granularity — README: one item per service;
    diagrams: one item per service (architecture + key flows); in-source comments: one item
    per worst-N module from the audit (cap ~5); business rules: one item per domain area.
    Each item's `spawn` bag carries `taskTypeFields.targetPath` (placement-derived),
    `fragmentIds` (the `styleFragments` input), `pipelineId` per the table below, and gate
    overrides when `humanReview` is on.
12. **Spawned pipelines / agent kinds:**

    | Item type          | Agent path                                                                                                                       | Pipeline                                                                     |
    | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
    | README refresh     | reuse `doc-writer` (+ `doc-quality` gate; `targetPath` override)                                                                 | `pl_document_quick`                                                          |
    | Business rules     | reuse `business-documenter` (placement passed via `targetPath`, turning its LLM-judgment default deterministic)                  | new lean `pl_business_docs` = `[business-documenter, conflicts, ci, merger]` |
    | Mermaid diagrams   | NEW `diagram-author` (container-coding): reads the code, authors/updates mermaid docs under `diagramsDir`, opens a PR            | new `pl_diagrams` = `[diagram-author, doc-reviewer, conflicts, ci, merger]`  |
    | In-source comments | NEW `code-commenter` (container-coding): adds/clarifies why-not-what comments, no behaviour change — the CI tail is load-bearing | new `pl_code_comments` = `[code-commenter, conflicts, ci, merger]`           |

    Minimal new-kind set: two. Merge policy is deliberately left to the workspace's merge
    preset (`autoMergeEnabled` etc. not overridden) — merge stays a workspace concern.

13. **Sync semantics** — one-shot: completion = every item settled (PRs merged). Re-run by
    re-creating from the preset.

## Gap analysis

| #   | Gap                                                                                                                   | Covered by slice |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| G1  | No form descriptors beyond `select` (`AgentConfigDescriptor`) / flat `ProviderConfigField`; no conditional visibility | S1, S4           |
| G2  | No per-run gate control — gates are baked into the pipeline                                                           | S2               |
| G3  | Planning pipeline hardcoded to `pl_initiative` in the SPA; no preset entity fields                                    | S1, S3           |
| G4  | `buildTaskBlock` stamps only `estimate` — spawned tasks can't be typed doc tasks                                      | S5               |
| G5  | No deterministic docs-folder/monorepo-placement detection                                                             | S6               |
| G6  | No mermaid-authoring or in-source-comments agent kinds                                                                | S7               |
| G7  | No registrable initiative-preset concept at all                                                                       | S1, S8, S9       |

## Per-slice status checklist

| #   | Slice                                                                                                                                                                                                                                                    | Scope  | Status  | PR     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- | ------ |
| 0   | This tracker                                                                                                                                                                                                                                             | —      | ✅ done | (this) |
| 1   | Preset contracts (`initiative-preset.ts`: fields incl. `checkbox-group`/`path`/`showWhen`, descriptor, inputs) + kernel `registerInitiativePreset` registry + `preset_generic` + entity/draft schema extensions (`presetId`/`presetInputs`/item `spawn`) | SYSTEM | ✅ done | #812   |
| 2   | Per-run gate-override engine seam (`ExecutionService.start` override → run steps; loop threads `spawn.gates`) + conformance on both runtimes                                                                                                             | SYSTEM | ✅ done | #880   |
| 3   | Create/planning integration: create validation + qa/goal seeding for skip-interview presets, probe endpoint, snapshot attach (both facades), `AgentContextBuilder` preset folds, SPA starts `descriptor.planningPipelineId`                              | SYSTEM | ⬜ todo |        |
| 4   | SPA preset picker + generic descriptor form renderer (checkbox-group/path/showWhen) + probe prefill + i18n chrome                                                                                                                                        | SYSTEM | ⬜ todo |        |
| 5   | Loop/ingest glue: `buildTaskBlock` spawn decoration, `seedPlan` invocation at ingest, path-safety validation, conformance round-trip                                                                                                                     | SYSTEM | ⬜ todo |        |
| 6   | `docs-detect.logic.ts` (pure over `RepoFiles`) + unit tests (monorepo/root/dir-name heuristics, bounded budget, never-throw)                                                                                                                             | PILOT  | ⬜ todo |        |
| 7   | New kinds `diagram-author` / `code-commenter` (prompts, presentation, doc-aware trait) + `pl_diagrams` / `pl_code_comments` / `pl_business_docs`                                                                                                         | PILOT  | ⬜ todo |        |
| 8   | `preset_docs_refresh` registration: descriptor (form), `detect` = S6, `seedPlan`, promptAdditions (analyst audit + planner shaping), review mapping, `pl_initiative_docs`                                                                                | PILOT  | ⬜ todo |        |
| 9   | E2E (create-with-preset → auto-plan → spawn-with-decoration) + worked-example custom preset + `backend/docs/initiative-presets.md` + cross-doc updates                                                                                                   | BOTH   | ⬜ todo |        |

Ordering: 1 → {2, 3} → {4, 5}; 6–8 need 1+3; 7 is independent of 6.

## Conventions & gotchas (carry between iterations)

- **Keep the runtimes symmetric.** The entity fields ride the `doc` blob (symmetric by
  construction), but the gate-override seam and spawn decoration need explicit conformance
  assertions on both runtimes in the SAME slice that lands them.
- **The loop stays preset-agnostic.** All deviation is data on the entity/items (`spawn`
  bags, inputs, prompt additions); preset code hooks run only at create (`detect`) and
  ingest (`seedPlan`) time. Never branch `InitiativeLoopService` on a preset id.
- **No N+1 in detection.** `detect` has a hard bounded `listDirectory` budget and never
  throws; unwired GitHub ⇒ `{}` ⇒ descriptor defaults. Prefill must never block create.
- **Descriptor labels are backend-supplied English**; only the surrounding chrome is i18n
  (the `describeConfig` convention from `descriptor-driven-infra-forms.md`).
- **Preset inputs freeze after create** (the `agentConfig` freeze precedent). The analyst
  records placement deviations as `decisions`; it never rewrites `presetInputs`.
- **`showWhen` is single-condition by design.** Resist growing it into a recursive schema
  renderer — that's the descriptor-forms initiative's separate "generic recursive field
  renderer" line item.
- **Absent `presetId` must stay byte-for-byte today's behaviour** (old clients, public API).
  `preset_generic` is the strangler wrapper, not a behaviour change.
- **Changesets per touched package** (contracts, kernel, orchestration, agents, server, app,
  facades), and any new package rows in README tables per the repo checklist.
- **[S1] The preset-inputs schemas live in `contracts/src/initiative.ts`, NOT
  `initiative-preset.ts`** — the entity (`presetInputs`, item `spawn`) references them, and
  `initiative-preset.ts` imports `initiativeExecutionPolicySchema` back FROM `initiative.ts`, so
  putting inputs in the preset file would be a runtime valibot import cycle. `initiative-preset.ts`
  imports the inputs shape from `initiative.js`; there is no reverse import.
- **[S1] The descriptor's `probe` flag is DERIVED, not author-supplied.** Registrations carry the
  `detect` code hook; `initiativePresetDescriptors()` (kernel) sets `probe: !!detect` when it
  serialises for the snapshot (the `supportsTest` convention). Slice 3's snapshot attach should
  call `initiativePresetDescriptors()`, not read `descriptor.probe` from the registration.
- **[S1] `preset_generic` is a built-in default the registry always resolves** (even after
  `clearRegisteredInitiativePresets`), prepended by `allInitiativePresets()` unless a registration
  overrides its id. `getInitiativePreset('preset_generic')` never returns undefined.
- **[S1] Create-flow input validation is `validateInitiativePresetInputs(descriptor, inputs)`**
  (contracts, pure, returns `string[]` — empty ⇒ valid). Slice 3 maps a non-empty result to one
  `ValidationError`; it already enforces unknown-key/type/options/required-visible/path-safety.
- **[S2] The gate override is a FULL boolean array indexed by the pipeline's ORIGINAL step index**
  (parallel to `pipeline.gates`, length = `pipeline.agentKinds.length`), NOT a sparse patch:
  `ExecutionService.start(…, gatesOverride?)` applies `gatesOverride?.[i] ?? pipeline.gates?.[i] ??
false` per step, so an override entry of `false` genuinely turns a pipeline gate OFF (it isn't
  a "leave as-is"). Slice 8's review mapping must therefore emit the WHOLE array (compute it from
  the pipeline's own gate positions + the `humanReview` choice), not just the gates it wants to flip.
- **[S2] The override needs NO separate persistence.** It is copied onto the run's steps'
  `requiresApproval` at start, and retry/restart rebuild from the STORED steps (`planResumedSteps`/
  `resetStep` preserve `requiresApproval`), so a resumed run keeps the override for free — do not add
  a `gates` column/field to the run.
- **[S2] The loop threads `item.spawn?.gates`, nothing else, in slice 2.** The rest of the `spawn`
  bag (`taskTypeFields`/`fragmentIds`/`agentConfig`) is slice 5's `buildTaskBlock` decoration; keep
  them separate so the two slices don't entangle.
- **[S2] Conformance for an engine seam with no HTTP surface goes through a harness probe.** The
  gate override isn't (and shouldn't be) exposed on `POST /blocks/:id/executions`, so the suite calls
  it via a new `ConformanceApp.startExecution(ws, block, pipeline, { gates })` probe (each facade
  wires it to `container.executionService.start`). Reuse that probe for any future start-time seam a
  preset needs rather than widening the public start endpoint.

## Out of scope

- **Recurring drift-watch** (a `pl_docs_drift` recurring pipeline that periodically re-audits
  and spawns fix tasks) — the natural follow-up once one-shot refresh is proven.
- **Data-only / DB-authored custom presets** (UI-authored, no code hooks) — the descriptor/
  hook split keeps the pure-JSON subset expressible; revisit when a non-code tenant needs it.
- **Public API preset exposure** (`POST /api/v1/initiatives` accepting `presetId`).
- **Mermaid syntax validation** (a `doc-quality` extension or deterministic gate).
- **Migrating the generic initiative's interview into descriptor fields.**

## Open questions

- **Monorepo scope selection**: is the free-text `scopeHint` enough, or should the probe
  populate a per-service multi-select (heavier probe, nicer UX)? Decide during S4/S8.
- **Should spawn-time gate overrides surface in the task inspector UI** (so a human can see
  why a spawned task does/doesn't pause)? **Resolved (S2): no bespoke UI.** The override is
  copied onto the run's steps' `requiresApproval`, which the existing run/step detail already
  renders as per-step approval gates — a spawned task shows exactly the gates it will pause on,
  with no new surface. Revisit only if a preset needs to explain the mapping's _rationale_.
