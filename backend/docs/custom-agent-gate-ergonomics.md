# Custom agent & gate authoring ergonomics

> **Authoring a gate or a judge is on the website**:
> [Custom Gates & Judges](https://www.catfactory.ai/extend/custom-gates.html) owns the
> registration and the shapes, with agent kinds on
> [Custom Agents](https://www.catfactory.ai/extend/custom-agents.html). This page is the
> ergonomics layer both sit on: the helpers, and what fails loudly at boot.

Companion to [`custom-agents.md`](./custom-agents.md) (the three-stage agent model) and the
"Gates vs agents" section of [`../../CLAUDE.md`](../../CLAUDE.md). That doc covers _what_ the
extension seams are; this one covers the ergonomics layered on top so writing a custom agent
kind or gate is less boilerplate-heavy and fails loudly when misconfigured.

The canonical worked example exercising everything below is
[`backend/internal/example-custom-agent`](../internal/example-custom-agent/src/index.ts).

## Why

Four rough edges made authoring a custom agent/gate harder than it should be:

1. **Provider wiring boilerplate + an unsafe `!`.** Every gate's data source was a module
   global trio (`let provider; wireFoo(); getFoo()`) re-authored in each package, and the
   gate read it with a non-null assertion (`getFoo()!`) after a separate `wired()` check.
2. **Hand-written coercers.** A structured agent declared a free-string `output.shapeHint`
   _and_ a lenient `coerce(value: unknown)` that never throws: duplicated, unrelated to each
   other, in every package. The repo already standardises on valibot everywhere else.
3. **No boot-time validation.** A typo'd gate `helperKind`, an unknown `resultView`, or a
   pipeline naming a non-existent kind surfaced mid-run (a failed dispatch) or silently (a
   prose fallback), never at startup.
4. **Per-author prompt reasoning.** The `FINAL_ANSWER_IN_REPLY` directive and the read-only
   guardrail were applied in _different_ places for registered vs built-in kinds, so a
   registered `container-explore` kind silently missed the read-only guardrail.

## Provider tokens (gate data sources)

A provider is identified by a typed `ProviderToken<T>` defined once and exported next to its
interface. The deployment wires an impl at startup; the gate reads it back through its
`GateContext`, no module global, and `requireProvider` is a real guard, not a `!`.

The provider registry is the app-owned kernel `ProviderRegistry` the facade injects (via
`CoreDependencies.providerRegistry` → the gate machine's `GateContext`). A deployment's `wireX`
handle takes that instance; the gate reads it back through `ctx` (`getProvider` / `requireProvider` /
`isProviderWired`).

```ts
// kernel: defineProviderToken + the app-owned ProviderRegistry (wire/get/isWired/require methods)
export const LICENSE_PROVIDER = defineProviderToken<LicenseProvider>('license')
export function wireLicenseProvider(registry: ProviderRegistry, p: LicenseProvider | undefined) {
  registry.wire(LICENSE_PROVIDER, p)
}

gateRegistry.register(LICENSE_CHECK_KIND, (ctx) => ({
  kind: LICENSE_CHECK_KIND,
  helperKind: LICENSE_FIXER_KIND,
  wired: () => ctx.isProviderWired(LICENSE_PROVIDER),
  // SAFE: the engine only probes a gate whose wired() is true.
  probe: async (ws, blk) => mapReport(await ctx.requireProvider(LICENSE_PROVIDER).check(ws, blk)),
  // …
}))
```

`requireProvider` throwing inside `probe` is sound because `wired()` (= `ctx.isProviderWired(token)`)
gates whether the engine probes at all: the "checked `wired`, then asserted `!`" race is gone.
The built-in `@cat-factory/gates` suite dogfoods this (its `wireCiStatusProvider` etc. take the
registry as their first arg and wire onto that instance), so a fresh registry per build starts
empty and nothing leaks between builds.

## Schema-driven structured output

`defineStructuredOutput(schema)` turns ONE valibot schema into both the engine `AgentOutputSpec`
(the `shapeHint` the harness repair call sees) and a typed `parse`/`safeParse`; `registerAgentKind`
auto-fills `agent.output` from it. The worked example, including how to build the schema out of
`v.fallback` / `v.optional` so one noisy field degrades instead of failing the whole parse, is on
the website's
[Structured output](https://www.catfactory.ai/extend/custom-agents.html#structured-output-from-one-schema).

**Why it lives in `agents` rather than kernel**, which is the fact a change here has to keep true:
kernel cannot depend on valibot (it imports only `contracts` + `ai`). Kernel's
`AgentStepSpec.output` keeps its plain-string shape and only the DERIVED spec crosses into it, so
the schema and its parser stay in the agents registration layer. Moving either down breaks kernel's
dependency floor.

## Companions (registering a rework pair)

A companion GRADES the immediately-preceding producer's output and, below the step's threshold,
loops THAT producer back for automatic rework on a bounded budget before any human is asked.
Choose it over a [judge](../../docs/initiatives/judge-registry.md) when the remedy is the producer
running again rather than a verdict being disposed.

Register it with `AgentKindRegistry.registerCompanion`, beside the kind's own registration: a
companion is a relationship BETWEEN kinds, so it lives on the kind registry rather than a registry
of its own. Three things bite:

- **The pairing is registered SEPARATELY from the kind**, so every read goes through the registry.
  A projection built off the kind's own definition sees no companions at all.
- **The free lookups take the registry OPTIONALLY** and fall back to the built-ins (the shape
  `isGatableKind` uses), so a call site that omits it silently sees built-in pairs only. That is a
  wrong ANSWER rather than a missing argument, which is why it survives a typecheck.
- **The PROMPT is the platform's**, not the registration's: every companion runs the shared
  companion prompt (`companionSystemPrompt`), which weaves in the pairing's `reviews` label, the
  JSON verdict shape, and `REVIEW_SUMMARY_LAYOUT` (the block layout the `summary` is rendered as,
  since that one string IS the review a human reads). So a registration contributes the label and
  the threshold, and a deployment companion cannot drift into a verdict the run panel renders as a
  wall of text — not even through a per-workspace prompt override, which
  `OVERRIDE_PRESERVED_FRAGMENTS` puts the layout back over.
- **Adjacency is an invariant**, enforced by `assertValidCompanionPlacement`: the engine grades the
  immediate predecessor, so a companion separated from its producer would grade whatever happens to
  sit in front of it. The same reasoning drives the cascade-skip rule in
  [`pipeline-catalog-collapse.md`](../../docs/initiatives/pipeline-catalog-collapse.md), where a
  skipped producer takes its companion with it.
- **A rework round re-dispatches the producer for real**, and nothing has to be registered for that:
  `dispatchEpochFor` mints the harness job id off the run's own record of what it has dispatched
  (`recordDispatchAttribution`'s per-kind count), so every round gets an id of its own. It used to be
  a hand-maintained sum of per-loop counters, which the companion loop was never added to (its round
  count lives on the COMPANION step and is not readable from the producer at all), so a
  container-backed producer re-attached to its FIRST completed job every round: the harness replays a
  job id it already holds, and a companion then re-graded a byte-identical artifact until the budget
  ran out. Anything new that re-runs a step inherits the fix; nothing needs a counter of its own.
- **The producer answers in its REPLY.** `FEEDBACK_ACCOUNTING_DIRECTIVE` makes it account for every
  point (changed, or argued down with a reason) as a "Response to review" section in the reply, never
  in a committed artifact, because that reply is what the next round folds in as prior work — for a
  `container-explore` companion too, which reads it beside the checkout. The grader is told to hold
  that accounting to the WORK, and NOT to treat a missing one as a finding: a producer whose
  deliverable is a pushed commit legitimately answers with the change alone.

## Boot-time registration validation

`validateRegistrations()` (`@cat-factory/orchestration`) cross-checks the registries and throws an
aggregated error on any unambiguous misconfig; a facade calls `validateRegistrationsOnce()` after
all `register*` imports + provider wiring, before serving.

| Check                                                                                                 | Severity             |
| ----------------------------------------------------------------------------------------------------- | -------------------- |
| gate `helperKind` resolves to a registered container kind or a built-in helper                        | error                |
| `presentation.resultView` is a known `RESULT_VIEW_IDS` id                                             | error                |
| pipeline `agentKinds` are known (only when `knownAgentKinds` is supplied, no built-in catalog exists) | error                |
| `postOps` declared without structured output                                                          | warn (`onWarn` sink) |

Wired symmetrically: the Worker validates on its first `fetch` (the once-guard keeps it off the
hot path), the Node facade in `start()` after building the container. Orchestration is
runtime-neutral, so warnings go to an `onWarn` callback the facade backs with its logger.

## Prompt + resultView wiring

- **Surface-driven directives.** `systemPromptFor` applies the directives once, from the kind's
  `agent.surface`, so a registered kind gets the same treatment a built-in does:

  | surface             | read-only guardrail | final-answer-in-reply |
  | ------------------- | ------------------- | --------------------- |
  | `inline`            | ✗                   | ✓                     |
  | `container-explore` | ✓                   | ✓                     |
  | `container-coding`  | ✗                   | ✗                     |
  | no agent step       | ✗                   | ✗                     |

  (Built-in read-only kinds keep their `isReadOnlyAgentKind` path; built-ins get final-answer
  from their own track prompts, so it's only added to _registered_ kinds here.)

- **Type-safe `resultView`.** The canonical ids live in `contracts/result-views.ts`
  (`RESULT_VIEW_IDS`); `agentPresentationSchema.resultView` is a `picklist` of them, so an unknown
  id fails validation rather than silently falling back to prose, and `StepResultViewHost.vue`
  warns (dev) on an unregistered id. Adding a bespoke view is a two-step contract: add its id here
  and register the component in `StepResultViewHost.vue`. A structured agent with no bespoke UI
  uses `generic-structured`.

## Per-step gate settings (declared, not hard-coded)

A gate's knobs belong to the gate, not to the engine or to the workspace merge preset. Declare them
on the REGISTRATION as descriptor fields and they drive three things at once: validation at pipeline
save, re-validation at run start, and the authoring form the SPA renders in the pipeline builder
(projected onto the board snapshot as `gateConfigForms`, rendered by the shared
`DescriptorFields.vue`).

```ts
gateRegistry.register(MY_GATE_KIND, myGate, {
  configFields: [
    { key: 'maxAttempts', label: 'Helper attempts', type: 'number', min: 0, max: 20 },
    { key: 'soakMinutes', label: 'Soak window (minutes)', type: 'number', min: 1, max: 1440 },
  ],
})
```

The filled values are validated (unknown keys and out-of-range numbers are refused at SAVE, not
clamped at read) and copied onto the live gate state once on first entry, so the gate reads them off
`gateState.config` on every poll with no plumbing per parameter:

```ts
probe: async (workspaceId, blockId, gateState) => {
  const soak = gateConfigNumber(gateState.config, 'soakMinutes') ?? DEFAULT_SOAK_MINUTES
  …
},
// The GATE decides how its own budget is overridden — the engine never learns the field's name.
attemptBudget: (preset, config) => gateConfigNumber(config, 'maxAttempts') ?? preset.ciMaxAttempts,
```

A gate that declares nothing accepts no per-step fields, which is the honest default: an undeclared
key is indistinguishable from a typo'd one. The built-ins are the worked example
(`@cat-factory/gates`' `gateConfigFields.ts`); the design record is
[ADR 0038](./adr/0038-per-step-gate-config.md), which also covers the OTHER half of a step's gate
config — the approver policy and quorum on a human approval gate, which the platform owns rather
than the gate.

## Runtime symmetry rules (recap)

Per CLAUDE.md: any provider wiring or validation hook lands in BOTH `runtimes/cloudflare` and
`runtimes/node` (local inherits node), and shared gate behaviour gets a `conformance` assertion.
The gates package depends only on kernel + contracts, never on orchestration.

## Authoring checklist

The step-by-step is on the website, split the way the seams are:
[Add a Custom Agent Kind](https://www.catfactory.ai/extend/custom-agents.html) and
[Add a Custom Gate or Judge](https://www.catfactory.ai/extend/custom-gates.html). What this page
adds to both is the order the registrations have to happen in, which neither page can state without
knowing what validates when: shared definitions (skills, tool servers, traits, provider tokens)
before the kinds that reference them by id, kinds before the pipelines that chain them, and the
facade's `validateRegistrationsOnce()` after all of it.
