# Initiative presets — a form + a plan shape + typed spawned tasks, no fork

An **initiative preset** turns the open-ended Initiative feature into a task-shaped one: a
preset bundles a create-time **form**, a **planning-pipeline binding**, a declarative
**plan shape**, per-agent-kind **prompt steering**, and **spawn decoration** so the tasks
the initiative loop produces come out as first-class typed tasks. A deployment registers its
own presets through one public seam — exactly like a custom agent kind — with no engine
change and no per-facade wiring.

> This document is the model + the seams. The pilot is the built-in **Documentation-refresh**
> preset (`@cat-factory/agents`); the worked deployment example is
> `backend/internal/example-custom-agent`'s `preset_org_audit`. The durable design trackers are
> [`docs/initiatives/initiative-presets-and-docs-refresh.md`](../../docs/initiatives/initiative-presets-and-docs-refresh.md)
> (the system + the docs-refresh pilot) and
> [`docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`](../../docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md)
> (a second consumer). For the generic Initiative feature this builds on, see
> [`docs/initiatives/initiatives-feature.md`](../../docs/initiatives/initiatives-feature.md).

## Why presets exist

The generic Initiative runs one fixed pipeline — `pl_initiative`
(`initiative-interviewer → initiative-analyst → initiative-planner → initiative-committer`,
human approval after the planner) — then executes the approved plan as a loop of spawned
tasks. That shape fits open-ended refactors, where an **interview** is how the goal gets
pinned down. It does NOT fit **task-shaped initiatives** whose inputs are known up front and
enumerable as a form: "refresh this service's documentation", "migrate this database
engine", "audit every service against the org policy". For those, the interview is friction,
the plan shape is predictable, and the run should mostly be unattended.

A preset encodes exactly that difference **declaratively**, without a bespoke pipeline or a
`switch` on the initiative kind anywhere in the loop.

## The governing principle

> **The loop never branches on a preset id.** Every deviation is either serialisable
> descriptor DATA (the form, the plan shape, the defaults) or a small CODE hook that runs at
> two well-defined moments — create (`detect`) and plan ingest (`seedPlan`). The execution
> loop, the planner, and the committer are preset-agnostic; a preset only ever ADDS context.

`preset_generic` is the strangler wrapper: it declares an empty form, binds `pl_initiative`,
and registers no hooks — so an initiative with no preset (or `preset_generic`) behaves
byte-for-byte as it always has.

## The seam

A preset is one registration against the module-global registry, mirroring
`registerPipeline` / `registerGate`:

```ts
import { registerInitiativePreset } from '@cat-factory/kernel'

registerInitiativePreset({
  descriptor: {
    id: 'preset_docs_refresh',
    presentation: {
      label: 'Documentation refresh',
      icon: 'i-lucide-book-open-text',
      color: '#0ea5e9',
      description: '…',
    },
    fields: [
      /* the create-time form (see below) */
    ],
    planningPipelineId: 'pl_initiative_docs', // an existing pipeline id
    interview: 'skip', // the form IS the interview
    humanReviewDefault: false,
    defaultFragmentIds: ['style.anti-llmisms', 'style.concise-actionable'],
    phaseTemplate: {
      phases: [
        /* the required plan shape */
      ],
      allowAdditionalPhases: false,
    },
    // policyDefaults?: Partial<InitiativeExecutionPolicy>
  },
  detect, // optional: a bounded, checkout-free prefill probe over RepoFiles
  seedPlan, // optional: per-item SPAWN DECORATION at ingest (never plan shape)
  promptAdditions, // optional: per-agent-kind planning-prompt steering (data, not code)
})
```

### `InitiativePresetRegistration`

| Field              | Where                                                  | Purpose                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `descriptor`       | `@cat-factory/contracts` `initiative-preset.ts`        | The serialisable, SPA-facing definition (form + planning binding + defaults + plan shape). Pure data — it rides the workspace snapshot to the SPA.                                               |
| `detect?`          | `(repo: RepoFiles) => Promise<InitiativePresetInputs>` | A bounded, never-throwing prefill probe. Returns non-binding FORM DEFAULTS; the user's edits always win. Absent ⇒ the descriptor's `probe` flag is `false`.                                      |
| `seedPlan?`        | `(draft, inputs) => InitiativePlanDraft`               | A pure post-processor of the planner's draft at ingest. **Per-item spawn DECORATION only** — never touches phases (that is `phaseTemplate`'s job).                                               |
| `promptAdditions?` | `Partial<Record<AgentKind, string>>`                   | Per-agent-kind planning-prompt steering text (the METHODOLOGY). Folded into the planning steps' prompts; the form values reach the prompt via the interview digest, so these never restate them. |

`descriptor.probe` is **derived** server-side (`!!detect`), never author-supplied.

### The descriptor form (`InitiativePresetField`)

The field vocabulary extends the `ProviderConfigField` family the infra forms use, so the SPA
renders a preset's form generically with **zero per-preset frontend code**:

- `text` / `password` / `number` / `textarea` / `select` / `checkbox` — the flat scalar fields.
- `checkbox-group` — a multi-select whose value is `string[]` (e.g. "which documentation types").
- `path` — a repo-relative directory, validated with the same `isSafeRepoDirPath` guard the doc
  tasks use (no `..`, no absolute paths).
- `showWhen: { key, equals? | includes? }` — **single-condition** visibility (a per-doc-type
  subfolder shown only when that type is checked). Deliberately not a recursive schema renderer.

Inputs are validated + sanitised against the descriptor at create by two pure functions in
`@cat-factory/contracts`: `validateInitiativePresetInputs` (unknown keys, type mismatch, required
visible fields, options membership, path safety) and `sanitizeInitiativePresetInputs` (keeps only
declared + currently-visible fields). The sanitized subset is **frozen** on the entity's
`presetInputs` at create and never mutated — the analyst records placement/scope deviations as
`decisions`, it never rewrites the inputs.

### The plan shape (`phaseTemplate`)

A preset shapes its plan's phase structure **declaratively**:

```ts
phaseTemplate: {
  phases: [
    { id: 'foundations', title: 'Foundations', goal: '…', required: true },
    { id: 'readme',       title: 'README refresh', goal: '…' }, // optional
    // …
  ],
  allowAdditionalPhases: false,
}
```

Two pieces of **generic** machinery enforce it (no preset-specific code):

1. **Planner prompt fold** — `AgentContextBuilder` renders a "required plan shape" section into
   the planning kinds' prompts (phase ids VERBATIM, titles, goals, order, and whether extras are
   allowed) when the resolved preset declares a template. No template ⇒ the prompt is byte-for-byte
   unchanged.
2. **Ingest normalization** — `normalizeDraftAgainstPhaseTemplate` runs inside
   `InitiativeService.seedPlanDraft`, **before** the preset's `seedPlan`: it matches planned phases
   to template phases by id, reorders them into template order, and throws `ValidationError` on a
   missing `required` phase or a disallowed extra (surfacing as a planner retry / a human fix at the
   plan-approval gate). An OPTIONAL phase the planner omits is tolerated.

> **The governing split:** plan SHAPE lives in `phaseTemplate` (+ the generic normalizer);
> per-item DECORATION lives in `seedPlan`. They never overlap. A `seedPlan` that re-orders,
> adds, or removes phases is a bug — that is the template's job.

### Human review — the per-run gate override

Human review is a per-run **gate override**, not gated/ungated pipeline pairs. A preset's
`humanReview` form value maps to a gate-override array threaded onto the SPAWNED task runs via
each item's `spawn.gates` (the loop passes it to `ExecutionService.start`, which validates it
against the pipeline's step count and copies it onto the run's steps).

The override is a **FULL boolean array** parallel to the pipeline's own `agentKinds` (length =
`agentKinds.length`), not a sparse patch — an entry of `false` genuinely turns a pipeline gate
OFF. Derive the placement from the pipeline's own steps so it stays correct by construction; the
docs-refresh pilot's `docsReviewGates(pipelineId, humanReview)` is the reference — it gates the
`merger` step (the human reviews the CI-green PR right before it merges) by finding the merge
step's index in the target pipeline. It needs NO separate persistence: retry/restart rebuild from
the stored steps' `requiresApproval`.

## How a preset flows end to end

1. **Snapshot** — `initiativePresetDescriptors()` (which stamps `probe: !!detect`) is attached to
   the workspace snapshot in the shared `WorkspaceController` (both the create and GET handlers), so
   every registered descriptor reaches the SPA with no per-facade wiring — exactly like
   `customAgentKinds`.
2. **Create** — `CreateInitiativeModal.vue` is a preset picker (defaulting to `preset_generic`,
   hidden when it's the only preset) + a generic descriptor-driven form renderer
   (`InitiativePresetFields.vue`). `InitiativeService.create` validates + freezes the inputs; for an
   `interview: 'skip'` preset it seeds the interview `qa` digest from the filled form (the form IS
   the interview) and templates the goal. `POST /workspaces/:id/initiative-presets/:presetId/probe
{ frameId }` runs `detect` over the frame's repo and returns detected defaults — best-effort,
   `{}` when GitHub is unwired, never blocks create.
3. **Planning** — planning is started through the ordinary execution endpoint against the initiative
   block, with `pipelineId = descriptor.planningPipelineId`. `AgentContextBuilder` folds the preset's
   `{ label, promptAdditions[kind] }` and the `phaseTemplate` "required plan shape" into the planning
   steps' prompts.
4. **Ingest** — at the planner's completion, `InitiativeService.ingestPlan` runs the phase-template
   normalizer, then the preset's `seedPlan`, then re-parses strictly (`parseInitiativePlanDraft`), so
   an unsafe `targetPath` a hook or the raw draft produced fails at the trust boundary.
5. **Loop** — `InitiativeLoopService.buildTaskBlock` stamps each item's `spawn` decoration
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
phases + item granularity. `interview: 'skip'` — the form is the interview; the plan itself runs
unattended, and `humanReview` opts INTO gates on the spawned doc-task runs.

## The worked deployment example (`preset_org_audit`)

`backend/internal/example-custom-agent` — the worked example of a company-authored package —
registers a tiny preset alongside its custom agent kinds + gate, proving a **deployment** can add a
first-class initiative shape through the public seam alone. Its `registerExampleCustomAgents(registry)`
composition-root entry calls `registerOrgAuditPreset()`, which registers `preset_org_audit`:

- an `interview: 'full'` preset that reuses the built-in `pl_initiative` planning pipeline (so no new
  planning pipeline is registered),
- a form (an `auditAreas` `checkbox-group` + a `scopeHint` textarea),
- a single required `org-audit` `phaseTemplate` phase,
- a `seedPlan` that routes every audit item to the package's OWN `pl_org_audit` pipeline (DECORATION
  only — it never touches phases),
- `promptAdditions` steering the analyst to inventory the services and the planner to emit one audit
  item per service.

It follows the trust model of the rest of the package: a preset carries code (`detect` / `seedPlan`)
and can steer agents + read repos, so it is exactly as trusted as a custom agent — **custom presets
are code-carrying backend packages**, registered from a deployment's composition root.

## Registering a preset

- **A built-in** (shipped in `@cat-factory/agents`, deliberate dogfood like `@cat-factory/gates`):
  self-register as a module side effect at the bottom of the preset module
  (`registerDocsRefreshPreset()`), and re-export it from the agents index so importing the package
  evaluates the registration. No per-facade wiring — the two runtimes cannot drift on it.
- **A deployment preset**: register from the deployment's composition root (the
  `example-custom-agent` model — `registerExampleCustomAgents(registry)`), which the deployment
  imports and calls when it builds the container.

If a preset uses a `phaseTemplate`, define the phase ids **once** as a shared constant and reference
them verbatim in the template, the `promptAdditions`, and `seedPlan` — the ids are a contract (the
planner must emit them and the ingest normalizer matches on them). `backend/packages/agents/src/presets/tech-migration/phases.ts`
is the reference for the shared-ids pattern.

## Testing

- **Conformance** (`backend/internal/conformance/src/initiative-suite.ts`) asserts the
  system-level behaviour on BOTH runtimes with hand-authored plan drafts: create/CAS/list round-trips,
  phase-template normalization, and the `item.spawn` decoration round-trip. The gate-override seam has
  its own cross-runtime assertion via a `startExecution(ws, block, pipeline, { gates })` harness probe.
- **End-to-end** (`backend/internal/e2e`) drives the assembled product — create-with-preset over REST
  → auto-plan → the loop spawning a decorated task — asserting only on live, WebSocket-pushed board
  updates. Because the shared `FakeAgentExecutor` drives the planning run, it emits the plan for the
  `initiative-planner` kind through a `FakeProfile.initiativePlan` seam (see the e2e README); a second
  preset's e2e extends this baseline rather than forking a parallel harness.

## Out of scope / not yet done

- **Data-only / DB-authored presets** (UI-authored, no code hooks) — the descriptor/hook split keeps
  the pure-JSON subset expressible, but there is no non-code registration path yet.
- **Public API preset exposure** (`POST /api/v1/initiatives` accepting a `presetId`).
- **A first-class pipeline template with a swappable step** — the doc/audit spawn pipelines share only
  the universal `conflicts → ci → merger` tail; a templated pipeline is a separate initiative, not
  built here (each preset stamps a concrete `pipelineId` per item for now).
- **SPA phase-template preview at create time** — enabled by the wire placement of `phaseTemplate`,
  not built yet.
