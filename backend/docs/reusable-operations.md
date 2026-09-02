# Reusable operations: canned, parameterized units of work an org runs again and again

> **Packaging one is on the website**:
> [Package a Reusable Operation](https://www.catfactory.ai/extend/reusable-operations.html) owns the bundle, the
> form vocabulary, the boot-validation table and the composition-root walkthrough. This page is the
> ENGINE side: why nothing branches on a task-type id, how the collected values reach a prompt, and
> what a node one build behind does with an operation it has never heard of.

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

> The design record, including the alternatives rejected and what is deliberately left open, is
> [ADR 0042](./adr/0042-reusable-operations.md), and
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

The four-way choice (plain custom task type, reusable operation, initiative preset, recurring
schedule) and its litmus are on the site's
[Which vehicle to reach for](https://www.catfactory.ai/extend/reusable-operations.html#which-vehicle-to-reach-for).
The line that matters to the engine: an operation is ONE invocation producing ONE typed task, so
nothing here spawns, plans or decomposes. Work that must be planned first is an initiative preset
([`initiative-presets.md`](./initiative-presets.md)), which is a different registry with a
different loop.

## The bundle: where each field is consumed

The descriptor's shape (`fields`, `defaultFragmentIds`, `defaultPipelineId`, `presentation`,
`formPanel`) is on the site's [The bundle](https://www.catfactory.ai/extend/reusable-operations.html#the-bundle),
along with what a deployment author writes in each. Where each one is READ is here, because that is
the part a change in this repository has to keep true:

| Descriptor field     | Read at            | By                                                                           |
| -------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `fields`             | creation, dispatch | `BoardService.addTask` validates; `describeCustomTaskType` labels the values |
| `defaultFragmentIds` | creation only      | `board/taskTypeCreationDefaults.ts` unions them onto the new task            |
| `defaultPipelineId`  | run resolution     | `pipelineIdFor`, then `pipelineAdoption.adoptForRun`                         |
| `presentation`       | snapshot           | the board projection, and the SPA's grouped create picker                    |
| `formPanel`          | creation           | stands the platform's field validation DOWN: the panel owns the whole bag    |

Only the fragment id SET freezes at creation; the BODIES live-resolve per run against the merged
builtin ⊕ account ⊕ workspace catalog, so editing a guideline reaches every future run of an
already-created task.

## The per-case form: one shared descriptor vocabulary

The field types, their options, the `showWhen` predicate pair and the `section` rules are on the
site's [The per-case form](https://www.catfactory.ai/extend/reusable-operations.html#the-per-case-form).
Three facts about the vocabulary belong here:

- **It is ONE vocabulary, in `backend/packages/contracts/src/form-fields.ts`**, shared with an
  initiative preset's create form, so a form that renders in one surface renders in the other and
  one validator covers both. A new field type is added there or not at all.
- **The whole vocabulary and its four helpers** (`validateDescriptorFields` /
  `sanitizeDescriptorFields` / `isDescriptorFieldVisible` / `renderDescriptorFieldValue`) are
  re-exported from every runtime FACADE, so a deployment types its descriptors and runs the
  platform's own validator over them in its tests with the facade as its only dependency. Kernel
  re-exports them too, for a package that legitimately sits at that layer.
- **Adding a `showWhen` predicate is not a local change.** The vocabulary is published in
  `/api/v1/task-types` and rendered by four SDKs, and `duplicatedDescriptorSectionCaptions` decides
  section reachability by proving two conditions can be satisfied at once, so a third predicate has
  to state how it contradicts the existing two. It rides the first real operation that needs it.

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

Which kinds a fragment reaches, the two-tier `brief` fold and `conditionalFragmentIds` are on the
site's
[Standing context](https://www.catfactory.ai/extend/reusable-operations.html#standing-context). The
gate itself is `AgentContextBuilder.resolveFragments`, and the seam question it answers is here:

- **`promptFragmentRegistry.registerTaskTypeDefaults()` is NOT the seam for an operation.** It
  attaches defaults to a BUILT-IN type, which has no descriptor to carry them. A registered type
  declares `defaultFragmentIds` on its own registration, where boot validation can see it.
- **A code-registered fragment MAY name a living document**, resolved with credentials the
  DEPLOYMENT configured rather than any tenant's connection. Set `DOC_SOURCE_<SOURCE>_<FIELD>` for
  the source (`DOC_SOURCE_NOTION_API_TOKEN`, `DOC_SOURCE_CONFLUENCE_BASE_URL` / `_ACCOUNT_EMAIL` /
  `_API_TOKEN`, …: the field names are each provider's own, the ones its connect form already
  declares, in SCREAMING_SNAKE) and register the fragment with a `documentRef`. The body then
  re-resolves per run,
  version-probed and cached like every other document-backed fragment, and degrades to the
  registered `body` with a WARNING naming the fragment when the source is unreachable.

  Two rules bound it, and both are about the credential rather than the registration:

  - **The document is fetched ONCE for the whole deployment**, under a single deployment-wide cache
    group, so a hundred workspaces folding one standard cost one fetch and one invalidation. That is
    the same rule the account tier's `docViaWorkspaceId` enforces, applied one tier up.
  - **`github` cannot be configured this way.** Its credential is a WORKSPACE's App installation,
    not a value a deployment holds, so serving one document to every workspace would mean spending
    one tenant's installation on all of them. It is the one source whose `deploymentScoped` trait is
    false, and boot refuses a registration naming it with a message that says so rather than
    pointing at a variable that cannot exist.

  **Boot refuses what this deployment cannot serve** (`fragment_document_ref_unsupported`): a source
  with no configured credentials, or one that can never be deployment-scoped. Fully knowable from
  the registration plus this process's own configuration, which is the bar every severity here is
  set by, and the alternative is a reference the library UI badges as live while every run folds the
  frozen body. In MOTHERSHIP mode the node is judged and served by the mothership, which is where
  the credentials live; see [ADR 0045](./adr/0045-deployment-scoped-documents.md).

- **Seeding STATES an unregistered type.** A task created on a process whose package lacks the
  registration is accepted and gets NONE of the operation's fragments, and a later build does not
  go back for it, because only the id SET freezes at creation. `BoardService` logs a warning
  naming the type rather than contributing nothing in silence. This is deliberately the opposite
  disposition from the dispatch-time fold, which degrades to raw keys and self-heals the moment
  the descriptor is there.

## Per-kind steering: variants plus the pipeline's `stepOptions`

Registering a variant and selecting it positionally is on the site's
[Steering individual steps](https://www.catfactory.ai/extend/reusable-operations.html#steering-individual-steps).
What that page states as advice is an engine fact here: registering a whole new KIND instead of a
variant of `coder` loses every engine decision keyed on `coder` (the follow-up companion, the fork
decision, multi-repo fan-out, the merge tail), because those are `agentKind` comparisons rather
than trait lookups. The selection is boot-validated by `checkPipelineVariantSelections`, and what
actually ran is recorded on `step.promptVariant`.

## The canned pipeline's lifecycle

Register `builtin: true` WITH an explicit `version`, and never a versionless non-builtin: the
reasoning is on the site's
[The canned pipeline](https://www.catfactory.ai/extend/reusable-operations.html#the-canned-pipeline-builtin-true-with-an-explicit-version),
and the full rules are [`pipeline-catalog-lifecycle.md`](./pipeline-catalog-lifecycle.md).

The engine-side consequence, which is where a change in this repository goes wrong: an operation
PINS its pipeline by id and `pipelineIdFor` resolves that pin off the REGISTRY, which knows nothing
about stored rows, so a task of the operation is creatable on a board older than the registration
and would then refuse to start with a bare 404. Run resolution therefore ADOPTS
(`pipelineAdoption.adoptForRun` returns the stored row, else materialises the catalog entry).
Anything resolving a pipeline id picks deliberately: `adoptForRun` when it is about to run one,
`resolveDefinition` when it is answering a question about a prospective run. A bare
`pipelineRepository.get` on a run-adjacent path is the smell.

## Boot validation: the bar, and the one warning

`validateRegistrations` (`orchestration/src/validation/`) checks every registered type, and the
per-code table is on the site's [Boot validation](https://www.catfactory.ai/extend/reusable-operations.html#boot-validation).
The bar the table is derived from is the part to preserve: **ERROR on anything fully knowable from
the registration, WARN only where the platform structurally cannot see the answer.** A new check
picks its severity by that test and nothing else. The same checker covers an initiative preset's
create form under the `initiative_preset_field_*` prefix, so both surfaces are held to one bar.

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
problem at once) and is not also logged. The predicate takes the whole `RegistrationWarning`, so a
deployment can escalate one code, a family of them, or everything, and a warning added in a later
release is covered by a predicate that never mentioned it.

**A declaration that MIXES the tiers is disposed of per id**, because the warning names ONE
`subject` (here the unresolved fragment id) and one unresolved id is one warning:

```ts
escalateRegistrationWarning: (p) =>
  p.code === 'task_type_unknown_fragment' && !p.subject.startsWith('src:'),
```

That is the shape to reach for whenever `defaultFragmentIds` holds code-registered standards beside
a `src:…` reference, which the tier vocabulary above sanctions: the typo fails boot and the
late-bound id stays a warning. **The platform's own severity has not moved** and does not depend on
the id's shape. It cannot: a hand-authored account-tier row and a repo-sourced file pinning an
explicit frontmatter `id` both carry a plain slug, so "matches no late-bound prefix" is not evidence
of a typo, and only the deployment knows which of its own ids are code-tier. Design record:
[ADR 0063](./adr/0063-registration-warning-subjects.md).

The severity stays platform judgement and the disposition becomes deployment policy. That split is
why this is a predicate rather than a second `strictFragmentIds` array on the descriptor: splitting
the declaration would make every operation restate a fact the predicate states once, and would have
to be repeated for `conditionalFragmentIds` and for every future late-bound reference.

Set the SAME predicate on `start()` and `startLocal()`. A laptop is the cheapest place to learn
about a typo, and a boot that validates the same registrations must reach the same verdict.

## Registering an operation: what holds the surface up

The composition-root walkthrough, the registration order and the two rules that bite (the facade is
the only dependency; an injected registry replaces the pool rather than merging) are on the site's
[Registering from your composition root](https://www.catfactory.ai/extend/reusable-operations.html#registering-from-your-composition-root).

### Three drift guards hold that surface

The facade rule is only true while the facades actually re-export what they promise, and it failed
in two separate ways before it was guarded:

- The app-owned registries are an option on `start()` / `startLocal()`
  (`backend/runtimes/node/test/registry-seams.spec.ts`, derived from `CoreDependencies` so a new
  registry fails to compile until it is classified).
- The same file asserts each of those options has a CONSTRUCTOR exported beside it.
- The local and Worker facades assert they publish the same set.

The halves are separate on purpose, because they failed separately: `pipelineRegistry` was a
documented builder option no boot path forwarded, and `gateRegistry` / `judgeRegistry` /
`stepResolverRegistry` / `vcsRegistry` / `promptFragmentRegistry` were reachable options with no
exported way to build a value to put in them.

`resolveCoreRuntime` supplies an empty default for an un-passed registry, and the engine reads
`runtime.taskTypeRegistry` rather than an injected argument, so `BoardService` and
`AgentContextBuilder` see one instance: a facade that forgets to thread it gets empty registries
everywhere rather than a half-wired one.

## Presentation

The grouped create picker, where `presentation.description` renders, the verbatim-strings rule and
the interface-mode position are on the site's
[What your users see](https://www.catfactory.ai/extend/reusable-operations.html#what-your-users-see). The layout itself
is `app/utils/taskTypePicker.ts`'s `buildTaskTypePickerRows`, pinned by its own spec.

Two repo-side notes:

- **Descriptor strings never enter a locale catalog.** They are deployment-authored and rendered
  verbatim; only the platform's own chrome around them is i18n, which is why the "Other" heading is
  the one caption a deployment does not supply.
- **The frontend can also ship a task type as a CODE contribution** to the `taskTypes` slot rather
  than registering it on the backend, and the SPA merges both into one catalog. A code-shipped entry
  is trusted and unvalidated, so prefer backend registration for the fail-fast guardrail. See
  [`consumer-extensions.md`](../../frontend/app/app/docs/consumer-extensions.md).

## Per-workspace suppression: the three reads

Why a workspace admin can hide an operation, and that hiding is a refusal rather than a missing
picker entry, are on the site's
[Hiding an operation from one board](https://www.catfactory.ai/extend/reusable-operations.html#hiding-an-operation-from-one-board).

The store is a set of TOMBSTONES (`task_type_suppressions`, keyed `(workspaceId, taskType)`), so
absence is the default and nothing needs seeding: the only direction that cannot silently withhold a
capability from every existing board at once.

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

## The public API: one table behind both directions

What the two endpoints serve is on the site's
[Discovering an operation over the public API](https://www.catfactory.ai/extend/reusable-operations.html#discovering-an-operation-over-the-public-api).
Both were additive (ADR [0034](./adr/0034-public-api-stability.md); OpenAPI minor + SDK
regeneration), and a built-in type's `fields` land on the schema-typed TOP-LEVEL keys rather than in
the custom bag, so the existing creation machinery (the review task's PR resolution, the document
fields) runs unchanged.

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

Each with its warrant bar stated in [ADR 0042](./adr/0042-reusable-operations.md):

- **A `detect` prefill probe** (the initiative-preset mirror), deferred: operation forms carry
  per-case BUSINESS input, which no repo probe can prefill.
- **Data-only operations** authored in the UI with no code: the descriptor/code split keeps the
  pure-JSON subset expressible, but there is no non-code registration path, matching the
  initiative-preset stance.
