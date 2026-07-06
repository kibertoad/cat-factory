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

Everything in the preset system is generic; docs-refresh is the pilot the way acme-monolith
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

    | Item type          | Agent path                                                                                                                                                                                            | Pipeline                                                                     |
    | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
    | README refresh     | reuse `doc-writer` (+ `doc-quality` gate; `targetPath` override)                                                                                                                                      | `pl_document_quick`                                                          |
    | Mermaid diagrams   | reuse `doc-writer` — a Mermaid `.md` is a document a writer produces; its `container-coding` clone already reads the code. Steer via the brief / a `diagrams` `docKind` (see the S8 doc-quality note) | `pl_document_quick`                                                          |
    | Business rules     | reuse `business-documenter` (placement passed via `targetPath`, turning its LLM-judgment default deterministic)                                                                                       | new lean `pl_business_docs` = `[business-documenter, conflicts, ci, merger]` |
    | In-source comments | NEW `code-commenter` (container-coding): adds/clarifies why-not-what comments, no behaviour change — the CI tail is load-bearing                                                                      | new `pl_code_comments` = `[code-commenter, conflicts, ci, merger]`           |

    Minimal new-kind set: **one** (`code-commenter`) — the only capability no existing kind has: an
    in-place, comment-only edit of existing source. `doc-writer`'s contract is "write a new doc, do
    not touch code", and `coder`'s whole role is to change code, so neither can express it. Diagrams
    looked like a second new kind, but a Mermaid diagram doc is just Markdown a writer produces, so
    `doc-writer` covers it — a dedicated `diagram-author` + `pl_diagrams` were dropped in S7's design
    review (they'd have been a prompt wearing a pipeline costume). Merge policy is deliberately left
    to the workspace's merge preset (`autoMergeEnabled` etc. not overridden) — merge stays a
    workspace concern.

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
| G6  | No in-source-comments agent kind (Mermaid diagrams reuse `doc-writer`, so no diagram kind needed)                     | S7               |
| G7  | No registrable initiative-preset concept at all                                                                       | S1, S8, S9       |

## Per-slice status checklist

| #   | Slice                                                                                                                                                                                                                                                                                   | Scope  | Status  | PR     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- | ------ |
| 0   | This tracker                                                                                                                                                                                                                                                                            | —      | ✅ done | (this) |
| 1   | Preset contracts (`initiative-preset.ts`: fields incl. `checkbox-group`/`path`/`showWhen`, descriptor, inputs) + kernel `registerInitiativePreset` registry + `preset_generic` + entity/draft schema extensions (`presetId`/`presetInputs`/item `spawn`)                                | SYSTEM | ✅ done | #812   |
| 2   | Per-run gate-override engine seam (`ExecutionService.start` override → run steps; loop threads `spawn.gates`) + conformance on both runtimes                                                                                                                                            | SYSTEM | ✅ done | #880   |
| 3   | Create/planning integration: create validation + qa/goal seeding for skip-interview presets, probe endpoint, snapshot attach (both facades), `AgentContextBuilder` preset folds, SPA starts `descriptor.planningPipelineId`                                                             | SYSTEM | ✅ done | #883   |
| 4   | SPA preset picker + generic descriptor form renderer (checkbox-group/path/showWhen) + probe prefill + i18n chrome                                                                                                                                                                       | SYSTEM | ✅ done | #886   |
| 5   | Loop/ingest glue: `buildTaskBlock` spawn decoration, `seedPlan` invocation at ingest, path-safety validation, conformance round-trip                                                                                                                                                    | SYSTEM | ✅ done | #890   |
| 6   | `docs-detect.logic.ts` (pure over `RepoFiles`) + unit tests (monorepo/root/dir-name heuristics, bounded budget, never-throw)                                                                                                                                                            | PILOT  | ✅ done | #894   |
| 7   | New kind `code-commenter` (prompt, presentation, doc-aware) + `pl_code_comments` / `pl_business_docs`; diagrams + READMEs reuse `doc-writer`/`pl_document_quick` (a Mermaid doc is just Markdown — no diagram kind)                                                                     | PILOT  | ✅ done | #903   |
| 8   | `preset_docs_refresh` registration: descriptor (form), `detect` = S6, **`phaseTemplate`** (shape enforcement — reuse T1/T2, see the inter-phase follow-up), `seedPlan` (spawn DECORATION only), promptAdditions (analyst audit + planner shaping), review mapping, `pl_initiative_docs` | PILOT  | ✅ done | #911   |
| 9   | E2E (create-with-preset → auto-plan → spawn-with-decoration) + worked-example custom preset + `backend/docs/initiative-presets.md` + cross-doc updates                                                                                                                                  | BOTH   | ⬜ todo |        |

Ordering: 1 → {2, 3} → {4, 5}; 6–8 need 1+3; 7 is independent of 6.

**Downstream consumers:** the technological-migration preset
([`tech-migration-preset-and-mssql-postgres-pilot.md`](./tech-migration-preset-and-mssql-postgres-pilot.md))
hard-depends on the remaining **S8** (its registration copies the pattern S8 pioneers)
and **S9** (its E2E extends the baseline), and has already landed generic phase-template
machinery (T1 #895 / T2 #900) on S5's ingest hook — reprioritizing or re-scoping those
slices affects that tracker's critical path.

## Inter-phase follow-ups (read before starting S8)

Two items surfaced in S7's design review. Neither blocks S7 landing; both shape S8.

1. **Adopt the generic `phaseTemplate` shape enforcement for `preset_docs_refresh` (do it in S8;
   do NOT hand-roll phase shaping in `seedPlan`).** — ✅ done in S8 (#911): `preset_docs_refresh`
   declares a `phaseTemplate` (Foundations `required` + optional per-doc-type phases,
   `allowAdditionalPhases: false`) and `seedPlan` does per-item DECORATION only; see the [S8] gotchas.
   The technological-migration initiative landed a
   generic initiative-preset capability we should reuse: **T1** (#895) added
   `InitiativePresetDescriptor.phaseTemplate` (`initiativePresetPhaseTemplateSchema`,
   `contracts/src/initiative-preset.ts`) + a planner prompt fold that renders a "required plan
   shape"; **T2** (#900) added the pure ingest normalizer `normalizeDraftAgainstPhaseTemplate`
   (orchestration `initiative.logic.ts`), wired into `InitiativeService.seedPlanDraft` **ahead of**
   the `seedPlan` hook — it matches planned phases to template phases by `id` VERBATIM, reorders
   them into template order, and rejects a missing `required` phase / a disallowed extra.
   - **Validated relevant.** S8 had planned to enforce the docs-refresh plan shape (phase 1
     "Foundations", then one phase per checked doc type) inside `seedPlan`. That is exactly what
     `phaseTemplate` now does generically, and T2's governing gotcha is explicit: **shape lives in
     `phaseTemplate`, DECORATION lives in `seedPlan` — never entangle them.** So S8 declares a
     `phaseTemplate` for the plan shape and keeps `seedPlan` for the per-item spawn decoration ONLY.
   - **Fits the input-dependent phases.** docs-refresh phases vary with the user's `docTypes`
     selection, but the template is a STATIC descriptor field — which still fits: mark `foundations`
     `required: true` and each per-doc-type phase (`readme` / `diagrams` / `comments` /
     `business-rules`) OPTIONAL, with `allowAdditionalPhases: false`. The planner (steered by the
     checked-types prompt additions) emits only the checked phases; the normalizer tolerates an
     omitted OPTIONAL phase and still rejects unknown extras / a missing Foundations. Template phase
     ids must match VERBATIM the ids the planner emits (the T1 contract).
   - **S8 doc-quality note (diagrams via `doc-writer`).** Because diagrams reuse `pl_document_quick`
     (which includes the `doc-quality` gate), give diagram items a `diagrams` `docKind` (or `other`)
     whose template's required sections suit a diagram doc — otherwise the prose-oriented
     required-section check would flag a perfectly good diagram document.

2. **Templated pipelines — deferred (a separate initiative, not part of this one).** S7 collapsed
   the near-identical spawn pipelines to the minimum by reusing existing kinds, but the recurring
   shape is "one pipeline, one step swapped for a variant agent" (`[<author>, conflicts, ci,
merger]`). A first-class **pipeline template with a slot/swappable step** would express that
   directly and is the correct model when variations are different KINDS (which the per-step
   `agentConfig` mode-param can't unify). It is NOT worth building for the handful of doc pipelines:
   the only thing shared is the universal `conflicts → ci → merger` tail that EVERY catalog pipeline
   already shares, and the change is cross-cutting — the `Pipeline` contract, both runtimes'
   `pipelines` persistence + mappers, `ExecutionService.start` slot resolution, the SPA pipeline
   editor + task form, `validatePipelineShape` / `usePipelineHealth`, reseed/versioning, and
   conformance — a dedicated initiative in its own right. Build it only if variant-pipeline
   proliferation becomes real (many near-identical built-ins, or users authoring variants); until
   then the docs-refresh spawn simply stamps a concrete `pipelineId` per doc type.

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
- **[S3] The snapshot `initiativePresets` is attached in the SHARED `WorkspaceController`** (both the
  GET + POST handlers) via `initiativePresetDescriptors()` — a MODULE-GLOBAL read, so there is NO
  per-facade wiring (unlike a container-instance registry like `agentKindRegistry`). Both facades
  pick it up for free; the conformance suite asserts the generic preset is present on both.
- **[S3] The probe endpoint lives in the CONTROLLER, not a service.** It mirrors
  `ServiceSpecController`: it reads `container.resolveRunRepoContext` (a server-layer seam, absent →
  `{}`), runs `getInitiativePreset(id)?.detect(ctx.repo)`, and returns `{}` on EVERY non-happy path
  (unknown preset / no `detect` / GitHub unwired / resolver throws / detect throws). It never blocks
  create. Do NOT thread `resolveRunRepoContext` into `InitiativeService` — the seam is on
  `ServerContainer`, not the orchestration `Core`.
- **[S3] Only a resolved preset persists inputs, and only its SANITIZED subset.**
  `InitiativeService.create` freezes `presetInputs` ONLY when the `presetId` resolves, and only the
  `sanitizeInitiativePresetInputs` subset (known + currently-VISIBLE fields). So a form posted with
  no `presetId` is dropped, and a hidden (`showWhen`-failed) field — whose value
  `validateInitiativePresetInputs` deliberately skips — can never freeze an unvalidated value (e.g. a
  `path` escaping the repo). The seeding + prompt fold read the sanitized inputs, so what's frozen,
  seeded, and steered stay in lockstep.
- **[S3] Skip-interview seeding: the FORM is the interview.** `InitiativeService.create` seeds `qa`
  from the sanitized form via the pure `seedPresetInterviewQa` (one answered exchange per VISIBLE,
  FILLED field; label → option-label-mapped value via the shared `renderInitiativePresetValue`), so
  the existing `initiativeContextLines` + tracker digest surface it with no interviewer step.
  "Filled" mirrors `validateInitiativePresetInputs`' present-rule — an unchecked (`false`) checkbox /
  empty string / empty multi-select is NOT seeded. The goal is templated
  `input.description?.trim() || descriptor.presentation.description` (the human's description wins).
  Only `interview: 'skip'` presets seed; `full`/absent-preset ⇒ today's behaviour.
- **[S3] The preset context fold is per-kind and generic-safe.** `AgentContextBuilder` folds
  `preset {label, promptAddition}` onto `AgentRunContext.initiative` ONLY when the RUNNING kind has a
  (trimmed, non-empty) `promptAdditions[agentKind]`; `initiativeContextLines` renders it verbatim.
  The generic preset registers none, so `preset` stays absent and the generic planning prompt is
  byte-for-byte unchanged even when `presetId: 'preset_generic'` is set. The frozen form reaches the
  prompt via the seeded `qa`, NOT a second copy on the context.
- **[S3] Valibot-default fields are REQUIRED in the InferOutput.** `InitiativePresetDescriptor`
  requires `defaultFragmentIds` and `CreateInitiativeInput` requires `description` (both carry a
  valibot default), so code/test literals must supply them even though they're optional on the wire
  (InferInput). Slice 4's create call sends the InferInput shape (both optional); the service sees the
  defaulted output.
- **[S4] The form renderer is a controlled component over the TYPED inputs.**
  `InitiativePresetFields.vue` takes the descriptor + a `v-model` of `InitiativePresetInputs` and
  keeps values typed (`checkbox-group` → `string[]`, `checkbox` → boolean, `number` → number, else
  string), NOT the flat string map `ProviderConnectionTab` uses — so it feeds the shared
  `validateInitiativePresetInputs`/`sanitizeInitiativePresetInputs` directly with no coercion. A
  slice-8 field type outside this switch renders as a plain text input, so keep new field kinds to
  the eight the contract declares (extend the contract picklist + this switch together).
- **[S4] Defaults live in `defaultPresetInputs` (`utils/initiative.ts`), applied by the MODAL, not
  the renderer.** The renderer is pure/stateless; the modal seeds defaults on open + preset-change,
  then layers the probe prefill, then the user's edits. Only meaningful defaults are seeded (an
  unchecked box / empty string / empty multi-select stays ABSENT), so the frozen inputs never carry
  an empty value. The renderer's `set` enforces the same invariant on EDITS — clearing a field
  (blank string / empty multi-select / unchecked box) drops the key rather than storing `''`/`[]`/
  `false`, so `sanitize` can't freeze an empty value onto the entity (a numeric `0` is kept). A
  slice-8 `default`/`defaultValues` on a descriptor field is what surfaces here.
- **[S4] The picker defaults to `preset_generic` and hides itself when only that preset exists**, so
  a stock install is byte-for-byte today's form. The modal ALWAYS sends `presetId` (generic when
  unpicked) — safe because the server always resolves `preset_generic`. When slice 8 registers
  `preset_docs_refresh`, the picker appears (>1 preset) and its fields render with no modal change.
- **[S4] Probe prefill is stale-guarded and best-effort.** The modal fires `probePreset` on
  preset/frame selection behind a monotonic token and only merges detected values for KNOWN field
  keys over the defaults; a slow response from a since-changed preset is discarded, and any error
  degrades to `{}` (defaults) — the probe never blocks or clears the form. A detected value
  overrides the seeded DEFAULT but not a USER edit: the merge only fills a key still equal to its
  pre-probe baseline, so a slow probe can't clobber a value typed while it was in flight.
- **[S4] `showWhen: { equals: false }` matches an unchecked box.** Because an off checkbox stays
  ABSENT (above), `isPresetFieldVisible` (`@cat-factory/contracts`) reads an absent value as `false`
  when the condition compares a boolean — so a field gated on an off box shows at first render, not
  only after a toggle on→off. Both facades' validate/sanitize inherit this via the shared function.
- **[S5] `seedPlan` runs in `InitiativeService.ingestPlan`, resolved from the FROZEN entity, and its
  output is RE-PARSED.** The preset comes from `initiative.presetId`/`presetInputs` (frozen at
  create, never mutated), so it's read once via `getByBlock` OUTSIDE the CAS `mutate` — safe because
  `seedPlan` is pure, so its result is a deterministic function of `(draft, frozen inputs)` and stays
  replay-safe/idempotent. The hook output goes back through `parseInitiativePlanDraft`, which is the
  path-safety story: an unsafe spawn `targetPath` (from a hook OR the planner's raw draft) fails
  `taskTypeFieldsSchema`'s `isSafeDocPath` check at the trust boundary — there is NO separate
  path-validation pass, and slice 8's `seedPlan` needs none. `assertPipelinesExist` runs on the
  SEEDED draft (so a `seedPlan` that adds `pipelineId`s is still checked).
- **[S5] `buildTaskBlock` folds `spawn.{taskType,taskTypeFields,fragmentIds,agentConfig}` sparsely**
  (empty bag omitted), mirroring `BoardService.addTask`, so a decoration-less item stays
  byte-identical to the pre-slice-5 block. `spawn.taskType` is REQUIRED for a typed spawn to
  classify correctly: `taskType` (not `taskTypeFields`) is what keys the per-type task limit
  (`ExecutionService`) and the SPA's document affordances (the inspector doc-repo picker), so a
  `document` item that stamped only `taskTypeFields` would still count as a `feature` and hide the
  picker — hence the `taskType` field on `initiativeItemSpawnSchema`. A `document`-typed spawn with
  no explicit `fragmentIds` inherits `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS`, exactly as `addTask`
  seeds them. `spawn.gates` was already threaded in slice 2; the rest lands here. `applyPlanDraft`
  now carries `d.spawn` onto the persisted item (like the other draft content fields) — that's the
  wire from the planner draft to the loop's block builder.
- **[S5] The spawn bag rides the `doc` blob** (symmetric by construction), but the convention still
  demands an explicit conformance assertion for it — added to `initiative-suite.ts`. The spawned
  BLOCK's decoration fields (`taskType`/`taskTypeFields`/`fragmentIds`/`agentConfig`) are already
  covered by the block-store parity assertions, so slice 5 only adds the item-`spawn` round-trip.
- **[S7] Only `code-commenter` is a NEW kind — do not re-add a diagram kind.** S7's design review
  found diagrams need no new kind: a Mermaid diagram doc is Markdown a `doc-writer` produces (its
  `container-coding` clone already reads the code), so diagrams + READMEs reuse `doc-writer` /
  `pl_document_quick` and business rules reuse `business-documenter` / the lean `pl_business_docs`.
  `code-commenter` (agents `kinds/code-commenter.ts`) is the ONLY genuinely-new capability — an
  in-place, comment-only edit of existing source, which `doc-writer` ("never touch code") and
  `coder` ("change code") both structurally cannot express. It rides the generic `container-coding`
  work-branch lifecycle (no harness handler, no image bump), is `doc-aware`, and — like every
  side-effect kind — must NOT carry `FINAL_ANSWER_IN_REPLY`. Its pipeline's `ci` step is
  load-bearing (it proves the diff is behaviour-neutral). The "one pipeline, swap one step" itch S7
  raised is the deferred templated-pipelines follow-up above — resist re-adding per-type kinds.
- **[S8] The preset SELF-REGISTERS as a module side effect of `@cat-factory/agents`** (the
  `@cat-factory/gates` pattern: `registerDocsRefreshPreset()` at the bottom of
  `agents/src/presets/docs-refresh/preset.ts`, re-exported from the agents index so importing the
  package evaluates it). This is the sanctioned wiring for a BUILT-IN registered through the
  module-global preset seam — NO per-facade `registerInitiativePreset` call, so the two runtimes
  cannot drift on it (unlike a container-instance registry, which needs symmetric per-facade wiring).
  T8's `preset_tech_migration` copies this exactly. (A DEPLOYMENT preset registers from its own
  composition root instead — the `example-custom-agent` model.)
- **[S8] Plan SHAPE lives in `phaseTemplate`, DECORATION in `seedPlan` — never entangled** (the
  T1/T2 governing gotcha, realised here). The descriptor declares `foundations` `required: true` +
  each per-doc-type phase (`readme`/`diagrams`/`comments`/`business-rules`) OPTIONAL with
  `allowAdditionalPhases: false`; the generic ingest normalizer enforces it. `seedPlan` NEVER touches
  phases — it only stamps each item's `pipelineId` + `spawn` bag keyed off the item's `phaseId`. The
  planner emits only the checked doc types' phases (steered by the promptAdditions); the normalizer
  tolerates the omitted optional phases.
- **[S8] `humanReview` maps to the SPAWNED-task gates ONLY; the planning run is unattended.**
  `pl_initiative_docs` has NO human gate and is started via the plain execution endpoint, which
  deliberately takes no gate override ([S2]/[S3]: gates are not exposed on HTTP). So the docs-refresh
  "review" gate is on each produced doc PR, not the plan: `seedPlan` reads the frozen
  `presetInputs.humanReview` and emits `spawn.gates` (threaded by the loop through the slice-2 seam).
  The pure `docsReviewGates(pipelineId, humanReview)` emits the FULL per-pipeline boolean array (the
  [S2] whole-array rule), gating the **`merger`** step so the human reviews the CI-green PR right
  before it merges — the same review point for every doc pipeline, matching the form's "review each
  documentation change before it merges" promise (NOT a mid-pipeline `doc-reviewer` gate that would
  still auto-merge afterwards). The placement is DERIVED from the pipeline's `agentKinds` (the
  `merger` index), so the override is parallel to the pipeline by construction rather than a
  hand-maintained array — a `preset.test.ts` guard asserts exactly one `true`, on the merge step,
  length-matched to `agentKinds` (a mismatch would fail the spawn's `ExecutionService.start` check).
- **[S8] Only a DERIVABLE single-file `.md` path gets a `targetPath`; everything else is placed
  from the item DESCRIPTION.** `targetPath` is `.md`-only (`isSafeDocPath`) and single-file, and —
  crucially — `seedPlan` can only ever set a path it DERIVES itself, because the planner's structured
  output has no `spawn` field (`INITIATIVE_PLANNER_SYSTEM_PROMPT`) so `coerceInitiativePlan` never
  carries a planner-authored path through to the hook. So `seedPlan` derives `<docsRoot>/<slug>.md`
  for `foundations` and `<diagramsDir>/<slug>.md` for `diagrams` (each **deduplicated** via
  `uniqueDocPath`, so two same-slug titles never collide on one file). `readme` (its per-service path
  is beside the code — un-derivable here), `code-commenter` (a module DIR) and `business-documenter`
  (MANY docs under a dir) all name their placement in the planner-authored DESCRIPTION and carry NO
  `targetPath` — the writer places them. (So `code-commenter`'s S7 `targetPath` reader is dormant for
  docs-refresh — expected.)
- **[S8] Diagrams reuse `doc-writer` with `docKind: 'other'` — no new `diagrams` DocKind.** Adding a
  `diagrams` value to `DOC_KINDS` (contracts) would ripple into the frontend doc-kind labels + the
  i18n locale-parity gate for no real gain. The inter-phase note's "or `other`" path is taken: the
  planner brief steers an Overview + the diagrams so the `doc-quality` `other` template
  (Overview + Details required sections) accepts a diagram doc. Revisit only if diagram docs start
  failing `doc-quality` in practice.

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
