# Reusable operations: canned, parameterized units of work an org runs again and again

A **reusable operation** is a named piece of work an organisation performs repeatedly with
per-case input: "introduce an API on top of existing system functionality", run once for
`Order` and again for the refund flow. Each invocation leans on the SAME standing context (the
org's API guidelines, its auth requirements, its shared-services map) and collects a small form
at creation. A deployment defines its own operations in its own backend package, through the
public registry seams, with nothing org-flavored shipped in cat-factory.

The vehicle is the existing **custom task type**, carrying three things instead of one:

| Descriptor field     | What it is                                                           |
| -------------------- | -------------------------------------------------------------------- |
| `fields`             | the small per-case form, whose answers reach every agent's prompt    |
| `defaultFragmentIds` | the standing context, seeded onto every task of the type at creation |
| `defaultPipelineId`  | the canned pipeline that delivers the outcome                        |

A task type carrying only `presentation` is still just a work-item classification (a badge and
a card). The three fields above are what turn it into an operation.

> The design record, including the alternatives rejected and the slices still open, is
> [`docs/initiatives/reusable-operations.md`](../../docs/initiatives/reusable-operations.md), and
> [ADR 0040](./adr/0040-deployment-extension-seam-reachability.md) records what an org build outside
> this repo could not reach when it registered one against the published packages.
> Related: [`custom-agents.md`](./custom-agents.md) (the extension trust model these
> registrations share), [`initiative-presets.md`](./initiative-presets.md) (the vehicle when
> the work must be PLANNED and decomposed), and
> [`pipeline-catalog-lifecycle.md`](./pipeline-catalog-lifecycle.md) (how an operation's
> pipeline reaches boards and gets updated).

## The governing principle

> **The engine never branches on a task-type id.** Every deviation is descriptor DATA, resolved
> at exactly two moments: **creation** (the fragment union, the pipeline pin, the field
> validation) and **dispatch** (the labeled parameter projection). A `switch (taskType)` in the
> engine is the anti-pattern this feature exists to avoid.

Nothing at run time knows an operation exists. A custom-typed task is a `taskType` string plus
a frozen value bag on the block; the registry is read at creation, at boot validation, at the
snapshot projection, and at dispatch to label what the bag already holds.

## Naming: the product word is "operation", the mechanism is "task type"

"Reusable operation" is the word for the PATTERN. Every id, schema and wire field keeps the name
task type: `TaskTypeRegistry`, the snapshot's `customTaskTypes`, the persisted
`taskTypeFields.custom`. The precedent is "initiative preset" as the product word over
`InitiativePresetRegistration`. Renaming would churn a persisted shape and push a product word
into the frozen public API surface for no mechanism gain.

## Which vehicle: operation, plain task type, or initiative preset

| Vehicle                    | When                                                                                            | Shape                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Plain custom task type** | A first-class work-item CLASSIFICATION (an "incident" card, a badge, a small form)              | `presentation` + `fields`; no bundled pipeline or fragments                                             |
| **Reusable operation**     | A human fills a small per-case form and ONE canned pipeline delivers one outcome                | the full bundle: `fields` + `defaultFragmentIds` + `defaultPipelineId`. One invocation = one typed task |
| **Initiative preset**      | The work must be PLANNED and decomposed: phases, many spawned items, checkpoints between phases | `InitiativePresetRegistration` ([`initiative-presets.md`](./initiative-presets.md))                     |
| **Recurring schedule**     | Time (or a webhook) is the trigger, not a human with per-case input                             | a schedule pointing at a pipeline                                                                       |

Litmus: when the create-form answers ARE the whole per-case brief and one pipeline delivers one
outcome, it is an operation. The moment the work needs "research first, then apply", it is an
initiative preset.

Single-task bounds the granularity of INVOCATION, not the rigor of the run. An operation's
pipeline may carry requirements review, judges, consensus panels and the full merge tail: it is
an ordinary pipeline.

## The bundle, field by field

```ts
taskTypeRegistry.register({
  taskType: 'org:introduce-api', // ALWAYS namespaced (<ns>:<name>)
  presentation: {
    label: 'Introduce API',
    icon: 'i-lucide-plug',
    color: '#0ea5e9',
    description: 'Expose existing system functionality over the org’s standard HTTP API.',
    category: 'API delivery', // the picker's grouping caption
  },
  fields: [/* the per-case form (see the vocabulary below) */],
  defaultFragmentIds: ['org.api-guidelines', 'org.api-auth-requirements'],
  defaultPipelineId: 'pl_org_introduce_api',
  // formPanel: 'org:introduce-api-form',  // optional: a bespoke create-form section instead
})
```

- **`fields`** are collected at creation and frozen in the sparse `taskTypeFields.custom` bag,
  so adding a field never needs a migration. The values reach every agent's prompt (below).
- **`defaultFragmentIds`** are unioned onto the new task's own `fragmentIds` at creation, beside
  whatever it inherits from its service. Only the id SET freezes; the BODIES live-resolve per
  run against the merged builtin ⊕ account ⊕ workspace catalog, so editing a guideline reaches
  every future run of an already-created task. The union lives in
  `orchestration/src/modules/board/taskTypeCreationDefaults.ts`.
- **`defaultPipelineId`** pins the pipeline a task of the type defaults to when the creator
  chooses none. Absent ⇒ the workspace's positional default, exactly like an unmapped built-in
  type.
- **`presentation.category`** groups the create-task picker (below). Declare one once the
  deployment ships more than a couple of types.
- **`formPanel`** names a frontend component contributed to the `taskTypeFormPanels` slot, shown
  INSTEAD of the descriptor `fields`. It owns the whole value bag, so the platform's field
  validation stands down for a type that declares one (it cannot read a bespoke panel's required
  semantics). An unpaired id degrades to the descriptor fields.

Deliberately NOT on the descriptor:

- **`promptAdditions`.** Per-kind steering rides registered VARIANTS selected by the operation's
  own pipeline `stepOptions` (below). An operation OWNS its pipeline, so the per-step seam is
  already there; a second text channel would have undefined precedence against variants and
  per-workspace prompt overrides.
- **Human-review knobs.** An approval pause is the operation's pipeline's own `gates` array.
- **Foundational-service pins.** Routing is by agent-kind TRAIT and consumption is by the
  design's own fenced declaration (see [ADR 0031](./adr/0031-foundational-services.md)); a pin
  on the task type would bypass both.

## The per-case form: one shared descriptor vocabulary

An operation's `fields` and an initiative preset's create form are the SAME vocabulary,
`backend/packages/contracts/src/form-fields.ts`, so a form that renders in one surface renders
in the other and one validator covers both.

- **Types a task type admits**: `text`, `textarea`, `number`, `select`, `checkbox`,
  `checkbox-group`, `path`. Each field may carry `help`, `placeholder`, `required`, `options`,
  `default` / `defaultValues`, `maxLength`, `min` / `max`, a single-condition
  `showWhen: { key, equals? | includes? }`, and a `section` caption.
- **`section` groups a long form and does nothing else.** An operation that collects a dozen fields,
  each of which changes what the agents do, reads as one undifferentiated column; a caption above a
  run of related fields fixes that. It is PRESENTATION: validation, what is frozen, and the prompt
  fold are all unchanged, so moving a field between sections can never change what the platform does
  with its answer. Declare a section's fields CONSECUTIVELY (case and spacing are folded, as in the
  picker's category rows): boot refuses a section a filled form could caption TWICE, because the
  renderer keeps your declaration order rather than repairing it. What boot judges is REACHABILITY,
  not the order of the declared list, so a section interleaved only with a MUTUALLY EXCLUSIVE branch
  is fine and is the normal way to write a branching form (each branch's fields beside the picker
  they qualify). A section whose every field is hidden by `showWhen` renders no caption at all.
- **`password` is excluded by construction.** A collected value is folded into prompts, projected
  onto the board snapshot and captured in agent-context telemetry. A capability whose agents need
  a credential declares it BY NAME against the per-workspace capability-credential store, where
  the value never reaches a prompt.
- **A declared bound binds the SERVER**, not only the input: `maxLength` (capped at
  `DESCRIPTOR_FIELD_VALUE_MAX`), the option lists, and `path` safety
  (`isSafeRepoDirPath`: no `..`, no absolute path, no backslash) are all enforced where the value
  is frozen, because a form is not the only door.
- **A condition states `equals` or `includes`, and deliberately nothing else.** One condition, one
  predicate, over one other field: that covers a picker and a toggle, which is what a per-case brief
  branches on. There is no `exists` / `notEmpty`, so "include the data-governance standard whenever
  the free-text `sensitiveData` answer is filled" is expressed by asking the question the branch
  actually turns on (a `checkbox` or a `select` the free text then qualifies), which is a better
  form anyway: a condition keyed on whether prose is non-empty fires on "n/a" and on a stray space.
  Adding a third predicate is a live option, not a closed door, and the cost is that it is not local:
  the vocabulary is published in `/api/v1/task-types` and rendered by four SDKs, and
  `duplicatedDescriptorSectionCaptions` decides section reachability by proving two conditions can be
  satisfied at once, so a new predicate has to state how it contradicts the existing two. That is
  worth paying for a real operation and not for a speculative one, so it rides the first one that
  needs it.
- **The whole vocabulary and the four helpers**
  (`validateDescriptorFields` / `sanitizeDescriptorFields` / `isDescriptorFieldVisible` /
  `renderDescriptorFieldValue`) are re-exported from every runtime FACADE, so a deployment types its
  descriptors, and runs the platform's own validator over them in its tests, with the facade as its
  only cat-factory dependency (below). Kernel re-exports them too, for a package that legitimately
  sits at that layer; nothing here needs a `@cat-factory/contracts` dependency.

### Validation at creation, and the three deliberate pass-throughs

`BoardService.addTask` checks the submitted `custom` bag against the descriptor: unknown keys
refused, required VISIBLE fields present, values type-checked, `select` / `checkbox-group` values
drawn from the declared options, `path` values inside the repo. A failure is one
`ValidationError` carrying every problem, with `details.reason: 'task_type_fields_invalid'`. One
rule therefore covers the SPA, the internal API and any headless caller.

Two behaviours worth knowing before you author a form:

- **An ABSENT bag is checked against an EMPTY one.** A required field is unanswered whether the
  caller sent `custom: {}` or no `custom` key at all. Anything creating a task of an operation
  with required fields (an initiative item's `spawn`, a script) must fill them.
- **Sanitization DROPS an unfilled value rather than freezing it**, because validation
  short-circuits on a value that says nothing and therefore never type-checks it. The single
  exception is an explicit `false` on a `checkbox`, the opt-OUT of a default-ON toggle, which
  absence cannot express.

Three cases pass through unchecked, each on purpose: a BUILT-IN type (its fields are the
schema-typed top-level keys, validated there), an UNREGISTERED namespaced type (a supported row,
since task types are node-local by design, and degrading data must not brick creation), and a
descriptor declaring a `formPanel` (the panel owns the bag).

**A declared DEFAULT is applied at the door, not in the form** (`withDescriptorFieldDefaults`,
shared). The SPA seeds a fresh form from the same helper, so a browser submit is unchanged; what it
fixes is every other caller. Before, a field that was both `required` and defaulted was accepted
from the SPA (which had already filled it) and refused for a headless caller (which had no way to
know it had to restate a value the deployment already declared). Only ABSENT keys are filled, so an
explicit value always wins, including the one case where that matters: a `false` on a default-ON
`checkbox`, which is the opt-out.

Because defaults are now authoritative, a default OUTSIDE a `select`'s own options is a boot ERROR
(`task_type_field_default_outside_options`): it would otherwise refuse every creation of the type
for a value the caller never sent.

## Parameters reach the prompt: one generic, value-authoritative fold

The collected values would be inert without this. The engine resolves a labeled projection once
per dispatch and the agents package renders it.

1. **`AgentContextBuilder.customTaskTypeFor`** calls kernel's `describeCustomTaskType`
   (`domain/task-type-context.ts`, the `describeOwnService` sibling), which joins the block's
   `taskTypeFields.custom` bag with the registered descriptor: declared fields first in
   descriptor order, then any undeclared bag key under its raw key, each value rendered through
   the shared `renderDescriptorFieldValue` (option captions over enum values, a multi-select
   joined, a boolean as `Yes`/`No`). Resolved once, so the container, inline and consensus paths
   cannot disagree.
2. **`customTaskTypeSection`** (`agents/src/agents/prompts/standard.ts`) formats it as a
   `## Task parameters (<label>)` list, APPENDED after the block-context template so the
   requester's own title and description stay the primary statement of what is wanted.

**The values are authoritative and the descriptor only enriches.** The descriptor lives in the
deployment's code while the bag lives in a row, so the two drift by construction (a node one
build behind, a withdrawn registration, a field renamed since the task was created). Drift may
therefore cost a LABEL and never a VALUE: an undeclared key renders under its raw key rather than
being dropped. The opposite would silently delete exactly the per-case brief the operation was
invoked with, and nothing downstream could tell.

The one thing that is NOT drift is a BUILT-IN type carrying a `custom` bag. A custom type is
namespaced by construction, so `feature` will never have a descriptor however current the build
is; the raw-id fallback that honestly names a WITHDRAWN operation would instead head a section
`## Task parameters (feature)` over keys nothing declared, which reads to the model as a
specification. So an un-namespaced type yields no projection at all.

> **The fold has THREE emit points**, and a new prompt-assembly site must emit it too or an
> operation's parameters silently vanish for that path: `renderStandardUserPrompt`, the generic
> branch of `buildBaseUserPrompt`, and the PREPEND for a registered kind that authors its own
> `userPrompt` (`agents/src/agents/catalog.ts`). The third matters most: an org's operation
> typically runs on that org's OWN kinds, which are exactly the kinds that author their own
> prompt.

The section is empty on every run that collected nothing, so every existing prompt is
byte-for-byte unchanged. That is the regression bar for any change to prompt composition. No
harness change and no image bump: the fold rides the user prompt the backend composes.

## Standing context, and the trait that gates it

`defaultFragmentIds` name best-practice fragments from the universal code pool (the built-in
catalog plus whatever the deployment passes to `promptFragmentRegistry.registerAll()`) or from the
tenant tiers (account / workspace rows, and the `src:<sourceId>:<slug>` ids of a repo-backed
fragment source).

- **Fragments fold only for `code-aware` / `doc-aware` agent kinds**
  (`AgentContextBuilder.resolveFragments`). An operation whose pipeline runs the deployment's own
  kinds must give those kinds the right traits, or its standing context reaches nothing. Testers
  are NOT code-aware.
- **A long fragment is folded as its condensed `brief` for implementer kinds** and in full for
  reviewer/planner kinds, so ship a `brief` alongside a long `body`
  ([`prompt-fragments/README.md`](../packages/prompt-fragments/README.md)).
- **`promptFragmentRegistry.registerTaskTypeDefaults()` is NOT the seam for an operation.** It
  attaches defaults to a BUILT-IN type, which has no descriptor to carry them. A registered type
  declares `defaultFragmentIds` on its own registration, where boot validation can see it.
- **A code-registered fragment is STATIC deployment content, because no document source has a
  deployment-scoped CREDENTIAL HOME yet.** It lands on the `builtin` tier, and `documentRef` is
  resolved only for the account/workspace tiers, so a registration carrying one is refused at boot
  (`fragment_document_ref_unsupported`) rather than rendered as live and ignored.

  The constraint is NOT the scope of the registration, which is correctly deployment-wide. It is
  that every document source authenticates per WORKSPACE: `DocumentContentResolverService` reads
  `connectionService.requireConnection(workspaceId, source)`, the one provider that stores no
  credentials (`github-docs`) rides `resolveImplicitConnection(workspaceId)` (the WORKSPACE's App
  installation), and `fetchDocument(credentials, externalId, workspaceId)` is workspace-parameterised
  besides. So honouring the field on today's resolver would mean the engine PICKING a workspace to
  fetch through on behalf of a fragment every workspace folds: one tenant's stored token pulling text
  into every other tenant's prompts, and one document keyed under N per-workspace cache groups.

  A deployment-scoped source is coherent and is the thing that is missing, not a category error (see
  "Not yet done"). Until it exists, register the body inline, or make a living ORG-WIDE document an
  ACCOUNT-tier fragment created with its `documentRef` and a fetch-via workspace, which is the
  supported path and the one the library UI's "live" badge tells the truth about. See
  [ADR 0040](./adr/0040-deployment-extension-seam-reachability.md).

- **Seeding STATES an unregistered type.** A task created on a process whose package lacks the
  registration is accepted and gets NONE of the operation's fragments, and a later build does not
  go back for it, because only the id SET freezes at creation. `BoardService` logs a warning
  naming the type rather than contributing nothing in silence. This is deliberately the opposite
  disposition from the dispatch-time fold, which degrades to raw keys and self-heals the moment
  the descriptor is there.

## Per-kind steering: variants plus the pipeline's `stepOptions`

An operation steers individual steps through registered variants of the kinds its pipeline runs:

```ts
agentKindRegistry.registerVariant({
  id: 'org:coder-api',
  baseKind: 'coder',
  promptAddition: 'Implement the API exactly as the design names it: paths, status codes, …',
  presentation: { label: 'Org API implementation', description: '…' },
})

pipelineRegistry.register({
  id: 'pl_org_introduce_api',
  name: 'Introduce API',
  builtin: true,
  version: 1,
  agentKinds: ['architect', 'coder', 'tester-api', 'conflicts', 'ci', 'merger'],
  stepOptions: [
    { agentVariantId: 'org:architect-api' },
    { agentVariantId: 'org:coder-api' },
    null,
    null,
    null,
    null,
  ],
})
```

A `promptAddition` composes with (rather than displacing) both the shipped prompt and a
workspace's own override of it, the selection is boot-validated
(`checkPipelineVariantSelections`), and what actually ran is recorded on `step.promptVariant`.
Registering a whole new KIND instead of a variant of `coder` would quietly lose every engine
decision keyed on `coder` (the follow-up companion, the fork decision, multi-repo fan-out, the
merge tail).

## The canned pipeline's lifecycle: register `builtin: true` WITH an explicit `version`

The two halves buy different things, and an operation's pipeline wants both:

- **`builtin: true`** makes it a read-only catalog template. A workspace CLONES it to deviate
  rather than editing the definition out from under the operation that pins it.
- **An explicit `version`** is the rollout channel. Bumping it marks every stored copy `outdated`,
  and the existing reseed adopts the new definition.

**A versionless (non-builtin) registration is the trap, and it is worse than "un-updatable": it
is editable AND frozen.** `reseed` refuses a stored non-builtin and the `outdated` check requires
`pipeline.builtin` on the stored row, so each workspace gets a copy it can edit or delete out
from under the operation and that the org can never fix. The full rules live in
[`pipeline-catalog-lifecycle.md`](./pipeline-catalog-lifecycle.md).

**Version never enters the reference.** `defaultPipelineId` is a bare id, `block.pipelineId` is a
bare id, and a run uses whatever definition the workspace's row currently holds. `version` exists
solely as the drift signal between the code catalog and the copied row.

**A board older than the registration is not stuck.** An operation PINS its pipeline by id, and
`pipelineIdFor` resolves that pin off the registry, which knows nothing about rows: a task of the
operation is creatable on such a board, and would then refuse to start with a bare 404. So run
resolution ADOPTS: `pipelineAdoption.adoptForRun` returns the stored row, else materialises the
catalog entry and returns that. Anything resolving a pipeline id must pick deliberately:
`adoptForRun` when it is about to run one, `resolveDefinition` when it is answering a question
about a prospective run. A bare `pipelineRepository.get` on a run-adjacent path is the smell.

## Boot validation: what refuses, what warns

`validateRegistrations` (`orchestration/src/validation/`) checks every registered type. The bar is
that boot ERRORS on anything fully knowable from the registration and WARNS only where it
structurally cannot see the answer.

| Code                                  | Severity | Cause                                                                               |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `task_type_not_namespaced`            | error    | the id is not `<ns>:<name>`, so it collides with the built-in picklist              |
| `task_type_form_panel_invalid`        | error    | `formPanel` is not a namespaced id                                                  |
| `task_type_unknown_pipeline`          | error    | `defaultPipelineId` resolves to neither a built-in nor a registered pipeline        |
| `task_type_field_duplicate`           | error    | the form declares one field `key` twice                                             |
| `task_type_field_no_options`          | error    | a `select` / `checkbox-group` with no options, so the form renders an empty picker  |
| `task_type_field_unknown_condition`   | error    | a `showWhen` gating a field on a key the form does not declare, so it never shows   |
| `task_type_field_section_interleaved` | error    | a `section` split by a field that can show beside both halves, so it captions twice |
| `task_type_unknown_fragment`          | **warn** | a `defaultFragmentIds` id the CODE pool does not resolve                            |

The fragment check is the one warning because both causes are live: a typo, or an
account/workspace-tier id, which merges per workspace at run time and is invisible at boot. The
message names both. The same checker covers an initiative preset's create form under the
`initiative_preset_field_*` prefix, so both surfaces are held to one bar.

### Fragment ids are late-bound, and a deployment may still demand strictness

Fragment resolution is intentionally LATE-BOUND across the three tiers. Boot sees only the code
pool (the shipped catalog plus this deployment's `registerAll`); an account- or workspace-tier row
merges per WORKSPACE at run time, and the `src:<sourceId>:<slug>` ids of a repo-backed source only
exist once that source has synced. So the platform cannot promise an id resolves, and refusing
every id it cannot see would reject the tenant-tier reference deployments are told to use.

The failure is nonetheless reported twice, because a warning that fires once at boot cannot say
what a given RUN went without: `FragmentLibraryService` logs the dropped ids per run with the
workspace and execution on the line, and counts them on `fragments.dropped_from_run` PER FRAGMENT.
A run seeded with five ids against an empty pool is five times as short of its standards as one
carrying a single typo, and the counter says so.

**A deployment that knows the second cause cannot apply to it says so**, rather than the platform
guessing which kind of deployment this is:

```ts
start({
  escalateRegistrationWarning: (p) => p.code === 'task_type_unknown_fragment',
})
```

An escalated problem joins the aggregated boot failure with the genuine errors (one report, every
problem at once) and is not also logged. The predicate takes the whole `RegistrationProblem`, so a
deployment can escalate one code, a family of them, or everything, and a warning added in a later
release is covered by a predicate that never mentioned it.

The severity stays platform judgement and the disposition becomes deployment policy. That split is
why this is a predicate rather than a second `strictFragmentIds` array on the descriptor: splitting
the declaration would make every operation restate, per id, a fact that is true of the whole
deployment, and would have to be repeated for `conditionalFragmentIds` and for every future
late-bound reference.

Set the SAME predicate on `start()` and `startLocal()`. A laptop is the cheapest place to learn
about a typo, and a boot that validates the same registrations must reach the same verdict.

## Registering an operation: the composition-root walkthrough

Everything lives in the deployment's own package, registered from its composition root. An
operation carries code (its pipeline names its variants and kinds), so it is exactly as trusted as
a custom agent kind.

```ts
// ONE import, from the facade the deployment boots through. Same names from
// `@cat-factory/node-server` and `@cat-factory/worker`.
import {
  defaultAgentKindRegistry,
  defaultPipelineRegistry,
  defaultTaskTypeRegistry,
  promptFragmentRegistryWithBuiltins,
  startLocal,
  type CustomTaskType,
  type PromptFragment,
  type RegistrationProblem,
} from '@cat-factory/local-server'

const agentKindRegistry = defaultAgentKindRegistry()
const pipelineRegistry = defaultPipelineRegistry()
const taskTypeRegistry = defaultTaskTypeRegistry()
// The shipped best-practice catalog, so the org's own standards join it rather than replace it.
const promptFragmentRegistry = promptFragmentRegistryWithBuiltins()

registerMyOrgOperations({
  agentKindRegistry,
  pipelineRegistry,
  taskTypeRegistry,
  promptFragmentRegistry,
})
startLocal({
  agentKindRegistry,
  pipelineRegistry,
  taskTypeRegistry,
  promptFragmentRegistry,
  // Optional: this deployment's operations reference only fragments it registers itself, so an
  // unresolvable id is always a typo here. See "Boot validation" above.
  escalateRegistrationWarning: (p: RegistrationProblem) =>
    p.code === 'task_type_unknown_fragment' /* …the rest */,
})
```

### The facade is the whole supported surface, and that is a dependency rule

**A deployment package's only cat-factory runtime dependency is the facade it boots through.** Each
of `@cat-factory/node-server`, `@cat-factory/local-server` and `@cat-factory/worker` re-exports the
constructor AND the types for every seam it lets you inject: the registries and their `default…()` /
`…WithBuiltins()` builders, the authoring vocabulary (`CustomTaskType`, `TaskTypePresentation`,
`TaskTypeFieldDescriptor`, `TaskTypeFieldOption`, `PromptFragment`, the shared `DescriptorField*`
shapes), the descriptor-field helpers, the `*_PIPELINE_ID` constants, and `RegistrationProblem`.

That is not ergonomics. Every `@cat-factory/*` package publishes at an EXACT version, so a consumer
that depends on `@cat-factory/kernel` or `@cat-factory/prompt-fragments` directly, and floats the
range onto a newer patch than its facade pins, resolves a SECOND physical copy. Registering by
reference survives that for a registry it built from the copy the facade reads, and does not survive
it otherwise: the symptom is agents that fold nothing, with no error anywhere. Reaching below the
facade is how a deployment re-creates the exact failure the registry seam was introduced to remove.

Three drift guards hold the surface: the app-owned registries are an option on `start()` /
`startLocal()` (`backend/runtimes/node/test/registry-seams.spec.ts`, derived from
`CoreDependencies` so a new registry fails to compile until it is classified), the same file asserts
each of those options has a CONSTRUCTOR exported beside it, and the local + Worker facades assert
they publish the same set. The two halves are separate on purpose, because they failed separately:
`pipelineRegistry` was a documented builder option no boot path forwarded, and `gateRegistry` /
`judgeRegistry` / `stepResolverRegistry` / `vcsRegistry` / `promptFragmentRegistry` were reachable
options with no exported way to build a value to put in them.

**An injected registry REPLACES the pool; it never merges.** So `promptFragmentRegistryWithBuiltins()`
is what a deployment wants unless it means the opposite, and a bare `defaultPromptFragmentRegistry()`
is a deployment whose agents fold its own standards and none of the platform's. Same for
`gateRegistryWithBuiltins()` against `defaultGateRegistry()`, where the empty one silently drops
`ci` / `conflicts` / `post-release-health` from every pipeline naming them. Both are legitimate,
which is why both are exported and neither is inferred.

Inside, order matters for boot validation rather than for behaviour: register the fragments and
the variants, then the pipeline that selects them, then the task type that names the pipeline, so
`validateRegistrations` resolves every reference.

1. **Standing context**: `promptFragmentRegistry.registerAll([...])` with the org's guidelines (or
   reference a repo fragment source's `src:<sourceId>:<slug>` ids; tenant-tier ids warn rather than
   refuse). Registering by REFERENCE onto the injected instance is what makes this work from a
   published install: the module-global `registerPromptFragments` it replaced was correct only
   while every reader resolved the same physical copy of `@cat-factory/prompt-fragments`, and a
   `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto a
   newer patch got two copies and every task of the operation folded nothing.
   A fragment registered here may NOT carry a `documentRef`: a code registration lands on the
   `builtin` tier, whose live resolution needs a connection workspace a deployment-wide
   registration cannot name, so boot refuses it (`fragment_document_ref_unsupported`) rather than
   rendering it as live and ignoring it. Register the body inline, or create the fragment at the
   ACCOUNT tier with a fetch-via workspace.
2. **Steering**: `registerVariant` per steered step.
3. **The canned pipeline**: `pipelineRegistry.register({ builtin: true, version: 1, … })`.
4. **The operation**: `taskTypeRegistry.register({ taskType, presentation, fields, defaultFragmentIds, defaultPipelineId })`.
   Standing context that depends on the ANSWERS a case supplies goes in `conditionalFragmentIds`:
   each entry is `{ when, fragmentIds }` where `when` is a `showWhen` condition in the same
   vocabulary the form's own field visibility uses, evaluated once at creation against the
   collected values. That is what lets one operation collecting `protocol: rest | graphql` seed the
   GraphQL standard only for a GraphQL case, instead of paying for every branch on every run or
   folding the conditional material into one long standard and losing its per-standard citation. A
   `when.key` naming a field the type does not declare fails boot.

Pass the SAME registry instances into the facade build. `resolveCoreRuntime` supplies an empty
default for an un-passed registry, and the engine reads `runtime.taskTypeRegistry` rather than an
injected argument, so `BoardService` and `AgentContextBuilder` see one instance: a facade that
forgets to thread it gets empty registries everywhere rather than a half-wired one.

## What the user sees

- **The create-task picker is GROUPED, not flat** (`app/utils/taskTypePicker.ts`
  `buildTaskTypePickerRows`): the built-in types first in one uncaptioned row, then one captioned
  row per declared `presentation.category` in REGISTRATION order (the only order the deployment
  expressed), then any uncategorized types under a translated "Other" heading. Captions fold on
  case and whitespace, so `API delivery` and `API Delivery` are one row, captioned as first
  written.
- **`presentation.description`** renders as the picker button's tooltip and, once the type is
  selected, as the type field's help text.
- **Descriptor strings are deployment-authored English, rendered verbatim**: labels, help,
  option captions, category captions, descriptions. Only the platform's own chrome around them is
  i18n, which is why the "Other" heading is the one caption a deployment does not supply. No
  custom strings enter a locale catalog.
- **Operations render in `basic` interface mode**, and their descriptor fields stay in both
  tiers. Task creation is the everyday delivery loop, and a descriptor field carries input
  nothing else supplies, so it is not an override to hide. Stated here so nobody tidies
  operations behind `isAdvanced`.
- **A document frame accepts only `document` and `spike` tasks** (`assertTaskTypeAllowed`), so an
  operation cannot be invoked inside one.

The frontend can also ship a task type as a CODE contribution to the `taskTypes` slot rather than
registering it on the backend, and the SPA merges both into one catalog. A code-shipped entry is
trusted and unvalidated, so prefer backend registration for the fail-fast guardrail. See
[`consumer-extensions.md`](../../frontend/app/app/docs/consumer-extensions.md).

## Per-workspace suppression: hiding an operation from one board

A deployment registers its operations PROCESS-WIDE, so every board in the org offers every one of
them. Twenty operations is a realistic org catalog and a flooded picker for a team that runs three,
so a workspace admin can hide the ones that board does not use.

The store is a set of TOMBSTONES (`task_type_suppressions`, keyed `(workspaceId, taskType)`): a row
means "this board does not offer this operation", and restoring hard-DELETES it. Absence is
therefore the default and nothing needs seeding: a newly registered operation is offered everywhere
until somebody hides it, the only direction that cannot silently withhold a capability from every
existing board at once.

Three surfaces read it, and they read it differently on purpose:

| Surface                                | Read                     | On a read failure                                                                        |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| The board snapshot's `customTaskTypes` | filter the projection    | BEST-EFFORT: a picker must never take a board load down over a cosmetic preference       |
| `GET /api/v1/task-types`               | filter the catalog       | best-effort, same reason: a startup discovery must not fail over one                     |
| `BoardService.addTask`                 | refuse a suppressed type | PROPAGATES: this decides whether a row is WRITTEN, and it hits the same DB as the insert |

The creation refusal is what makes the hiding real. The picker not offering a type is presentation;
the internal API, the public API, an initiative spawn and a tracker import all reach `addTask`
without ever seeing one.

Two rules bound the surface:

- **The LIST is its own read** (`GET /workspaces/:ws/task-type-suppressions`, `settings.manage`).
  A suppressed type is by construction absent from the projected catalog, so nothing else could
  offer the way back. The foundational-services suppression model, for the same reason.
- **The snapshot carries the COMPLEMENT too**, as `suppressedTaskTypes` (ids only), exactly as
  `retiredPipelines` complements `pipelineCatalogVersions`. Without it the offered catalog is
  ambiguous in the one direction that traps a user: an admin hiding the LAST operation empties
  `customTaskTypes`, which reads identically to a deployment that registers none, so the SPA drops
  the settings tab that is the only way to un-hide one. The tab is gated on the union of the two.
- **BUILT-IN types are not suppressible.** They carry hardcoded creation affordances (the
  document-frame restriction, the per-type form sections), so hiding one would remove a capability
  with no descriptor stating what was lost. Suppressing an id the deployment does not register is a
  404; RESTORING one is not, so a withdrawn registration never strands a row only a database edit
  could clear.

## The public API: discover a form, then fill it

`/api/v1` could always NAME a task type and could fill none of it, so a headless caller filed an
operation and every agent in the run worked from a blank form. Two additive changes close that
(ADR [0034](./adr/0034-public-api-stability.md); OpenAPI minor + SDK regeneration):

- **`GET /api/v1/task-types`** (`read`) serves the built-in types plus this workspace's registered,
  non-suppressed ones, each with the fields it accepts. `formPanel` is deliberately not projected:
  it names a component in the deployment's own SPA layer, which no external client can act on.
- **`fields` on task creation** fills them. For a registered custom type the values land in
  `taskTypeFields.custom`; for a BUILT-IN type they land on the schema-typed TOP-LEVEL keys, so the
  existing creation machinery (the review task's PR resolution, the document fields) runs unchanged.

ONE table stands behind both directions (`contracts/src/public-task-types.ts`), which is the point:
the built-ins get real descriptors rather than a hand-written OpenAPI shape beside a validator, so
what discovery advertises is exactly what creation checks, through the same shared
`validateDescriptorFields` the app's own form runs. Refusal is a 422 with
`details.reason: 'task_type_fields_invalid'` and every problem at once, because a headless caller
fixing one field per round trip against a form it cannot see is the experience this exists to avoid.

An unregistered namespaced type has no descriptor to check against; its values are carried through
verbatim, matching the internal door's pass-through (task types are node-local by design, below).

## Mothership position: node-local by design

Mothership mode's rule is that code-registered state a RUN resolves rides its own `/internal/*`
read from the mothership. A `CustomTaskType` deliberately does NOT, because it is inseparable
from the code registered beside it: its `defaultPipelineId` names a pipeline in the same package,
that pipeline names kinds and variants (functions, which cannot cross a wire), its
`defaultFragmentIds` name fragments in the same pool, and its `formPanel` names a frontend
component in the same layer. Serving the descriptor from the mothership while the executable half
stayed node-local would produce a MIXED bundle (a v2 descriptor naming a pipeline the node's v1
package lacks), which boot validation structurally cannot see. The unit of distribution is the org
package, exactly as for custom agent kinds.

Named honestly, the consequences: a node one build behind offers last build's operations (the
same lag its agent kinds already have); a stock node in an org deployment offers no org operations
at all (an absence, not a wrong answer, and a foreign-created typed task degrades to the `feature`
presentation); a run of such a task on a package-less node fails loudly at admission with an
unknown kind. The value-authoritative fold is built for exactly this drift.

## The worked example

`backend/internal/example-custom-agent/src/introduce-api.ts` registers `org:introduce-api`, the
acceptance proof, org-flavored and never shipped as product:

- **Three fragments** (`org.api-guidelines`, `org.api-auth-requirements`,
  `org.shared-services-map`), each with a `brief` so the two-tier standards fold is exercised.
- **Two variants**, `org:architect-api` and `org:coder-api`.
- **`pl_org_introduce_api`**, registered `builtin: true, version: 1`:
  `architect → coder → tester-api → conflicts → ci → merger`, with `stepOptions` selecting the
  variants on the first two steps.
- **The task type**: `category: 'API delivery'`, and a form exercising the vocabulary end to end:
  a required `entity` (text), `operations` (`checkbox-group` with `defaultValues`),
  `resourceStyle` (`select` with a `default`), an `actionName` gated by
  `showWhen: { key: 'resourceStyle', equals: 'action' }`, a required `authRequirement`
  (`select`), and `notes` (textarea, whose multi-line value the prompt section renders as an
  indented block).

A user picks "Introduce API" on a service, fills the form, and creates. The task carries the
frozen field bag, the seeded fragment ids and the pinned pipeline; the run dispatches the
variant-steered architect (which sees the labeled parameters, the folded standards and the
foundational-services catalog via its trait), then the coder, the tester and the merge tail.

## Testing

- **Conformance** (`backend/internal/conformance/src/suites/agent-task-types.ts`,
  `defineTaskTypeConformance`) asserts the system behaviour on BOTH runtimes: the snapshot
  projection and a typed task round-trip, the standing-context seeding plus the parameter fold,
  the refusal of a bag that contradicts the descriptor, a built-in type folding nothing, the
  pipeline rollout lifecycle (advisory → reseed insert → version bump → adopt), and adoption
  happening exactly once under concurrent starts. New assertions for this surface go THERE.
  It asserts the resolved CONTEXT rather than the prompt: `FakeAgentOptions.echoTaskParams`
  echoes the projection the way `echoPreset` does, because what needs proving per runtime is that
  the sparse bag survives persistence and reaches dispatch.
- **Unit**: the rendering is pure and covered in `@cat-factory/agents`
  (`prompts/custom-task-type-section.test.ts`, including the byte-identical-without-parameters
  bar); the join in `@cat-factory/kernel`; the creation defaults and the validation in
  `orchestration/src/modules/board/taskTypeCreationDefaults.test.ts`; the picker row layout in
  `app/utils/taskTypePicker.ts`'s spec.
- **End-to-end**: the dogfood consumer module's `acme:incident` gives the grouped picker
  assembled-product coverage (`consumer-extension.spec.ts`), which is what catches a template
  regression that flattens the rows while every unit test stays green.

## Not yet done

Tracked in [`docs/initiatives/reusable-operations.md`](../../docs/initiatives/reusable-operations.md):

- **A `detect` prefill probe** (the initiative-preset mirror), deferred: operation forms carry
  per-case BUSINESS input, which no repo probe can prefill.
- **Data-only operations** authored in the UI with no code: the descriptor/code split keeps the
  pure-JSON subset expressible, but there is no non-code registration path, matching the
  initiative-preset stance.
- **A DEPLOYMENT-SCOPED document source**, which is what a living deployment-owned standard needs
  (above). Not blocked on the idea: a deployment already configures credentials in its own
  environment, and its fragments are already deployment-wide, so the shape is a provider
  authenticated from deployment config, a `fetch` that takes no workspace, and ONE cache group
  instead of N. Three pieces have to be decided together, which is why it is an initiative and not a
  field on the registration:

  1. **An owner scope below `account`.** `FragmentTier` and the connection model both bottom out at
     the account, so `deployment` is a new tier the merge, the cache key and the library UI each
     have to render honestly (a badge that says "live from the deployment", not "live from this
     board's connection").
  2. **A credential home.** Deployment config, which puts it beside `GITHUB_APP_*` rather than in
     `document_source_connections`, and means every provider needs an env-configured construction
     path beside its stored-connection one.
  3. **Mothership routing**, the genuinely hard one. The credential lives on the mothership and
     `ENCRYPTION_KEY` never reaches a laptop, so a node cannot resolve the document itself: it needs
     the RESOLVED BODY over `/internal/*`, on the `builtin`-tier foundational-services pattern,
     including the rule that the read THROWS rather than answering empty.

  Until then the ACCOUNT tier is the supported path and the boot refusal is the honest report, since
  the field genuinely does nothing today.
