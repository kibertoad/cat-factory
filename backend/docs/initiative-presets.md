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

A preset is one registration against the **app-owned `InitiativePresetRegistry`**, mirroring the
agent-kind registry (`AgentKindRegistry` / `defaultAgentKindRegistry()`). A deployment news the
default registry (which preloads the built-ins), registers its own presets on it by reference, and
injects it through the facade's composition seam — `createApp({ overrides: { initiativePresetRegistry } })`
on the Worker, or the `initiativePresetRegistry` option on `start()` / `startLocal()`:

```ts
import { defaultInitiativePresetRegistry } from '@cat-factory/agents'

const initiativePresetRegistry = defaultInitiativePresetRegistry()
initiativePresetRegistry.register({
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

1. **Snapshot** — `container.initiativePresetRegistry.descriptors()` (which stamps `probe: !!detect`)
   is attached to the workspace snapshot in the shared `WorkspaceController` (both the create and GET
   handlers), so every registered descriptor reaches the SPA with no per-facade wiring — exactly like
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

## A multi-phase deployment example (`preset_org_research`)

The same package also registers `preset_org_research` — a minimal two-phase **"research → apply"**
methodology that is the acceptance proof for the custom-initiative-definitions initiative (it
exercises checkpoints, spawned-run prompt steering, a verdict resolver, and a cross-phase artifact,
none of which `preset_org_audit` touched). It is the stripped-down shape of the connector-factory
use case, and every piece is assembled from the public seams alone:

- **`fields`** — a required `topic` text field (the thing to research) + a `docsRoot` `path`.
- **`phaseTemplate`** — two required phases, no extras: a **`research`** phase marked
  **`checkpoint: true`** and an **`apply`** phase. The checkpoint pauses the initiative once the
  research item settles (merges), so a human reads the committed report before the apply phase spawns
  — resume on GO, **cancel on NO_GO** (the engine never interprets the verdict; see below).
- **The research producer** is the package's `org-researcher` agent kind, run on the package's own
  `pl_org_research = [org-researcher, conflicts, ci, merger]` — a **merging** pipeline, which is what
  makes the report a cross-phase artifact: the merge tail lands it on the default branch the apply
  phase's coder later clones. `org-researcher` is a **`container-coding`** kind with a
  `structuredOutput` verdict (`GO` / `GO_WITH_CAVEATS` / `NO_GO`), whose **`postOp`** renders the
  canonical report from the verdict and commits it onto the PR branch, and whose registered
  **step resolver** folds the verdict into the step output so the tracker + the checkpoint read
  "Verdict: NO_GO — …" at a glance. (It is `container-coding`, not `container-explore`, for a
  load-bearing reason — see "Cross-phase artifacts" below.)
- **`seedPlan`** — DECORATION only: it DERIVES the report path from the frozen `topic`
  (`docs/research/research-<slug>.md`), routes the research item to `pl_org_research` and stamps the
  path on its `spawn.taskTypeFields.targetPath` (which the post-op reads), and routes the apply
  item(s) to `pl_org_apply = [coder, conflicts, ci, merger]` while baking the SAME path into their
  description (which the coder reads from its checkout). Producer and consumer derive the path from
  one source and cannot drift.
- **`promptAdditions`** — the analyst/planner steering rides the PLANNING run, while the `coder`
  (built-in) and `org-researcher` (custom) additions reach the SPAWNED runs via the spawned-run
  prompt-additions seam (slice 1): org methodology folded onto the children without forking either
  kind.

### Cross-phase artifacts — the artifact must reach the next phase's clone

A later phase's container agents clone the **default branch**, so a research artifact is visible to
the apply phase only if it LANDS THERE. Two facts make the producer a **`container-coding`** kind
rather than the `container-explore` the audit example uses:

1. The artifact must land through a **merged PR** (a direct commit to the default branch would be
   rejected by branch protection). So the producing pipeline carries the universal
   `conflicts → ci → merger` tail.
2. The CI gate + the merger read `block.pullRequest`, which the engine records **only** from a
   step's `result.pullRequest`. A read-only `container-explore` step opens no PR, so its committing
   post-op would land on a branch the merge tail never gates (the `pl_org_audit` shape — fine for a
   terminal report, wrong for a cross-phase artifact). A **`container-coding`** step opens the PR
   (recorded → merge tail acts), and — per the `repro-test` precedent — can STILL return a
   `structuredOutput` JSON `custom` alongside its pushed commit, which the post-op renders the
   canonical report from. The container writes a working draft (so the PR is non-empty); the post-op
   supplies the deterministic canonical formatting in backend TypeScript.

The verdict gate is the same "structured assessment vs a human decision" shape as
`requirements-review` auto-pass and `on-call`: the org kind returns a machine-readable verdict, the
engine surfaces it, and a HUMAN acts on it at the checkpoint (resume/cancel). The engine never
auto-cancels on a machine verdict — a business GO/NO_GO is a human decision by design (an org that
wants a hard machine stop can have its resolver FAIL the run instead, which blocks the item and halts
the phase).

## Registering a preset

- **A built-in** (shipped in `@cat-factory/agents`, deliberate dogfood like `@cat-factory/gates`):
  add its `register…Preset(registry)` call to `defaultInitiativePresetRegistry()`
  (`agents/src/presets/registry.ts`), which every facade news at composition — so the two runtimes
  cannot drift on it, with no per-facade wiring. (The built-in generic preset is baked into the
  `InitiativePresetRegistry` class itself, always resolvable.)
- **A deployment preset**: register from the deployment's composition root on the app-owned registry
  the facade injects (the `example-custom-agent` model — `registerExampleCustomAgents(agentKindRegistry,
initiativePresetRegistry)`), then pass that registry into the facade build
  (`createApp({ overrides: { initiativePresetRegistry } })` / `start({ initiativePresetRegistry })`).

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
