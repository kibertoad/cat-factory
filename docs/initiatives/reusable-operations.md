# Initiative: Reusable operations; org-registered, parameterized canned units of work

**Status:** slices 1-8 landed (the fold + the bundle; the shared field vocabulary; the grouped
picker; the canned-pipeline lifecycle + adoption on start; the developer doc; the mothership
position; per-workspace suppression; the public API), plus the two carried nits. Only the DEFERRED
probe (slice 9) is open, so the committed scope is complete: this tracker is ready to convert to an
ADR. · **Owner:** orchestration · **Started:** 2026-08-04

> **The reference doc is now [`backend/docs/reusable-operations.md`](../../backend/docs/reusable-operations.md).**
> It is the authority for how the shipped mechanism behaves; this tracker stays the design
> record (the rejected alternatives, the per-slice notes, and slices 6-8). Cite the reference
> doc from code and from other docs, never this file.

> Durable source of truth for a multi-PR initiative. Read this first before picking up the
> next slice; update the checklist at the end of each PR. Companion docs:
> [`backend/docs/initiative-presets.md`](../../backend/docs/initiative-presets.md) (the
> multi-phase sibling this deliberately does not duplicate),
> [`backend/docs/custom-agents.md`](../../backend/docs/custom-agents.md) (the extension
> trust model), [`custom-initiative-definitions.md`](./custom-initiative-definitions.md)
> (the precedent initiative whose shape this follows), and ADR
> [`0031-foundational-services.md`](../../backend/docs/adr/0031-foundational-services.md)
> (trait routing and the suppression model).

## Goal & rationale

An organization wants **canned reusable operations**: "introduce an API on top of existing
system functionality", run again and again with per-case input ("expose CRUD for entity X",
"expose operation Y"). An operation leans on a CONSISTENT set of standing context (API
guidelines, auth requirements, the org's shared libraries and services) and collects a
small per-case form at invocation. Organizations define their own operations
programmatically, in their own packages, with zero cat-factory hardcoding: the custom-agent
trust model (an operation carries code, so it is exactly as trusted as a custom agent
kind). cat-factory ships **mechanisms only**: no domain prompts, no org operations.

**The anchor is the existing task type, not a new registry.** A registered `CustomTaskType`
already carries a namespaced id, presentation, a data-driven create form, and a
boot-validated default pipeline; its values already persist on the task
(`taskTypeFields.custom`) and ride `AgentRunContext`. What it lacks against "a reusable
operation" is exactly enumerable: the collected parameters never reach a prompt, the
standing-context fragment set has no descriptor home, the form vocabulary is poorer than
the initiative presets', the picker cannot group a large catalog, and the public API can
name a type but not fill its form. This initiative closes those gaps by widening the
existing seam, never by adding a parallel one.

**Locked decisions** (made with the product owner at design time):

- **Extend task types.** No `OperationRegistry`, no single-phase stretch of initiative
  presets. One invocation = one typed task = one pipeline run; work that needs planned
  decomposition is an initiative preset, and the boundary is documented below.
- **Worked example only.** The "introduce API" exemplar lives in
  `backend/internal/example-custom-agent` as the acceptance proof; nothing org-flavored
  ships as product.
- **UI first; the public API slice is designed now and lands later.** The field vocabulary
  is API-ready from day one. The API slice covers custom operation fields AND the built-in
  types' fields.
- **Per-workspace suppression of operations is committed scope** (the foundational-services
  suppression model).
- **An operation's canned pipeline is a read-only versioned catalog template**
  (registered `builtin: true` with an explicit `version`): a workspace clones to deviate;
  the org rolls out changes by a version bump plus the existing reseed advisory.

## Naming and boundary

"Reusable operation" is the documentation word for the PATTERN; the mechanism keeps the
name "task type" everywhere an id, a schema, or a wire field appears (the precedent:
"initiative preset" is the product word for `InitiativePresetRegistration`). Renaming the
registry or the wire fields would churn `TaskTypeRegistry`, the snapshot's
`customTaskTypes`, and the persisted `taskTypeFields.custom` for zero mechanism gain, and
would push a product word into the public API surface, which is frozen forever (ADR 0032).

| Vehicle                | When                                                                                            | Shape                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain custom task type | A first-class work-item CLASSIFICATION (an "incident" card, a badge, a small form)              | Presentation + fields only; no bundled pipeline or fragments required                                                                                             |
| **Reusable operation** | A human fills a small per-case form and ONE canned pipeline delivers one outcome                | A task type carrying the full bundle: fields + `defaultFragmentIds` + `defaultPipelineId` naming a registered read-only pipeline. One invocation = one typed task |
| Initiative preset      | The work must be PLANNED and decomposed: phases, many spawned items, checkpoints between phases | `InitiativePresetRegistration` (stays the only multi-phase vehicle)                                                                                               |
| Recurring schedule     | Time (or a webhook) is the trigger, not a human with per-case input                             | A schedule pointing at a pipeline                                                                                                                                 |

Litmus: when the create-form answers ARE the whole per-case brief and one pipeline delivers
one outcome, it is an operation. The moment the work needs "research first, then apply", it
is an initiative preset. Single-task bounds the granularity of INVOCATION, not the rigor of
the run: an operation's pipeline may carry requirements review, judges, consensus panels,
and the merge tail.

## Validated facts

Verified against the code (files cited are the authorities):

1. **`CustomTaskType` today** (`backend/packages/contracts/src/task-types.ts`): namespaced
   `taskType`, `presentation { label, icon, color, description }`, `fields` descriptors
   (`text | textarea | number | select`, with help/placeholder/options/required/maxLength),
   `defaultPipelineId` (boot-validated: `task_type_unknown_pipeline`), `formPanel`.
   Registry: `backend/packages/kernel/src/domain/task-type-registry.ts` (`register`,
   `registerAll`, `get`, `all`, `defaultPipelineId`; the default factory is EMPTY). Values
   land in the sparse `taskTypeFields.custom: Record<string, string | number>`
   (`contracts/src/primitives.ts:263`). Snapshot projection: `snapshotRegistryProjections`
   in `backend/packages/server/src/modules/workspaces/WorkspaceController.ts`.
2. **The SPA already renders custom `fields` generically**
   (`frontend/app/app/components/board/AddTaskModal.vue:1050-1099`), honours `formPanel`
   (panel replaces the descriptor fields; unpaired id degrades to them), enforces
   `required` client-side, and sends values as `taskTypeFields.custom`. Gaps: only the four
   input types, no defaults, no conditional visibility, the type picker is a flat button
   row (`:760`), `presentation.description` is never rendered anywhere, and there is no
   grouping axis (`taskTypePresentationSchema` has no `category`, while the agent-kind twin
   `agentPresentationSchema` has one and it drives the pipeline builder's palette).
3. **`taskTypeFields.custom` reaches ZERO prompts today.** The bag is threaded onto
   `context.block.taskTypeFields`
   (`orchestration/src/modules/execution/AgentContextBuilder.ts:643`, declared at
   `kernel/src/ports/agent-executor.ts:383`), but no prompt section renders `custom`
   anywhere; only bespoke per-kind folds exist (spike, document, code-commenter,
   pr-reviewer). Two structural facts bind the fix: `buildBaseUserPrompt`
   (`agents/src/agents/catalog.ts:337`) returns EARLY for a standard phase
   (`renderStandardUserPrompt`) and for a registered kind with its own `userPrompt`
   (`catalog.ts:352-356`), so a fold added only to the generic branch would miss exactly
   the runs an operation uses; and every existing fold is agent-KIND-gated at the call
   site, so there is no task-TYPE-driven prompt-section mechanism yet.
4. **A pipeline registered `builtin: true` is version-tracked and reseedable**
   (`kernel/src/domain/seed.ts:881-892`, explicit in the comment: "a registered built-in is
   version-tracked + reseedable too"). Existing workspaces then get the new-pipeline
   advisory (`usePipelineHealth.newPipelines` offers any catalog id with no stored row) and
   one-click materialisation (`PipelineService.reseed` INSERTS when absent); a version bump
   flags every workspace `outdated`; withdrawal is `PipelineRegistry.retire(id,
{ replacedBy })`. A VERSIONLESS (non-builtin) registration is one-shot insertable and
   permanently un-updatable (`reseed` refuses the stored copy, and the `outdated` check
   requires `pipeline.builtin`). Known nit: the advisory humanises an unmaterialised id
   (`builtinPipelineName` mangles `pl_org_introduce_api` into "org introduce api").
5. **`registerTaskTypeDefaultFragments` works for custom types today**
   (`BoardService.addTask:705` unions `defaultFragmentIdsForTaskType(taskType)` into the
   task's `fragmentIds`), but the seam is module-global
   (`prompt-fragments/src/task-type-defaults.ts`) with zero boot validation of either the
   type or the fragment ids.
6. **Fragment BODIES live-resolve at run time** (`FragmentLibraryService.resolveBodiesForRun`
   against the merged builtin ⊕ account ⊕ workspace catalog), so an org edits a fragment and
   already-created tasks pick it up; only the id SET freezes at task creation, matching
   `serviceFragmentIds` semantics. Fragments fold only for `code-aware` / `doc-aware` kinds
   (`AgentContextBuilder.resolveFragments`).
7. **`TaskTypeRegistry` is read at exactly three places**: task creation
   (`BoardService.addTask:728` via `defaultPipelineIdForTaskType`), boot validation
   (`checkCustomTaskTypes`), and the snapshot projection. Never at run time; a custom-typed
   task is just a `taskType` string plus a frozen bag on the block.
8. **The public API has no parameter channel and no discovery.** `createPublicTaskSchema` is
   `{ title, description?, taskType? }` (`contracts/src/public-api.ts:234-241`): a custom id
   is creatable but not one of its fields is fillable. No task-type catalog endpoint exists.
   Evolution is additive-only (ADR 0032), and a new endpoint needs a
   `scripts/sdk/surface.mjs` entry or generation fails.
9. **Custom types are refused in document frames** (`assertTaskTypeAllowed`,
   `BoardService.ts:618-622`), `presentation.color` is unused by the picker, and
   conformance already carries a "registered custom task type" describe to extend
   (`backend/internal/conformance/src/suites/agents.ts:610`).

## Target pattern: per-gap design decisions

### D1. The operation bundle on `customTaskTypeSchema`

Two additions, both optional so every existing registration is untouched:

- **`defaultFragmentIds?: string[]`**: the operation's standing context, seeded at task
  creation into the SAME union `BoardService.addTask` already computes (service fragments ∪
  type defaults, deduped). Bodies keep live-resolving at run time (fact 6), so the
  consistency the feature promises holds: the org edits the guideline, every future run
  sees it; only the id set is per-task state, editable per case like any task's fragments.
- **`presentation.category?: string`** (trimmed, short): the picker grouping axis (D7),
  mirroring `agentPresentationSchema.category`.

The module-global `registerTaskTypeDefaultFragments` stays, scoped to its remaining
legitimate use (attaching defaults to BUILT-IN types, which have no descriptor); the
developer doc stops recommending it for custom types.

Deliberately NOT added: `promptAdditions` (D5), `detect` (D6), human-review knobs (an
operation OWNS its registered pipeline, so approval pauses are that pipeline's own `gates`
array; `gatesOverride` on `ExecutionService.start` stays the initiative-preset seam).

### D2. One shared field-descriptor vocabulary (unify with initiative presets)

Extract the initiative-preset field vocabulary into a shared contracts module
(`contracts/src/form-fields.ts`): the field schema (key, label, help, placeholder,
required, type, options, defaults, `showWhen` single-condition visibility, plus the
task-type `maxLength`), and the pure helpers generalized to take a plain field list:
validate, sanitize, is-visible, render-value (today's `validateInitiativePresetInputs` /
`sanitizeInitiativePresetInputs` / `isPresetFieldVisible` / `renderInitiativePresetValue`
in `contracts/src/initiative-preset.ts:243-377` become thin wrappers or re-exports). Each
surface declares its ALLOWED type picklist over the shared schema:

- Initiative presets: all eight types, wire shape unchanged.
- Task types: `text | textarea | number | select | checkbox | checkbox-group | path`.
  **`password` is excluded by construction**: a task field value lands in prompts, the
  board snapshot, telemetry snapshots, and potentially PR text; a secret has the
  capability-credential store.

**Widen the value bag**: `taskTypeFields.custom` becomes
`Record<string, string | number | boolean | string[]>` (matching
`InitiativePresetInputValue`). Internals are pre-1.0: existing rows parse unchanged (pure
widening), no migration. This is the API-ready vocabulary from day one: JSON-native values,
stable keys, option values as enum strings.

### D3. Params reach the prompt: one generic, value-authoritative fold

The engine resolves a labeled projection once per dispatch; the agents package renders it;
the VALUES are authoritative and the descriptor only enriches.

- New `AgentRunContext.customTaskType?: { taskType: string; label: string; fields:
Array<{ key: string; label?: string; value: string }> }` beside `taskTypeFields`.
  `AgentContextBuilder` resolves it when `block.taskTypeFields?.custom` is non-empty:
  look the type up on `CoreDependencies.taskTypeRegistry`, order declared fields first
  (descriptor order), render each value through the shared render helper (option labels,
  Yes/No booleans, joined arrays), and append any bag key the descriptor does NOT declare
  with the raw key and a stringified value. A missing registration (stale data, or a
  mothership-mode node a build behind, D11) degrades to raw keys, never to a dropped
  value: drift can cost labels, never data. Resolved once per dispatch, so the container,
  inline, and consensus paths cannot disagree (the `systemPromptOverride` rule).
- New `customTaskTypeSection(context)` in `agents/src/agents/prompts/standard.ts` (beside
  `ownServiceSection`), rendering a `## Task parameters (<label>)` list. Emitted in
  `renderStandardUserPrompt`, in the generic branch of `buildBaseUserPrompt`, AND
  prepended for self-authoring registered kinds exactly where `initiativePresetSection`
  is prepended today (`catalog.ts:352-356`), or fact 3's early returns swallow it.
- Placement honours "a derived subject never displaces the requester's words": the section
  is APPENDED after the block-context template, which carries title + description
  verbatim.
- Empty on every run without custom fields, so every existing prompt is byte-identical.
  No harness change, no image bump: the fold rides the user prompt the backend composes.

### D4. Standing context posture

- **Fragments**: D1's `defaultFragmentIds` gains a boot check in `checkCustomTaskTypes`:
  each id is resolved against the universal code pool (built-in catalog +
  `registerPromptFragments`). An unresolvable id is a **WARN**
  (`task_type_unknown_fragment`), not an error, and the message states both possible
  causes: a typo, or a tenant-tier id (account/workspace fragment rows merge per workspace
  at run time, so boot structurally cannot know them). Strictly better than today's zero
  validation without refusing legitimate tenant-tier references. Run-time behavior is
  unchanged (an unresolvable id is skipped at body resolution).
- **Trait gating is respected and documented**: fragments fold only for `code-aware` /
  `doc-aware` kinds. An operation whose pipeline uses custom kinds must give those kinds
  the right traits; the developer doc carries this as a numbered gotcha (the
  custom-initiative tracker's fact 2 precedent: testers are NOT code-aware).
- **Foundational services: no descriptor field.** The pipeline's kinds carry the
  `foundational-catalog` / `foundational-contracts` traits and the design's fenced
  declaration decides which documents an implementer sees (ADR 0031). An operation-level
  pin would bypass the declaration flow and re-create the kind-id-list anti-pattern.

### D5. Per-kind steering: variants + the canned pipeline's stepOptions, nothing new

An operation steers its steps through registered variants
(`registerVariant({ id, baseKind, promptAddition })`) selected by its registered
pipeline's `stepOptions[i].agentVariantId`. This works end to end today
(`example-custom-agent` ships `stepOptions: [{ agentVariantId: ORG_CODER_TDD_VARIANT_ID },
null, null, null]`), is boot-validated (`checkPipelineVariantSelections`), composes
correctly with workspace prompt overrides, and records honestly (`step.promptVariant`).
A `promptAdditions`-like field on the task type is REJECTED: it would be a second text
channel with undefined precedence against variants and workspace overrides, and unlike an
initiative preset (which does not own its spawned items' pipelines), an operation OWNS its
pipeline, so the per-step seam is exactly available.

### D6. Prefill probe: deferred, with the door designed

No `detect?` hook in v1. Operation forms carry per-case BUSINESS input ("expose CRUD for
entity X"), which no repo probe can prefill; the preset probe earns its keep on
repo-derived facts (docs roots, detected types). If a real org form warrants it, the slice
mirrors the preset shape exactly: `detect?(repo: RepoFiles)` on the registration (kernel
side, off the wire), a derived `probe?: boolean` on the wire descriptor,
`POST /workspaces/:ws/task-types/:id/probe`.

### D7. UI

1. **Field renderer**: extract the generic renderer from `InitiativePresetFields.vue` into
   a shared component (`DescriptorFields.vue`) driven by the D2 vocabulary, used by the
   custom-type branch of `AddTaskModal.vue` (replacing the inline block at ~1050-1099) AND
   the preset form. Closes checkbox / checkbox-group / path / defaults / `showWhen` for
   task types in one move and removes a near-duplicate. `formPanel` behavior unchanged.
2. **Picker grouping**: built-ins first; custom types sharing a `presentation.category`
   render under a small category caption; uncategorized custom types follow flat. No
   collapse/overflow machinery in v1.
3. **i18n convention (stated here and in the doc)**: custom-type labels, descriptions,
   field labels, and option labels are deployment-authored English rendered verbatim from
   the descriptor (already how `customTaskTypeToMeta` works). Only surrounding chrome is
   i18n. No custom strings enter `en.json`.
4. **Interface-mode tier**: task creation is the everyday delivery loop, so operations
   render in `basic`; descriptor fields carry input nothing else supplies, so they stay in
   both tiers. Stated so nobody "tidies" operations behind `isAdvanced`.

### D8. Descriptor validation at every door

Creation validates the `custom` bag against the descriptor with the shared D2 helper, in
`BoardService.addTask` (one rule for the SPA, internal API, and public API): unknown keys
refused, required visible fields present, values type-checked, select/checkbox-group values
drawn from options, `path` held to `isSafeRepoDirPath`. Skipped entirely when the
descriptor declares `formPanel` (the panel owns the bag, the existing AddTaskModal
contract) and when the type is unregistered (a namespaced id is trusted to the deployment
today; degrading data must not brick creation). Refusal is a `ValidationError` carrying the
problems list.

### D9. Public API slice (designed now, landed later)

Additive-only per ADR 0032; ships with an OpenAPI `info.version` minor bump + SDK
regeneration (`pnpm gen:sdk`, `check:sdk`).

1. **Discovery**: `GET /api/v1/task-types` (scope `read`), returning each registered type's
   wire descriptor minus `formPanel` (SPA-internal), plus the built-in types' presentation.
   Contract in `contracts/src/routes/public-api.ts`; `surface.mjs` entry under a
   `taskTypes` group.
2. **Invocation**: `createPublicTaskSchema` gains an optional `fields` record. For a
   REGISTERED custom type it maps onto `taskTypeFields.custom` and is validated against the
   descriptor (422 `details.reason: 'task_type_fields_invalid'` with the problems list).
   For the BUILT-IN types the accepted per-type fields (severity, stepsToReproduce,
   docKind, audience, targetPath, timeboxHours, successCriteria, researchQuestion,
   optionsToCompare, prNumber/prUrl/reviewFocus) are typed EXPLICITLY in the public
   contract and map onto the internal `AddTaskInput.taskTypeFields` top-level keys, so the
   existing creation machinery (the review-task PR fold, the doc fields) runs unchanged.
   Wrinkle to resolve in-slice: built-ins have no registered descriptors, so their public
   shape lives in the OpenAPI schema itself while discovery serves descriptors for custom
   types.
3. **Run**: nothing new. `POST /api/v1/tasks/:id/start` already falls back to the pinned
   pipeline, and creation already pins `defaultPipelineId`. "Invoke operation X with
   params Y" = `tasks.create({ taskType, fields })` + `tasks.start()` in all four SDKs.
4. `backend/docs/public-api.md` + changeset document the addition; the sdk-smoketest gains
   the scenario if its Node boot can register the example package, otherwise the discovery
   read alone is smoke-tested and this tracker records why.

### D10b. Adoption: a run materialises the operation's pipeline, so no board is stuck

D10's advisory-plus-reseed is the adoption path for a HUMAN browsing the pipeline library. It is not
one for an operation, because an operation PINS its pipeline by id: `pipelineIdFor` resolves the pin
off the task-type registry, which knows nothing about rows, so on a board older than the registration
a task of the operation is creatable and then refuses to start with a bare 404. Nothing in the create
flow says "reseed first", and nothing should: the board not having a row is the platform's bookkeeping,
not the user's problem.

So run resolution ADOPTS: `pipelineAdoption.adoptForRun` returns the stored row, else materialises the
catalog entry and returns that. The mechanics, the `builtin`-only restriction that keeps it from
resurrecting a deletion, and the read-only `resolveDefinition` twin live in
[`pipeline-catalog-lifecycle.md`](../../backend/docs/pipeline-catalog-lifecycle.md).

Two rejected alternatives, both of which look cheaper:

- **Resolve from the catalog without persisting.** The run would then use a pipeline the board's own
  library does not list, cannot open in the builder, and cannot attach a schedule to. That is the
  "absent renders as empty" failure in its worst form: the library actively says "you do not have
  this" while a run is executing it.
- **Auto-seed registered built-ins into existing workspaces at boot or on board load.** Still
  rejected, for the reason already recorded below: `seedPipelines` must never gain a filter or a
  write-behind. Adoption is the same write, made where the need is PROVEN (someone started a run)
  rather than speculatively for every registered pipeline on every board load.

Version does NOT enter the reference anywhere. The operation names an id, the run uses whatever
definition the workspace holds, and `version` exists solely as the drift signal between the code
catalog and the copied row (fact 4). Adoption inserts at the current catalog version, so a board that
adopts later simply starts current.

### D10. Canned-pipeline lifecycle: use the catalog lifecycle, verified

The mechanism exists (fact 4); the decision is the REGISTRATION SHAPE plus verification:
an operation's pipeline is registered **`builtin: true` with an explicit `version`**. It
is then read-only in workspaces (clone to customise: the product stance the owner
confirmed), reaches existing workspaces through the advisory + one-click reseed, updates
by version bump, and withdraws by `retire(id, { replacedBy })`. Slice work: one
conformance assertion driving the full lifecycle (registered pipeline appears in
`pipelineCatalogVersions`, reseed materialises into a pre-existing workspace, version bump
flags `outdated`, retire flips to removable), plus noting the `builtinPipelineName`
humanisation nit (not fixed in v1). `task_type_unknown_pipeline` already covers the
descriptor→pipeline reference at boot.

### D11. Mothership position: node-local by design, no `TaskTypeSource` in v1

The mothership rule ("code-registered state a RUN resolves rides its own `/internal/*`
read") exists because a deployment is two processes on two builds. A `CustomTaskType` is
deliberately NOT given that treatment, because it is inseparable from the code registered
BESIDE it: its `defaultPipelineId` names a pipeline in the same package, that pipeline
names custom KINDS and VARIANTS (functions, which structurally cannot cross a wire), its
`defaultFragmentIds` name fragments in the same pool, and its `formPanel` names a frontend
component in the same layer. Serving the descriptor from the mothership while the
executable half stays node-local would produce a MIXED bundle (a v2 descriptor naming a
pipeline the node's v1 package lacks), a failure boot validation cannot see. The unit of
distribution is the org package, exactly as for custom agent kinds. `BinaryGeneratorSource`
differs because a generator definition is pure data plus a credential NAME, consumable with
no co-registered code, and it gates admission.

Consequences, named honestly (and recorded in the mothership tracker): a node a build
behind offers last build's operations, the same lag its agent kinds already have; a stock
node in an org deployment offers no org operations at all (an absence, not a wrong answer;
a foreign-created typed task degrades to the `feature` presentation by the existing rule);
a run of such a task on a package-less node fails loudly at the existing seams (unknown
kind at admission). The D3 fold is built for this drift: value-authoritative rendering
means a stale or absent registration costs labels, never parameters.

### D12. Per-workspace suppression of operations

A workspace admin can hide registered operations from that workspace (committed scope; an
org's 20 operations should not flood every team's picker). The foundational-services
suppression model is the template: a suppression sub-resource, a tombstone row per
suppressed id, restore hard-deletes the tombstone, and the suppression LIST is its own
read (a suppressed id is by construction absent from the projected catalog, so nothing
else could offer the way back). Mechanics:

- A new workspace-scoped table (D1 migration ⇄ Drizzle schema + `pnpm db:generate`, with a
  conformance round-trip), keyed `(workspaceId, taskType)`.
- Snapshot filtering: suppressed ids are dropped from the projected `customTaskTypes`.
- Server-side refusal in `BoardService.addTask` for a suppressed type, so no API path
  bypasses the picker.
- RBAC: the workspace-settings admin permission; a small settings surface listing
  registered operations with hide/restore.
- Mothership bucket: **`remote`** (org/workspace rows read at snapshot and creation time),
  allow-listed on the record's own `workspaceId` with the round-trip and
  cross-account-refusal tests `persistenceRpc.spec.ts` requires.
- Built-in task types are NOT suppressible in v1: they carry hardcoded creation
  affordances (the document-frame restriction, per-type form sections).

### D13. The worked example (`backend/internal/example-custom-agent`): the acceptance proof

`org:introduce-api`, org-flavored, never shipped as product:

- **Fragments** (registered via `registerPromptFragments` from
  `registerExampleCustomAgents`): `org.api-guidelines`, `org.api-auth-requirements`,
  `org.shared-services-map`, each with a `brief` so the two-tier standards fold is
  exercised. Dotted, matching the catalog's own id convention (`node.best-practices`),
  which is what `INTRODUCE_API_FRAGMENT_IDS` ships.
- **Variants**: `org:architect-api` and `org:coder-api` (`promptAddition`s carrying the
  org's API design and implementation conventions; addition, not replacement, per the
  variant doctrine).
- **Pipeline** `pl_org_introduce_api`, registered `builtin: true, version: 1` (D10):
  `['architect', 'coder', 'tester-api', 'conflicts', 'ci', 'merger']` with `stepOptions`
  selecting the two variants on steps 0 and 1.
- **Task type** `org:introduce-api`: presentation (label "Introduce API",
  `category: 'API delivery'`), `fields`: `entity` (text, required), `operations`
  (checkbox-group: create/read/update/delete/list), `resourceStyle` (select), `authRequirement`
  (select, required), `notes` (textarea); `defaultFragmentIds`: the three ids;
  `defaultPipelineId: 'pl_org_introduce_api'`.

### D14. Docs

- **`backend/docs/reusable-operations.md`** (the `initiative-presets.md` precedent): why
  operations exist, the governing rule ("the engine never branches on a task-type id;
  every deviation is descriptor data resolved at two moments, creation and dispatch"),
  the bundle anatomy, the boundary statement, the registration walkthrough
  (composition-root order), the D10 pipeline lifecycle, the trait gotchas, the worked
  example, testing.
- Cross-links: `backend/docs/custom-agents.md` (a task-types-and-operations pointer),
  `backend/docs/initiative-presets.md` (a boundary paragraph pointing here),
  `docs/glossary.md` (operation entry).
- CLAUDE.md: one line in the Custom agents section pointing at the doc (index rule: the
  detail lives in the flow doc).
- Root `README.md`: one "What it supports" row.
- Per slice: touched packages' `AGENTS.md`/`README.md`; `backend/docs/public-api.md` with
  the API slice; changesets throughout (empty for docs-only).

## Considered and rejected

- **A new `OperationRegistry` beside task types**: the task type IS the anchor and already
  has the registry, snapshot projection, picker, boot validation, and conformance seam.
- **Stretching initiative presets to single-task operations**: a plan-of-one adds an
  interview, a planner, and an ingest for nothing.
- **`promptAdditions` on the task type** (D5): the operation owns its pipeline, so
  variants + `stepOptions` already deliver per-kind steering with recorded application; a
  second text channel creates precedence ambiguity.
- **Foundational-service references on the descriptor** (D4): routing is by trait and
  consumption is by the design's declaration (ADR 0031); a pin would bypass both.
- **`password` field type for task types** (D2): task field values reach prompts,
  snapshots, and telemetry; secrets have the capability-credential store.
- **A `TaskTypeSource` `/internal` read in v1** (D11): splits an inseparable code bundle.
  Revisit only if task types ever gain a data-only tier (tenant-defined types).
- **`detect` prefill probe in v1** (D6): no repo-derivable inputs in the motivating forms;
  the door is designed and the warrant bar stated.
- **Freezing descriptor labels onto the block at creation**: duplicates registry state
  into rows and goes stale against re-registered descriptors; the value-authoritative fold
  (D3) gets the drift-safety without the copy.
- **Auto-inserting registered pipelines into existing workspaces at boot**: `seedPipelines`
  must never gain a filter or a write-behind; the advisory + reseed is the shipped
  adoption path.

## Per-slice status checklist

| #   | Slice (each one PR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Scope  | Depends on | Status  | PR                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ------- | ----------------------------------------------------------- |
| 0   | This tracker doc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —      | —          | ✅ done | [#1650](https://github.com/kibertoad/cat-factory/pull/1650) |
| 1   | **Pilot: the fold + the bundle (D1, D3, D4)**: `AgentRunContext.customTaskType` + builder resolution; `customTaskTypeSection` in all three emit points; `defaultFragmentIds` + `presentation.category` on the descriptor; addTask fragment union; boot WARN; worked example v1; conformance (fold + fragment seeding + byte-identical-without-fields)                                                                                                                                                          | SYSTEM | 0          | ✅ done |                                                             |
| 2   | **Shared field vocabulary (D2, D8)**: `contracts/src/form-fields.ts` extraction; preset schema re-based; task-type picklist (minus password); `taskTypeFields.custom` widened; creation validation; shared `DescriptorFields.vue` in AddTaskModal + preset form; example gains checkbox-group/select                                                                                                                                                                                                           | BOTH   | 1          | ✅ done |                                                             |
| 3   | **Picker grouping (D7)**: category captions in the type picker; `presentation.description` rendered; one chrome i18n key (the "Other" bucket)                                                                                                                                                                                                                                                                                                                                                                  | SPA    | 2          | ✅ done | [#1672](https://github.com/kibertoad/cat-factory/pull/1672) |
| 4   | **Canned-pipeline lifecycle (D10)**: example pipeline registered `builtin: true, version`; conformance lifecycle assertion (advisory → reseed insert → version bump → retire)                                                                                                                                                                                                                                                                                                                                  | SYSTEM | 1          | ✅ done | [#1691](https://github.com/kibertoad/cat-factory/pull/1691) |
| 4b  | **Adoption on start (D10b)**: `PipelineRepository.insertIfAbsent` (both runtimes); `pipelineAdoption` collaborator (`adoptForRun` / `resolveDefinition` / `adoptableCatalog`); run resolution, the personal-credential gate, both public-API start admissions and the post-merge auto-start read through it; `reseed`'s absent branch shares the row builder + the idempotent insert; the `pipeline.adopted` counter; conformance (adopt once under concurrent starts; decide-scope on an un-adopted pipeline) | SYSTEM | 4          | ✅ done | [#1691](https://github.com/kibertoad/cat-factory/pull/1691) |
| 5   | **Developer doc (D14)**: `backend/docs/reusable-operations.md`; cross-links; CLAUDE.md one-liner; README row; AGENTS.md sweeps                                                                                                                                                                                                                                                                                                                                                                                 | DOCS   | 2          | ✅ done |                                                             |
| 6   | **Mothership position (D11)**: classification/tracker entry, docs only                                                                                                                                                                                                                                                                                                                                                                                                                                         | DOCS   | 1          | ✅ done |                                                             |
| 7   | **Workspace suppression (D12)**: table (both runtimes) + conformance; snapshot filtering; addTask refusal; RBAC + settings UI; `remote` allow-list entry + RPC tests                                                                                                                                                                                                                                                                                                                                           | SYSTEM | 2          | ✅ done |                                                             |
| 8   | **Public API (D9)**: `GET /api/v1/task-types`; `createPublicTaskSchema.fields` (custom + built-in); `task_type_fields_invalid`; surface.mjs; OpenAPI minor; SDK regen; public-api.md                                                                                                                                                                                                                                                                                                                           | SYSTEM | 2          | ✅ done |                                                             |
| 9   | (deferred) **Prefill probe (D6)**: the preset `detect` mirror                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SYSTEM | warrant    | ⬜ todo |                                                             |

Pilot ordering: slice 1 establishes the fold and the bundle with the smallest blast radius
and proves the worked example end to end on the existing 4-type form vocabulary. Slices 3,
4, 5, 6 parallelize after their stated dependency; 7 and 8 wait for the vocabulary to be
final so neither ships a shape that changes a slice later.

### What slice 1 surfaced (carry into the rest)

- **The projection is a KERNEL domain helper, not builder code.**
  `describeCustomTaskType` (`kernel/src/domain/task-type-context.ts`, the `describeOwnService`
  sibling) does the descriptor join; `AgentContextBuilder` only calls it.
- **`BoardService`'s creation-time task-type defaults are now a collaborator**, because this slice's
  additions crossed the file's size budget: `board/taskTypeCreationDefaults.ts` owns the fragment
  union (form picks or service standards ⊕ per-type defaults ⊕ a registered operation's standing
  context) AND the default-pipeline pin, since both are one lookup against one registry read twice.
  That bought `BoardService` ~70 lines of headroom, but `AgentContextBuilder` is still within ~55
  lines of its own, so anything a later slice adds THERE belongs in a collaborator from the start.
- **The registry reaches the builder through FOUR edits**, and missing any one compiles fine
  while the fold silently never resolves: `ExecutionServiceDependencies.taskTypeRegistry`, the
  `RunContextAdmissionDeps` `Pick`, the `AgentContextBuilder` deps literal in
  `run-context-admission.ts`, and `container/execution-service.ts` reading
  **`runtime.taskTypeRegistry`** rather than `injected` (a facade may pass none and
  `resolveCoreRuntime` supplies the empty default, so the engine and `BoardService` must read the
  same instance).
- **Kernel now re-exports `CustomTaskType` + `TaskTypeFieldDescriptor`** (`domain/types.ts`), so
  an org package registering an operation imports its whole vocabulary from kernel and needs no
  contracts dependency.
- **`registerExampleCustomAgents` now takes ONE deps object** (`ExampleRegistries`), converted in
  this slice rather than growing to a seventh positional registry: `max-params` refuses the seventh,
  and every entry is a registry, so transposing two in a positional list is a silent
  misregistration that typechecks. A later slice needing an eighth seam ADDS A FIELD; do not
  reintroduce positional arguments.
- **The example's `operations` field ships as `text` in slice 1** and becomes a `checkbox-group`
  in slice 2, changing its value type from `string` to `string[]`. Internals are pre-1.0 and this
  is the worked example, so no migration; just do not treat the slice-1 shape as settled.
- **Conformance asserts the CONTEXT, not the prompt**: `FakeAgentOptions.echoTaskParams` echoes
  the resolved projection (`[params]label|key=value;…[/params]`) the way `echoPreset` does, since
  what needs proving per runtime is that the sparse `custom` bag survives persistence and reaches
  dispatch. The rendering itself is pure and unit-tested in `@cat-factory/agents`.
- **The value-authoritative rule stops at a NAMESPACED type, and slice 8 must keep it there.**
  `describeCustomTaskType` returns nothing for an un-namespaced id: a custom type is namespaced by
  construction, so `feature` has no descriptor however current the build is, and the raw-id fallback
  that honestly names a WITHDRAWN operation would instead head a section `## Task parameters
(feature)` over keys nothing declared. That is not drift costing a label, it is a fabricated
  operation identity the model reads as a specification. `createTaskSchema.taskTypeFields` accepts
  the bag for any type today (slice 2 owns creation validation), and D9's
  `createPublicTaskSchema.fields` covers "custom + built-in", so the type-side check belongs there
  and the guard here stays either way.
- **The standing-context seeding STATES an unregistered type** (`BoardService.standingContextForTaskType`),
  where the fold degrades silently on purpose. The asymmetry is deliberate and worth keeping in mind
  for D11/D12: only the id SET freezes at creation, so a task created on a process whose package
  lacks the registration never gains the operation's fragments and a later build does not go back
  for it, while the projection self-heals the moment the descriptor is there.

### What slice 2 surfaced (carry into the rest)

- **The shared module is `contracts/src/form-fields.ts` and its helpers take a FIELD LIST**:
  `descriptorFieldEntries` (spread into each surface's own `v.object` with its narrowed `type`
  picklist), `descriptorFieldValuesSchema` (the filled bag, now `taskTypeFields.custom` AND
  `presetInputs`), plus `isDescriptorFieldVisible` / `validateDescriptorFields` /
  `sanitizeDescriptorFields` / `renderDescriptorFieldValue`. The preset names survive as ALIASES
  (`isPresetFieldVisible`) and two descriptor-taking wrappers, so no preset call site moved.
  **Kernel re-exports the four helpers**, keeping the "an org package imports its whole vocabulary
  from kernel, with no contracts dependency" rule slice 1 established.
- **A declared `maxLength` is now enforced SERVER-side** for both surfaces, not just by the input's
  own attribute. It was a form-only bound before, and a form is not the only door. It is also CAPPED
  at `DESCRIPTOR_FIELD_VALUE_MAX`, the bound the filled bag itself carries: a descriptor allowed to
  declare more would render an input accepting what the request schema then refuses, and that
  refusal arrives as a raw schema error rather than the readable per-field message.
- **`InitiativePresetFields.vue` is GONE**, not left beside the new one:
  `components/common/DescriptorFields.vue` is the single renderer, taking `:fields` plus a
  `testid-prefix` so each surface keeps its own selectors. The task form's `select` therefore
  changed from a button row to a `USelect` (correct for an operation with many options), and its
  fields gained the preset form's `checkbox` / `checkbox-group` / `path` / defaults / `showWhen`.
- **Only the DEFAULT-seeding rule stayed frontend-side** (`utils/descriptorFields.ts`
  `defaultDescriptorValues`), matching the preset precedent: the server validates and sanitizes but
  never fills in a default. **Slice 8 has to decide this deliberately**, because a headless caller
  omitting a field that is `required` AND has a `default` is refused today where the SPA is not.
  Either the check applies defaults first (one rule at every door) or the public contract demands
  explicit values; do not let the two doors diverge by accident.
- **The rest of `utils/descriptorFields.ts` is the EDIT rules** (`setDescriptorValue`,
  `setDescriptorCheckbox`, `toggleDescriptorGroupValue`), pure functions over the value bag rather
  than methods inside the SFC, because what an edit freezes is exactly what a unit test should be
  able to reach without mounting a component. They enforce the same drop-when-unset judgement the
  shared `sanitize` makes, plus the one thing only a form sees: a half-typed `number` input reads as
  `NaN`, which serialises to `null` and is refused by the value schema.
- **An ABSENT bag is checked against an EMPTY one.** A required field is unanswered whether the
  caller sent `custom: {}` or no `custom` key at all, and a check the caller opts out of by sending
  nothing is not a check. This is a behaviour change for any non-SPA path creating a task of an
  operation with required fields (an initiative item's `spawn`, a script): it is a 422 now.
- **Sanitization DROPS an unfilled value rather than freezing it**, because validation short-circuits
  on one and therefore type-checks it never: a `false` on a text field reached the row and the prompt
  fold rendered it to every agent as `Notes: No`. The single exception is an explicit `false` on a
  `checkbox`, the opt-OUT of a default-ON toggle, which a consumer reads as `inputs[key] !== false`
  (`seedMigrationPlan`) and which absence cannot express.
- **Creation validation lives in the slice-1 collaborator** (`board/taskTypeCreationDefaults.ts`
  `validatedFields`), because it is the same registry lookup as the fragment union and the pipeline
  pin, read a third time. `BoardService` gained two lines, which is all its budget had left.
- **Three cases pass through UNCHECKED, each on purpose**: a built-in type (its fields are
  schema-typed top-level keys), an unregistered namespaced type (a supported row per D11, so
  degrading data must not brick creation), and a descriptor declaring a `formPanel` (the panel owns
  its bag). The conformance suite pins the third-party case, since it is the one that reads like a
  bug when you find it.
- **The conformance task-type block moved to its own module** (`suites/agent-task-types.ts`,
  `defineTaskTypeConformance`) when the refusal assertions pushed `suites/agents.ts` over its
  size budget. Slices 4 and 7 add their assertions THERE.
- **The example's `operations` field is now a `checkbox-group`** (`string[]`, as slice 1 flagged),
  and a `showWhen`-gated `actionName` field exercises conditional visibility end to end.
- **Boot validation gained the FORM checks the richer vocabulary needs** (`descriptorFormProblems`):
  a duplicate field key, an optionless `select`/`checkbox-group`, and a `showWhen` gating a field on
  an undeclared key are ERRORS, not warnings, because each is fully known from the registration and
  invisible at run time (the last one hides its own field forever). Keep this bar for any attribute a
  later slice adds: warn only where boot genuinely cannot see the answer, as with a tenant-tier
  fragment id. It takes a plain FIELD LIST and both surfaces go through it under their own code
  prefixes (`task_type_field_*` / `initiative_preset_field_*`), so an initiative preset's create form
  is boot-validated too; all three facades pass `initiativePresetRegistry`.
- **One i18n key moved**: the path-invalid message is `common.pathInvalid` now that two surfaces
  render it, carrying each locale's existing translation verbatim.

### What slice 3 surfaced (carry into the rest)

- **The layout rule is a pure function** (`app/utils/taskTypePicker.ts` `buildTaskTypePickerRows`,
  the `buildFragmentCategoryGroups` sibling) returning ROWS of `{ id, caption, choices }`, so the
  built-ins are the first row rather than a separate template branch: one nested `v-for` renders
  every choice through one button, and the ORDER is unit-tested without mounting the modal. Slice 7
  filters the store's `customTaskTypes`, upstream of this, so a suppressed operation's category
  caption disappears with its last type and needs no extra rule here.
- **The `data-testid="task-type-<id>"` selector per choice survived the re-layout**, deliberately:
  it is the picker's only external contract, and a deployment's own e2e suite is the consumer that
  would notice it move (the in-repo specs created a typed task over REST and asserted the card badge,
  so they would NOT have caught it). The new hooks follow the repeated-testid + discriminator shape
  `pipeline-step` / `data-step-kind` established: each row is `data-testid="task-type-row"` plus
  `data-task-type-row="<row id>"`, and the per-row caption keeps ONE id (`task-type-category`)
  addressed THROUGH its row. A caption id that varied per row would have been unique but positional,
  and `getByTestId('task-type-category')` alone is a strict-mode violation the moment a second
  category exists.
- **Category order is REGISTRATION order, not alphabetical.** Registration order is the only order
  the deployment expressed; re-sorting would silently reshuffle a catalog its author arranged, and
  the difference is invisible in a one-category example (the spec pins it with two).
- **A blank caption reads as "no category".** The wire schema trims and length-checks it, but a
  CODE-shipped consumer type is trusted and unvalidated, so a whitespace-only category is reachable
  and must fall into the uncategorized bucket rather than render an empty heading.
- **Captions fold on CASE and whitespace, and the fold is NOT a slug.** `API delivery` and
  `api  DELIVERY` are one row (captioned as first written), because two headings differing only in
  case read as two categories the author never declared. Slugifying to an id-safe `[a-z0-9-]` key
  would have been tidier for the row id and is wrong: a caption is arbitrary Unicode written in the
  deployment's own language, so stripping non-ASCII folds genuinely distinct captions together
  (`Ámbito` / `Émbito` both reduce to `mbito`). The row id therefore carries the folded caption
  verbatim and is read as an attribute VALUE, never as a testid suffix.
- **The row gap must stay wider than a caption's own margin.** At `space-y-1.5` between rows and
  `mb-1` under a caption, a heading sat 6px below the group above it and 4px above its own buttons:
  proximity said nothing, so the grouping did not read. `space-y-3` is the fix, and the constraint is
  stated at the markup because the numbers are individually unremarkable.
- **The leftovers row is CAPTIONED, and that caption is the slice's one i18n key**
  (`board.addTask.typeOther`). Left bare it sat one 6px gap under the last category's buttons with no
  heading of its own, so its types read as more of that category (the `AgentPalette` "Custom agents"
  bucket had already solved this). D7.3's "no locale entry for descriptor text" governs LABELS,
  CAPTIONS and DESCRIPTIONS the deployment authored; a heading over the platform's own leftovers
  bucket is chrome, and the util takes it as an argument rather than authoring English itself. It is
  omitted when the leftovers are the ONLY row, where it would name a distinction nothing shows.
- **`presentation.description` is rendered at last**, closing the last picker gap in fact 2: as each
  custom button's `title` (the half that helps you CHOOSE, the `AgentPalette` precedent) and, for the
  selected type, through the type field's own `UFormField` help slot (the half a touch device can
  reach). The help slot is the seam 47 other fields in the SPA already use; the first cut was a
  sibling `<p>` with a negative margin cancelling the modal's spacing, which is the same information
  rendered by fighting the design system instead of using it. Built-in types have no descriptions, so
  the help line is custom-only.
- **`frontend/app/app/docs/consumer-extensions.md` was two slices stale** (it still listed the
  four pre-slice-2 input types and knew nothing of `defaultFragmentIds`), because slice 2 swept the
  layer README and missed the consumer doc beside it. Both are part of the sweep for anything
  touching the custom-task-type surface, and so is the third file in that family: the
  `CustomTaskTypeContribution` structural copy in `deploy/frontend/app/modular/acme-security.ts`,
  which the doc POINTS AT as the worked example and which could not express `category`,
  `defaultFragmentIds`, or the slice-2 field types. A copy missing an axis reads as an axis that does
  not exist.
- **The dogfood module is where the picker gets assembled-product coverage.** `acme:incident` now
  declares a category, so `consumer-extension.spec.ts` asserts the rendered nesting (the consumer
  choice inside its own captioned row, the built-in row still uncaptioned, the description in the
  help slot on selection). The unit spec pins the ORDER; only the e2e catches a template regression
  that flattens the rows or drops a caption while leaving every unit test green.

### What slice 4 surfaced (carry into the rest)

- **The RETIREMENT half of D10 was already covered; only ADOPTION was missing.** `core-planning.ts`'s
  `pl_org_flow` test already drives a `builtin: true, version: 1` registration through seed → retire →
  tombstone → delete, so this slice's assertion (`suites/agent-task-types.ts`) covers the other
  direction and nothing else: a board seeded BEFORE the operation ships, the pipeline advertised in
  `pipelineCatalogVersions` with no stored row, one reseed INSERTING it read-only, a version bump
  moving the catalog ahead of the stored copy, and the same reseed adopting it. Driven as three apps
  over ONE store, because a workspace created after the registration is seeded at creation and proves
  nothing about adoption. Slices 7 and 8 should extend that test rather than add a second
  pipeline-lifecycle one.
- **`builtin` and `version` buy DIFFERENT things, and a test must read `registered()` to see both.**
  `builtin` is what keeps the pipeline read-only in a workspace (clone to deviate, so nothing can
  reshape the definition the operation pins); the explicit `version` is the rollout channel. Asserting
  through `seedPipelines()` would pass for a registration declaring NEITHER, because the seeding path
  defaults every built-in's version to 1.
- **The versionless trap is worse than "un-updatable": it is editable AND frozen.** `reseed` refuses a
  stored non-builtin and `usePipelineHealth`'s `outdated` check requires `pipeline.builtin` on the
  STORED row, so a versionless registration gives each workspace a copy it can edit or delete out from
  under the operation and that the org can never fix. The rule now lives once in
  [`pipeline-catalog-lifecycle.md`](../../backend/docs/pipeline-catalog-lifecycle.md) rather than
  restated per initiative.
- **The example package's OTHER pipelines are still versionless, deliberately left alone.**
  `pl_org_audit`, `pl_org_scope`, `pl_org_research` and `pl_org_apply` are initiative-preset routing
  targets (`seedPlan` pins them by id), so they want the same shape for the same reason and today a
  workspace can delete one. That is the initiative-presets examples' own scope, not this slice's;
  named here so the mixed shapes inside one worked-example package don't read as intentional contrast.
- **A task of an operation was creatable before its pipeline was adopted, and only startable after.**
  `pipelineIdFor` resolves the pin off the REGISTRY with no check that the workspace stores the row
  (`taskTypeCreationDefaults.ts`), which is the right disposition for CREATION: refusing it would
  punish a board for not having reseeded, and falling through to the positional default would silently
  run the operation on the wrong pipeline. What was wrong was leaving the advisory as the only way
  across, which slice 4b fixes by adopting at run resolution (D10b).
- **The `builtinPipelineName` humanisation nit is now REACHABLE** (fact 4): a board predating the
  operation sees its pipeline offered as "org introduce api". Still unfixed per D10, and the fix is
  not a better humaniser: `pipelineCatalogVersions` is a `Record<string, number>`, so a real name
  needs a sibling map on the snapshot (internal, so additive and cheap) plus the store/composable
  reads. Worth doing when a slice is already in that snapshot.

### What slice 4b surfaced (carry into the rest)

- **The question that produced this slice was "why pin a VERSION to an operation", and the answer is
  that nothing does.** `defaultPipelineId` is a bare id, `block.pipelineId` is a bare id, and a run
  uses whatever definition the workspace's row currently holds. `version` only ever compares the code
  catalog against the copied row. Worth keeping stated plainly, because "the operation names a
  version" is the natural misreading of a lifecycle built out of version numbers, and it would lead a
  later slice to add a pin nothing needs.
- **The adoption gap was not in the reference, it was in the two different sources that answer
  "what is pipeline X".** Creation asked the registry, the run asked the rows, and nothing reconciled
  them. Any future surface that resolves a pipeline id must pick one deliberately: `adoptForRun` when
  it is about to run one, `resolveDefinition` when it is answering a question about a prospective run.
  A bare `pipelineRepository.get` on a run-adjacent path is now the smell.
- **The read-only twin exists because of a real bug, not for symmetry, and there were THREE of them.**
  Widening what a start resolves widens every gate standing in front of one, and each of these read the
  bare row and, finding nothing, did not refuse but CONCLUDED:
  - `individualVendorsForBlock` backs the personal-credential gate on the START request and did
    `pipeline?.agentKinds ?? []`, so an un-adopted pipeline resolved to no kinds, the gate concluded the
    run needed no personal subscription, and the run then adopted and started ungated.
  - The public API's decide-scope check (`PublicApiController`, both start paths) resolved the caller's
    `pipelineId` to inspect it for parks; `null` skipped the check entirely and `start` then adopted and
    parked the run, so a `write`-only key could set in motion exactly the park that scope withholds.
    `PipelineService.get` was REPLACED by `resolveForRun` rather than joined by it, so the stored-row
    read is gone and a future caller cannot pick the wrong one. `pl_initiative` is public AND parking,
    so this was reachable through the built-in catalog alone, not only through a registered pipeline.
  - `PostMergeBoardController.autoStartDependents` resolved dependents from the workspace pipeline LIST
    and dropped any whose pin had no row, with no log line, so a merge propagated into a task that
    never began. That path holds the whole list already, so it resolves misses through the new
    `adoptableCatalog()` rather than a point read per miss (banned N+1), and an unresolvable pin is now
    reported.

  The transferable rule: any `?? []`, `if (!pipeline)` or nullable-row branch on a run-adjacent path is
  worth the same suspicion, because the degradation is silent AND permissive. Adoption is also counted
  (`pipeline.adopted`), since a log line per board cannot answer how many boards are still behind.

- **`insertIfAbsent` is conflict-TARGETED, and the D1 half must not become `INSERT OR IGNORE`.** Two
  tasks of one operation started at once both resolve "no row" and both insert. Both write the same
  catalog definition, so losing is a no-op, but a blanket ignore would also swallow an unrelated
  constraint failure on SQLite only, which passes the Postgres suite. The conformance assertion drives
  the race through HTTP (two concurrent starts, then exactly one row) rather than through a repository
  probe, so it covers the wiring too.
- **`reseed` and adoption now share `adoptedCatalogRow`.** They materialise the same catalog entry, so
  two builders would eventually disagree about labels or archive state. Reseed's absent branch also
  moved onto `insertIfAbsent`, which fixed a pre-existing race of its own (two concurrent reseeds of
  an un-adopted built-in).
- **`ExecutionServiceDependencies.pipelineRegistry` is the FIFTH edit of the four-edit trap slice 1
  named**, with the same failure mode: optional, so a facade that forgets it typechecks, and the
  BUILT-IN half of adoption keeps working, so only a DEPLOYMENT's own registered pipeline is
  unadoptable. `container/execution-service.ts` reads `runtime.pipelineRegistry`, never an injected
  argument, so the engine and `PipelineService` adopt from one instance. It stays optional because
  `resolveCoreRuntime` supplies a default and the ONE construction site threads the resolved value, so
  the trap has no live spelling; `operationalMetrics`, added beside it, is REQUIRED, because an
  un-wired counter and a deployment whose boards are all current export the same nothing.
- **Still not adopted anywhere else, deliberately**: `InitiativeService.assertPipelineExists` (a policy
  edit naming an un-adopted pipeline) and `RecurringPipelineService` (attaching a schedule to one)
  still refuse. Both are AUTHORING paths where the SPA only ever offers stored pipelines, so the
  refusal is only reachable headlessly, and adopting on an authoring write would materialise rows for
  pipelines nobody ran. Slice 8 should decide the public-API spelling explicitly rather than inherit
  this by accident. The distinction that decided the three fixes above from these two: does the surface
  stand in front of a RUN (then it must resolve what the run will resolve) or does it record a choice
  for later (then a refusal is honest, because nothing is executing yet).

### What slice 5 surfaced (carry into the rest)

- **The reference doc took over every CITATION, including the ones in code**, because a tracker is
  `git rm`'d and converted to an ADR when its committed scope completes, and the ten-odd
  `docs/initiatives/reusable-operations.md` comments in kernel, orchestration, conformance and the
  example package would all have become dangling on that day. They now name
  `backend/docs/reusable-operations.md`, and the bare `D3` / `D4` / `D11` suffixes went with them:
  a D-number is an index into THIS file's decision list, which the ADR conversion drops. Slices 7
  and 8 should cite the reference doc from the start rather than adding more tracker references to
  re-point later.
- **The doc is the flow authority; this tracker keeps the REJECTED alternatives.** The split matters
  because the two answer different questions: "how does this behave" (which a reader must not have to
  reconstruct from a checklist) versus "why is there no `OperationRegistry` / `promptAdditions` /
  `TaskTypeSource`", which only stops the next iteration from re-proposing it if it stays written
  down. So the reference doc states each non-goal in one line and points here for the argument.
- **CLAUDE.md had exactly two lines of headroom** under its ratchet (1096 against 1098), which is
  what the one-liner had to fit in, trap and all. The flow-index charter wants "what it is, the
  deadliest trap, the link"; at two lines the trap loses, because the link is what a reader follows
  and the emit-point trap is stated three times over in the doc, the kernel `AGENTS.md` and the
  agents `AGENTS.md`. A later slice adding to that section must displace something rather than
  assume headroom.
- **`registerTaskTypeDefaultFragments` is now documented as the BUILT-IN-type seam** in both
  `prompt-fragments` docs (D1 said the developer doc would stop recommending it for custom types,
  and the README was still recommending it generally). The distinction is not stylistic: a
  descriptor's `defaultFragmentIds` are boot-validated and warn on an unresolvable id, where the
  module-global validates nothing at all, so the two seams differ in whether a typo is ever
  reported.
- **The README documentation index was missing `initiative-presets.md`** entirely, so the new entry
  adds both. Worth a glance whenever a slice adds a `backend/docs/*.md`: the "What it supports" row
  and the index are separate lists and only the layout table is CI-guarded.
- **`board/taskTypeCreationDefaults.ts` earned its own `AGENTS.md` entry**, having been covered only
  by the `board/` catch-all since slice 1. It is where three registry reads land, and the three
  deliberate validation pass-throughs are exactly the kind of thing that reads as a bug when found
  without the note.

### What slices 6-8 surfaced (the last committed slice)

Landed together because they turned out to depend on each other in a way the plan did not show: the
public catalog has to honour suppression (a type it lists and creation refuses is worse than one it
omits), and both of them read the registry through the same projection the snapshot does.

- **Slice 6 needed no code, and writing it down changed slice 7's design.** Stating "the descriptor
  is inseparable from the code registered beside it" makes the complement obvious: the per-workspace
  CHOICE about a descriptor is pure data with no co-registered code, so the suppression rows are
  `remote` while the catalog stays node-local. The two halves of one feature sit in different
  mothership buckets, and that is the correct answer rather than an inconsistency.
- **The three readers of the suppression set disagree about failure ON PURPOSE, and the asymmetry is
  the interesting part.** The snapshot projection and the public catalog are BEST-EFFORT (a picker
  must never take a board load or a startup discovery down over a cosmetic preference); the creation
  check PROPAGATES, because it decides whether a row is written and it hits the same database the
  insert on the next line goes to, so there is no outage for it to ride out. A single posture would
  have been wrong in one direction or the other.
- **Absence had to be the default, and the opposite shape is the tempting one.** A stored
  `visible` row per workspace per type reads as more explicit and would withhold every newly
  registered operation from every existing board until somebody noticed. Tombstones make "nobody has
  said anything" mean "offered", which is the only direction whose silent failure is a surplus.
- **`GET /api/v1/task-types` gave the BUILT-IN types real descriptors, which D9 did not plan.** The
  sketch was descriptors for custom types and a hand-written OpenAPI shape for the built-ins, i.e.
  two statements of one fact with only one of them checked. `BUILTIN_PUBLIC_TASK_FIELDS` states them
  once, so discovery and validation are the same table and the built-in half runs through the same
  `validateDescriptorFields` everything else does. It is a deliberate SUBSET of
  `taskTypeFieldsSchema` (the per-`DocKind` prose sections stay internal); widening it later is
  additive, which is what makes the subset safe.
- **Slice 2's flagged fork resolved toward "defaults at the door".** `withDescriptorFieldDefaults`
  now runs server-side at BOTH descriptor doors before validate + sanitize, so a `required` field
  carrying a `default` is no longer accepted from the SPA and refused from a script. That promoted a
  latent authoring bug to a boot ERROR: a default outside a `select`'s options used to be a form
  that opened oddly, and is now a type whose every creation is refused for a value the caller never
  sent, so `descriptorFormProblems` names it.
- **The `builtinPipelineName` nit is fixed, and the fix was a snapshot field, not a better
  humaniser** (slice 4's note predicted exactly this). `pipelineCatalogNames` rides beside
  `pipelineCatalogVersions`, built from the same `seedPipelines()` read so the two cannot list
  different ids; the humanised id survives only as the fallback for a facade that ships no map.
- **The Go SDK client's accessor list is HAND-written, and it was three groups stale.** `me`,
  `evidence` and `keys` generated services that nothing constructed, so those endpoints were
  uncallable from Go while every drift check passed: the exact hole `surface.mjs` exists to prevent,
  moved one file along. `check-sdks.mjs` now fails on a group Go never constructs. The Python
  emitter had the sibling latent bug: group names are camelCase in the surface table and every group
  was a single word until `taskTypes`, so it would have shipped `client.taskTypes` in Python. Both
  are worth remembering as a rule: a NEW resource GROUP (not merely a new operation) touches
  hand-written code in one SDK and exercises spelling paths in another.
- **`WorkspaceController.snapshotRegistryProjections` is no longer workspace-independent**, and its
  own doc comment said five times that it was. It now takes an optional workspace id, absent at
  CREATE (a board that does not exist cannot have hidden anything, so the read could only answer
  empty). A later projection that needs board state should join it there rather than growing a
  second per-workspace read beside it.

## Consumer walkthrough: assembling "Introduce API" org-side

How an org builds the operation from the finished mechanisms, entirely inside its own
backend package registered from its deployment's composition root (the
`example-custom-agent` trust model):

1. **Standing context**: `registerPromptFragments([...])` with the org's API guidelines,
   auth requirements, and shared-services map (or link a repo fragment source and reference
   the `src:<sourceId>:<slug>` ids; tenant-tier ids resolve per workspace and boot warns
   rather than refuses).
2. **Steering**: `registerVariant` for `org:architect-api` and `org:coder-api`
   (`promptAddition`s with the org's conventions).
3. **The canned pipeline**: `pipelineRegistry.register({ id: 'pl_org_introduce_api',
builtin: true, version: 1, agentKinds: ['architect', 'coder', 'tester-api', 'conflicts',
'ci', 'merger'], stepOptions: [{ agentVariantId: 'org:architect-api' },
{ agentVariantId: 'org:coder-api' }, null, null, null, null] })`. Read-only in
   workspaces; updates roll out by bumping `version`.
4. **The operation**: `taskTypeRegistry.register({ taskType: 'org:introduce-api',
presentation: { label: 'Introduce API', category: 'API delivery', ... }, fields: [...],
defaultFragmentIds: [...], defaultPipelineId: 'pl_org_introduce_api' })`.
5. **The run**: a user picks "Introduce API" in the create-task form on a service, fills
   entity/operations/auth, creates. The task carries the frozen field bag + the seeded
   fragment ids + the pinned pipeline. Start dispatches architect (variant-steered, sees
   the labeled parameters + the folded standards + the foundational-services catalog via
   its trait), then coder, tester, and the merge tail. Headless, after slice 8:
   `tasks.create({ taskType: 'org:introduce-api', fields: {...} })` + `tasks.start()`.

Zero cat-factory changes beyond the slices above; zero org prompts shipped in cat-factory.

## Conventions & gotchas (carry between iterations)

- **The engine never branches on a task-type id.** Every deviation is descriptor data
  resolved at two moments: creation (fragments, pipeline pin, validation) and dispatch
  (the D3 projection). A `switch (taskType)` anywhere in the engine is the anti-pattern
  this initiative exists to avoid.
- **The fold has THREE emit points** (fact 3): `renderStandardUserPrompt`, the generic
  branch of `buildBaseUserPrompt`, and the self-authoring prepend. A new prompt-assembly
  site must emit it too, or an operation's parameters silently vanish for that path.
- **Byte-identical prompts without custom fields** is the regression bar for every slice
  touching prompt composition.
- **Values are authoritative; the descriptor enriches** (D3). Never render only declared
  fields, never drop an undeclared bag key: drift costs labels, never data.
- **Fragments fold only for `code-aware`/`doc-aware` kinds.** An operation using custom
  kinds must give them the traits; testers are NOT code-aware.
- **`seedPipelines` never gains a filter or a write-behind.** Adoption into existing
  workspaces is the advisory + reseed, and an operation's pipeline must register
  `builtin: true` with an explicit `version` or it is one-shot and un-updatable (fact 4).
- **Descriptor strings are deployment-authored English rendered verbatim**; only chrome is
  i18n. No custom strings enter locale catalogs.
- **Keep the runtimes symmetric**: the suppression table lands D1 ⇄ Drizzle with
  conformance in the same PR; everything else in this initiative is engine/contract-level
  and symmetric by construction, but prompt-fold and creation-validation assertions still
  run on both runtimes.
- **Public API is additive-only** (ADR 0032): `fields` is a new optional key, discovery is
  a new endpoint with a `surface.mjs` entry, and nothing existing is renamed or re-scoped.
- **Mothership**: task types are node-local by design (D11); the suppression rows are
  `remote`. Do not add a `TaskTypeSource` without revisiting D11's argument.

## Out of scope

- Multi-task fan-out from one invocation (an initiative preset's job; the boundary table
  is the contract).
- Suppressing BUILT-IN task types per workspace (they carry hardcoded creation
  affordances; revisit separately if wanted).
- Data-only / DB-authored operations (UI-authored types with no code): the descriptor/code
  split keeps the pure-JSON subset expressible, but there is no non-code registration path
  here, matching the initiative-preset stance.
- The `detect` prefill probe (deferred slice 9 with its warrant bar).
- Shipping any org-flavored operation as product (worked example only).
- A `TaskTypeSource` `/internal` read (D11's considered rejection).
