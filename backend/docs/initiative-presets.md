# Initiative presets: a form + a plan shape + typed spawned tasks, no fork

> **Authoring a preset is on the website**:
> [Register an Initiative Preset](https://www.catfactory.ai/extend/initiative-presets.html) owns
> the seam, the four parts, the create-time form, the mandated plan shape and the checkpoint /
> cross-phase-artifact rules; [Run an Initiative](https://www.catfactory.ai/guide/initiatives.html)
> owns what a user sees. This page is what the ENGINE does with a registration.

An **initiative preset** turns the open-ended Initiative feature into a task-shaped one: a
preset bundles a create-time **form**, a **planning-pipeline binding**, a declarative
**plan shape**, per-agent-kind **prompt steering**, and **spawn decoration** so the tasks
the initiative loop produces come out as first-class typed tasks. A deployment registers its
own presets through one public seam, exactly like a custom agent kind, with no engine
change and no per-facade wiring.

> This document is the model + the seams. The pilot is the built-in **Documentation-refresh**
> preset (`@cat-factory/agents`); the worked deployment example is
> `backend/internal/example-custom-agent`'s `preset_org_audit`. The durable design trackers are
> [ADR 0016](./adr/0016-initiative-presets.md)
> (the system + the docs-refresh pilot) and
> [ADR 0014](./adr/0014-tech-migration-preset.md)
> (a second consumer). For the generic Initiative feature this builds on, see
> [ADR 0013](./adr/0013-initiatives-feature.md).

## Why presets exist

The generic Initiative runs one fixed pipeline, `pl_initiative`
(`initiative-analyst → initiative-interviewer → initiative-planner → initiative-committer`,
human approval after the planner), then executes the approved plan as a loop of spawned
tasks. That shape fits open-ended refactors, where an **interview** is how the goal gets
pinned down. It does NOT fit **task-shaped initiatives** whose inputs are known up front and
enumerable as a form: "refresh this service's documentation", "migrate this database
engine", "audit every service against the org policy". For those, the interview is friction,
the plan shape is predictable, and the run should mostly be unattended.

A preset encodes exactly that difference **declaratively**, without a bespoke pipeline or a
`switch` on the initiative kind anywhere in the loop.

### The boundary: a preset PLANS, a reusable operation does not

A preset is the vehicle when the work must be **decomposed**: phases, many spawned items,
checkpoints between them. When the create-form answers are the whole per-case brief and ONE
pipeline delivers one outcome, the vehicle is a **reusable operation** instead: a custom task type
bundling its form, its standing-context fragments and its own canned pipeline, so one invocation is
one typed task. See [`reusable-operations.md`](./reusable-operations.md), which shares this
document's field vocabulary (`contracts/src/form-fields.ts`) and its `DescriptorFields.vue`
renderer. Stretching a preset to cover a single-task operation adds an interview, a planner and a
plan ingest for a plan of one.

## The governing principle

> **The loop never branches on a preset id.** Every deviation is either serialisable
> descriptor DATA (the form, the plan shape, the defaults) or a small CODE hook that runs at
> two well-defined moments: create (`detect`) and plan ingest (`seedPlan`). The execution
> loop, the planner, and the committer are preset-agnostic; a preset only ever ADDS context.

`preset_generic` is the strangler wrapper: it declares an empty form, binds `pl_initiative`,
and registers no hooks, so an initiative with no preset (or `preset_generic`) behaves
byte-for-byte as it always has.

## The seam

One registration on the app-owned `InitiativePresetRegistry`, injected through
`createApp({ overrides })` on the Worker and the `initiativePresetRegistry` option on `start()` /
`startLocal()`. The registration's four parts (`descriptor`, `detect`, `seedPlan`,
`promptAdditions`), the field vocabulary and the worked example are on the website page above.

Two things about the DESCRIPTOR that are facts about this codebase rather than about authoring:

- **`descriptor` is the serialisable half**, defined in `@cat-factory/contracts`
  (`initiative-preset.ts`) and attached to the workspace snapshot, so it must stay pure data. A
  field that cannot cross the wire belongs in one of the two hooks.
- **`descriptor.probe` is DERIVED server-side** (`!!detect`), never author-supplied, so there is no
  flag that can disagree with whether the hook exists.

Inputs are validated and sanitised against the descriptor at create by two pure functions in
`@cat-factory/contracts`, `validateInitiativePresetInputs` (unknown keys, type mismatch, required
visible fields, options membership, path safety) and `sanitizeInitiativePresetInputs` (keeps only
declared and currently-visible fields). The sanitized subset is FROZEN on the entity's
`presetInputs` at create and never mutated; the analyst records placement and scope deviations as
`decisions`, it never rewrites the inputs. The field types themselves extend the
`ProviderConfigField` family the infra forms use, which is what lets the SPA render a preset's form
with zero per-preset frontend code, and it is why adding a field type is a change to that shared
vocabulary rather than to this feature.

### The plan shape (`phaseTemplate`): what enforces it

A preset declares its phases on the descriptor (website page). Two pieces of GENERIC machinery
enforce the declaration, and neither knows a preset id:

1. **Planner prompt fold**: `AgentContextBuilder` renders a "required plan shape" section into the
   planning kinds' prompts (phase ids VERBATIM, titles, goals, order, and whether extras are
   allowed) when the resolved preset declares a template. No template means the prompt is
   byte-for-byte unchanged.
2. **Ingest normalization**: `normalizeDraftAgainstPhaseTemplate` runs inside
   `InitiativeService.seedPlanDraft`, **before** the preset's `seedPlan`: it matches planned phases
   to template phases by id, reorders them into template order, and throws `ValidationError` on a
   missing `required` phase or a disallowed extra (surfacing as a planner retry or a human fix at
   the plan-approval gate). An OPTIONAL phase the planner omits is tolerated.

> **The governing split:** plan SHAPE lives in `phaseTemplate` (plus the generic normalizer);
> per-item DECORATION lives in `seedPlan`. They never overlap. A `seedPlan` that re-orders, adds,
> or removes phases is a bug: that is the template's job.

### Human review: the per-run gate override

Human review is a per-run **gate override**, not gated/ungated pipeline pairs. A preset's
`humanReview` form value maps to a gate-override array threaded onto the SPAWNED task runs via
each item's `spawn.gates` (the loop passes it to `ExecutionService.start`, which validates it
against the pipeline's step count and copies it onto the run's steps).

The override is a **FULL boolean array** parallel to the pipeline's own `agentKinds` (length =
`agentKinds.length`), not a sparse patch: an entry of `false` genuinely turns a pipeline gate
OFF. Derive the placement from the pipeline's own steps so it stays correct by construction; the
docs-refresh pilot's `docsReviewGates(pipelineId, humanReview)` is the reference. It gates the
`merger` step (the human reviews the CI-green PR right before it merges) by finding the merge
step's index in the target pipeline. It needs NO separate persistence: retry/restart rebuild from
the stored steps' `requiresApproval`.

## How a preset flows end to end

1. **Snapshot**: `container.initiativePresetRegistry.descriptors()` (which stamps `probe: !!detect`)
   is attached to the workspace snapshot in the shared `WorkspaceController` (both the create and GET
   handlers), so every registered descriptor reaches the SPA with no per-facade wiring, exactly like
   `customAgentKinds`.
2. **Create**: `CreateInitiativeModal.vue` is a preset picker (defaulting to `preset_generic`,
   hidden when it's the only preset) + the shared descriptor-driven form renderer
   (`DescriptorFields.vue`, which a custom task type's per-case form renders through too). `InitiativeService.create` validates + freezes the inputs; for an
   `interview: 'skip'` preset it seeds the interview `qa` digest from the filled form (the form IS
   the interview) and templates the goal. `POST /workspaces/:id/initiative-presets/:presetId/probe
{ frameId }` runs `detect` over the frame's repo and returns detected defaults: best-effort,
   `{}` when GitHub is unwired, never blocks create.
3. **Planning**: planning is started through the ordinary execution endpoint against the initiative
   block, with `pipelineId = descriptor.planningPipelineId`. `AgentContextBuilder` folds the preset's
   `{ label, promptAdditions[kind] }` and the `phaseTemplate` "required plan shape" into the planning
   steps' prompts.
4. **Ingest**: at the planner's completion, `InitiativeService.ingestPlan` runs the phase-template
   normalizer, then the preset's `seedPlan`, then re-parses strictly (`parseInitiativePlanDraft`), so
   an unsafe `targetPath` a hook or the raw draft produced fails at the trust boundary.
5. **Loop**: `InitiativeLoopService.buildTaskBlock` stamps each item's `spawn` decoration
   (`taskType`, `taskTypeFields`, `fragmentIds`, `agentConfig`, `gates`, and the item's resolved
   `pipelineId`) onto the spawned task block, so an item comes out as a first-class typed task rather
   than a bare description block.

## The Documentation-refresh pilot (`preset_docs_refresh`)

The built-in pilot (`backend/packages/agents/src/presets/docs-refresh/`) proves every primitive:
a create-time form (which doc types, placement dirs, style fragments, a human-review opt-in), a
repo-layout PREFILL probe (`docs-detect.logic.ts`, a bounded checkout-free `RepoFiles` scan), a
`phaseTemplate` (Foundations required + one optional phase per doc type), a `seedPlan` that stamps
per-item decoration (routing each item to `pl_document_quick` / `pl_code_comments` /
`pl_business_docs`, deriving `.md` target paths, applying the human-review gate override), and
`promptAdditions` that turn the analyst into a documentation gap-auditor and shape the planner's
phases + item granularity. `interview: 'skip'` means the form is the interview; the plan itself runs
unattended, and `humanReview` opts INTO gates on the spawned doc-task runs.

## The worked deployment examples

`backend/internal/example-custom-agent` is the executable proof that a DEPLOYMENT can add a
first-class initiative shape through the public seam alone, and it registers two presets rather than
one because they exercise disjoint halves:

- **`preset_org_audit`**: an `interview: 'full'` preset reusing the built-in `pl_initiative`
  planning pipeline, one required phase, and a `seedPlan` that routes every audit item to the
  package's own `pl_org_audit`. The minimum shape.
- **`preset_org_research`**: a two-phase research-then-apply methodology, the acceptance proof for
  the custom-initiative-definitions initiative, exercising checkpoints, spawned-run prompt steering,
  a verdict resolver and a cross-phase artifact, none of which `preset_org_audit` touches.

Read the source for the shape. What is worth stating outside it is the constraint the second one
discovered, because it is not obvious and it decides an agent kind's SURFACE.

### Cross-phase artifacts: the artifact must reach the next phase's clone

A later phase's container agents clone the **default branch**, so a research artifact is visible to
the apply phase only if it LANDS THERE. Two facts make the producer a **`container-coding`** kind
rather than the `container-explore` the audit example uses:

1. The artifact must land through a **merged PR** (a direct commit to the default branch would be
   rejected by branch protection), so the producing pipeline carries the universal
   `conflicts → ci → merger` tail.
2. The CI gate and the merger read `block.pullRequest`, which the engine records **only** from a
   step's `result.pullRequest`. A read-only `container-explore` step opens no PR, so its committing
   post-op would land on a branch the merge tail never gates (the `pl_org_audit` shape: fine for a
   terminal report, wrong for a cross-phase artifact). A `container-coding` step opens the PR
   (recorded, so the merge tail acts) and, per the `repro-test` precedent, can STILL return a
   `structuredOutput` JSON `custom` alongside its pushed commit, which the post-op renders the
   canonical report from. The container writes a working draft (so the PR is non-empty); the post-op
   supplies the deterministic canonical formatting in backend TypeScript.

The verdict gate is the same "structured assessment vs a human decision" shape as
`requirements-review` auto-pass and `on-call`: the kind returns a machine-readable verdict, the
engine surfaces it, and a HUMAN acts on it at the checkpoint. The engine never auto-cancels on a
machine verdict; an org that wants a hard machine stop has its resolver FAIL the run instead, which
blocks the item and halts the phase.

## Registering a BUILT-IN preset

A deployment registers from its composition root (website page). A preset shipped in
`@cat-factory/agents`, the deliberate dogfood like `@cat-factory/gates`, is different: add its
`register…Preset(registry)` call to `defaultInitiativePresetRegistry()`
(`agents/src/presets/registry.ts`), which every facade news at composition, so the two runtimes
cannot drift on it and there is no per-facade wiring. The built-in generic preset is baked into the
`InitiativePresetRegistry` class itself, so it is always resolvable.

`preset_generic` is the strangler wrapper for the whole feature: an empty form, `pl_initiative`, no
hooks, so an initiative with no preset behaves byte-for-byte as it always has. Keep it that way when
you touch the loop.

If a preset uses a `phaseTemplate`, define the phase ids **once** as a shared constant and reference
them verbatim in the template, the `promptAdditions`, and `seedPlan`: the ids are a contract (the
planner must emit them and the ingest normalizer matches on them).
`backend/packages/agents/src/presets/tech-migration/phases.ts` is the reference for the pattern.

## Testing

- **Conformance** (`backend/internal/conformance/src/initiative-suite.ts`) asserts the
  system-level behaviour on BOTH runtimes with hand-authored plan drafts: create/CAS/list round-trips,
  phase-template normalization, and the `item.spawn` decoration round-trip. The gate-override seam has
  its own cross-runtime assertion via a `startExecution(ws, block, pipeline, { gates })` harness probe.
- **End-to-end** (`backend/internal/e2e`) drives the assembled product (create-with-preset over REST
  → auto-plan → the loop spawning a decorated task), asserting only on live, WebSocket-pushed board
  updates. Because the shared `FakeAgentExecutor` drives the planning run, it emits the plan for the
  `initiative-planner` kind through a `FakeProfile.initiativePlan` seam (see the e2e README); a second
  preset's e2e extends this baseline rather than forking a parallel harness.

## Out of scope / not yet done

- **Data-only / DB-authored presets** (UI-authored, no code hooks): the descriptor/hook split keeps
  the pure-JSON subset expressible, but there is no non-code registration path yet.
- **Public API preset exposure** (`POST /api/v1/jobs` accepting a `presetId`).
- **A first-class pipeline template with a swappable step**: the doc/audit spawn pipelines share only
  the universal `conflicts → ci → merger` tail; a templated pipeline is a separate initiative, not
  built here (each preset stamps a concrete `pipelineId` per item for now).
- **SPA phase-template preview at create time**: enabled by the wire placement of `phaseTemplate`,
  not built yet.
