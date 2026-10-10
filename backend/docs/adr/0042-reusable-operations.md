# ADR 0042: Reusable operations are task types carrying a bundle, not a second registry

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/kernel`,
  `@cat-factory/agents`, `@cat-factory/orchestration`, `@cat-factory/prompt-fragments`,
  `@cat-factory/server`, both runtime facades) + the SPA (`@cat-factory/app`) + the four SDKs

Supersedes the `reusable-operations` initiative tracker, whose committed scope is complete. The
authority for how the shipped mechanism BEHAVES is
[`reusable-operations.md`](../reusable-operations.md); this record keeps the decisions and the
alternatives they were chosen against. Related:
[ADR 0029](./0029-agent-kind-capabilities.md) (the extension trust model these registrations
inherit), [ADR 0031](./0031-foundational-services.md) (trait routing and the suppression model
copied here), [ADR 0040](./0040-deployment-extension-seam-reachability.md) (the seam-reachability
findings an org package building one of these surfaced).

## Context

An organisation wants to run a shaped unit of work over and over: "introduce an API on top of
existing functionality", once per entity, with per-case input ("expose CRUD for X", "expose
operation Y"). Every run of it leans on the SAME standing context (the org's API guidelines, its
auth requirements, its shared-services map) and differs only in a handful of answers a person
gives at invocation. Getting that consistency today depended on whoever filed the ticket
remembering to attach the right fragments and pick the right pipeline.

The anchor already existed and was most of the way there. A registered `CustomTaskType` carries a
namespaced id, presentation, a data-driven create form, and a boot-validated default pipeline; its
values persist on the block as `taskTypeFields.custom` and ride `AgentRunContext`. What it lacked
against "a reusable operation" was enumerable rather than architectural:

- the collected parameters reached **zero prompts**: the bag was threaded onto the run context and
  no prompt section rendered it, so the answers a person typed were invisible to every agent;
- the standing-context fragment set had no home on the descriptor, only a module-global side
  channel that validated nothing;
- the form vocabulary was four input types against the initiative presets' eight, with no
  defaults and no conditional visibility;
- the type picker was a flat button row that could not group an org's twenty operations, and
  `presentation.description` was rendered nowhere;
- the public API could NAME a custom type and fill not one of its fields, and had no discovery.

## Decision

**Widen the task type; add no parallel registry.** One invocation is one typed task is one
pipeline run. The mechanism keeps the name "task type" everywhere an id, a schema or a wire field
appears; "reusable operation" is the documentation word for the pattern, exactly as "initiative
preset" is the product word for `InitiativePresetRegistration`.

The bundle and the seven decisions that carry it:

1. **The descriptor gains `defaultFragmentIds` and `presentation.category`**, both optional so
   every existing registration is untouched. Fragment ids are seeded at task creation into the
   same union `BoardService.addTask` already computed; the BODIES keep live-resolving at run time,
   so an org edits a guideline and every future run sees it, and only the id SET is per-task
   state.
2. **Parameters reach the prompt through ONE generic fold in which the VALUES are authoritative
   and the descriptor only enriches.** The engine resolves a labelled projection once per dispatch
   (kernel's `describeCustomTaskType`, the `describeOwnService` sibling) and the agents package
   renders it as a `## Task parameters (<label>)` section, appended after the block-context
   template so a derived subject never displaces the requester's words. A missing or stale
   registration degrades to raw keys and never to a dropped value.
3. **One shared field-descriptor vocabulary** (`contracts/src/form-fields.ts`), used by task types
   and initiative presets alike, with each surface declaring its own allowed type picklist over
   it. `password` is excluded for task types by construction: a task field value lands in prompts,
   the board snapshot, telemetry and potentially PR text, and secrets have the
   capability-credential store ([ADR 0041](./0041-capability-credential-store.md)).
4. **Validation at every door, not at the form.** Creation validates the filled bag against the
   descriptor in `BoardService.addTask`, so the SPA, the internal API and the public API get one
   rule, with server-side defaults applied first so a `required` field carrying a `default` is not
   accepted from a browser and refused from a script. Three cases pass through unchecked on
   purpose: a built-in type (its fields are schema-typed top-level keys), an unregistered
   namespaced type (a supported row, per decision 6, so degrading data must not brick creation),
   and a descriptor declaring a `formPanel` (the panel owns its bag).
5. **An operation's canned pipeline is a read-only versioned catalog template**, registered
   `builtin: true` with an explicit `version`: read-only in workspaces (clone to deviate), rolled
   out by a version bump plus the existing reseed advisory, withdrawn by `retire`. A VERSIONLESS
   registration is the trap, and it is worse than "un-updatable": each workspace gets a copy it
   can edit or delete out from under the operation and the org can never fix.
6. **A run ADOPTS an operation's pipeline rather than refusing.** An operation PINS its pipeline by
   id off the registry, which knows nothing about rows, so on a board older than the registration a
   task was creatable and then refused to start with a bare 404. `pipelineAdoption.adoptForRun`
   returns the stored row else materialises the catalog entry, and the read-only
   `resolveDefinition` twin serves the gates standing in FRONT of a start.
7. **Task types are node-local in mothership mode; the per-workspace suppression rows are
   `remote`.** A descriptor is inseparable from the code registered beside it (its pipeline names
   custom kinds and variants, which are functions; its `formPanel` names a frontend component), so
   serving it from the mothership while the executable half stays node-local would produce a mixed
   bundle no boot validation can see. The per-workspace CHOICE about a descriptor is pure data with
   no co-registered code, so it routes the other way.

## Rationale

**Why not a new `OperationRegistry`.** The task type IS the anchor and already had the registry,
the snapshot projection, the picker, the boot validation and the conformance seam. A second
registry would have duplicated all five and left two things a deployment must keep in step.

**Why not stretch initiative presets.** A plan-of-one adds an interview, a planner and an ingest
for nothing. The boundary is a litmus, not a preference: when the create-form answers ARE the whole
per-case brief and one pipeline delivers one outcome, it is an operation; the moment the work needs
"research first, then apply", it is an initiative preset. Single-task bounds the granularity of
INVOCATION, not the rigour of the run: an operation's pipeline may carry requirements review,
judges, consensus panels and the full merge tail.

**Why the fold is value-authoritative.** The alternative, freezing descriptor labels onto the block
at creation, duplicates registry state into rows and goes stale against a re-registered descriptor.
Rendering from the values with the descriptor enriching gets the drift safety without the copy:
drift costs labels, never data. The rule stops at a NAMESPACED type, and that boundary is
load-bearing rather than incidental: an un-namespaced id like `feature` has no descriptor however
current the build is, so the raw-id fallback would head a section `## Task parameters (feature)`
over keys nothing declared, which is not drift costing a label but a fabricated operation identity
a model reads as a specification.

**Why no `promptAdditions` on the descriptor.** An operation OWNS its registered pipeline, so
per-step steering is already available through registered variants selected by the pipeline's
`stepOptions[i].agentVariantId`: boot-validated, composing correctly with workspace prompt
overrides, and recorded honestly on `step.promptVariant`. A second text channel would have
undefined precedence against both. This is the one place an operation differs from an initiative
preset, which does not own its spawned items' pipelines and therefore has no such seam.

**Why no foundational-service pin on the descriptor.** Routing is by trait and consumption is by
the design's fenced declaration (ADR 0031); a pin would bypass both and re-create the
kind-id-list anti-pattern.

**Why suppression is a TOMBSTONE and not a `visible` row.** The opposite shape reads as more
explicit and would withhold every newly registered operation from every existing board until
somebody noticed. Absence-means-offered is the only direction whose silent failure is a surplus.

**Why the three readers of the suppression set disagree about failure ON PURPOSE.** The snapshot
projection and the public catalog are best-effort, because a picker must never take a board load or
a startup discovery down over a cosmetic preference; the creation check PROPAGATES, because it
decides whether a row is written and it hits the same database the insert on the next line goes to,
so there is no outage for it to ride out.

**Why adoption rather than the two cheaper options.** Resolving from the catalog without persisting
would run a pipeline the board's own library does not list, cannot open in the builder and cannot
schedule: "absent renders as empty" in its worst form, where the library actively says "you do not
have this" while a run executes it. Auto-seeding registered built-ins at boot or on board load
would give `seedPipelines` a filter or a write-behind, which it must never gain. Adoption is the
same write made where the need is PROVEN.

## Consequences

**The engine never branches on a task-type id.** Every deviation is descriptor data resolved at two
moments: creation (fragments, pipeline pin, validation) and dispatch (the projection). A
`switch (taskType)` in the engine is the anti-pattern this whole design exists to avoid.

**The prompt fold has THREE emit points** (`renderStandardUserPrompt`, the generic branch of
`buildBaseUserPrompt`, and the prepend for self-authoring registered kinds), because the first two
return early for a standard phase and for a kind with its own `userPrompt`. A new prompt-assembly
site must emit it too, or an operation's parameters silently vanish for exactly the runs that use
it. Byte-identical prompts on a run WITHOUT custom fields is the regression bar.

**Fragments fold only for `code-aware` / `doc-aware` kinds.** An operation whose pipeline uses
custom kinds must give those kinds the traits; testers are not code-aware.

**Standing-context SEEDING and the prompt FOLD degrade differently, deliberately.** Only the id set
freezes at creation, so a task created on a process whose package lacks the registration never
gains the operation's fragments and a later build does not go back for it (which is why seeding
STATES an unregistered type), where the projection self-heals the moment the descriptor is there.

**A pipeline id resolved on a run-adjacent path must pick its source deliberately**: `adoptForRun`
when a run is about to start, `resolveDefinition` when answering a question about a prospective one.
A bare `pipelineRepository.get` there is now the smell, and the transferable rule the adoption work
surfaced is that any `?? []`, `if (!pipeline)` or nullable-row branch in front of a start deserves
the same suspicion, because the degradation is silent AND permissive. Two AUTHORING paths still
refuse an un-adopted pipeline on purpose (`InitiativeService.assertPipelineExists`,
`RecurringPipelineService`): they record a choice for later rather than standing in front of a run,
so a refusal there is honest and adopting would materialise rows for pipelines nobody ran.

**Descriptor strings are deployment-authored English rendered verbatim**; only surrounding chrome
is i18n. No custom strings enter locale catalogs.

**A new resource GROUP in the public API touches hand-written code in one SDK and exercises
spelling paths in three others.** The Go client's accessor list is hand-written (`check-sdks.mjs`
now fails on a group it never constructs), the Python emitter camelCases group names and suffixes
reserved member names, and the MCP facade puts the group in the TOOL NAME a host allow-lists.
`taskTypes` was the first multi-word group and found all four.

**Deliberately left open**, each with its warrant bar stated rather than as an oversight:

- A `detect?` prefill probe on the descriptor. Operation forms carry per-case BUSINESS input, which
  no repo probe can prefill; the preset probe earns its keep on repo-derived facts. If a real org
  form warrants one, it mirrors the preset shape exactly.
- A `TaskTypeSource` `/internal` read. Revisit only if task types ever gain a data-only tier
  (tenant-defined types with no co-registered code), which is what would break decision 7's
  premise.
- Suppressing BUILT-IN task types per workspace. They carry hardcoded creation affordances (the
  document-frame restriction, per-type form sections).
- Data-only, UI-authored operations. The descriptor/code split keeps the pure-JSON subset
  expressible, but there is no non-code registration path, matching the initiative-preset stance.
