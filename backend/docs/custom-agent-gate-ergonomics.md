# Custom agent & gate authoring ergonomics

Companion to [`custom-agents.md`](./custom-agents.md) (the three-stage agent model) and the
"Gates vs agents" section of [`../../CLAUDE.md`](../../CLAUDE.md). That doc covers _what_ the
extension seams are; this one covers the ergonomics layered on top so writing a custom agent
kind or gate is less boilerplate-heavy and fails loudly when misconfigured.

The canonical worked example exercising everything below is
[`backend/internal/example-custom-agent`](../internal/example-custom-agent/src/index.ts).

## Why

Four rough edges made authoring a custom agent/gate harder than it should be:

1. **Provider wiring boilerplate + an unsafe `!`.** Every gate's data source was a module
   global trio — `let provider; wireFoo(); getFoo()` — re-authored in each package, and the
   gate read it with a non-null assertion (`getFoo()!`) after a separate `wired()` check.
2. **Hand-written coercers.** A structured agent declared a free-string `output.shapeHint`
   _and_ a lenient `coerce(value: unknown)` that never throws — duplicated, unrelated to each
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
`GateContext` — no module global, and `requireProvider` is a real guard, not a `!`.

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
gates whether the engine probes at all — the "checked `wired`, then asserted `!`" race is gone.
The built-in `@cat-factory/gates` suite dogfoods this (its `wireCiStatusProvider` etc. take the
registry as their first arg and wire onto that instance), so a fresh registry per build starts
empty and nothing leaks between builds.

## Schema-driven structured output

`defineStructuredOutput(schema)` (`@cat-factory/agents`) turns ONE valibot schema into both the
engine `AgentOutputSpec` (the `shapeHint` fed to the harness repair call) and a typed
`parse`/`safeParse`. `registerAgentKind` auto-fills `agent.output` from it.

```ts
const securityAssessment = defineStructuredOutput(
  v.object({
    risk: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    findings: v.optional(
      v.array(v.object({ title: v.fallback(v.string(), 'Untitled') /* … */ })),
      [],
    ),
  }),
)
registerAgentKind({
  kind: SECURITY_AUDITOR_KIND,
  agent: { surface: 'container-explore', clone: { branch: 'pr' } }, // output derived from the schema
  structuredOutput: securityAssessment,
  postOps: [renderReportPostOp], // uses securityAssessment.safeParse(ctx.result.custom)
})
```

`safeParse` returns `undefined` on a malformed reply (so a post-op's `if (!parsed) return` guard
holds) and applies `v.fallback`/`v.optional` defaults, degrading exactly like the old coercer.
Pass `{ shapeHint }` to override the auto-derived hint for an unusual shape.

**Why agents, not kernel:** kernel cannot depend on valibot (it imports only `contracts` + `ai`).
Kernel's `AgentStepSpec.output` keeps its plain-string shape; only the derived spec crosses into
it — the schema/parser stays in the agents registration layer.

## Boot-time registration validation

`validateRegistrations()` (`@cat-factory/orchestration`) cross-checks the registries and throws an
aggregated error on any unambiguous misconfig; a facade calls `validateRegistrationsOnce()` after
all `register*` imports + provider wiring, before serving.

| Check                                                                                                  | Severity             |
| ------------------------------------------------------------------------------------------------------ | -------------------- |
| gate `helperKind` resolves to a registered container kind or a built-in helper                         | error                |
| `presentation.resultView` is a known `RESULT_VIEW_IDS` id                                              | error                |
| pipeline `agentKinds` are known (only when `knownAgentKinds` is supplied — no built-in catalog exists) | error                |
| `postOps` declared without structured output                                                           | warn (`onWarn` sink) |

Wired symmetrically: the Worker validates on its first `fetch` (the once-guard keeps it off the
hot path), the Node facade in `start()` after building the container. Orchestration is
runtime-neutral, so warnings go to an `onWarn` callback the facade backs with its logger.

## Prompt + resultView wiring

- **Surface-driven directives.** `systemPromptFor` applies the directives once, from the kind's
  `agent.surface`, so a registered kind gets the same treatment a built-in does:

  | surface             | read-only guardrail | final-answer-in-reply |
  | ------------------- | ------------------- | --------------------- |
  | `inline`            | –                   | ✓                     |
  | `container-explore` | ✓                   | ✓                     |
  | `container-coding`  | –                   | –                     |
  | no agent step       | –                   | –                     |

  (Built-in read-only kinds keep their `isReadOnlyAgentKind` path; built-ins get final-answer
  from their own track prompts, so it's only added to _registered_ kinds here.)

- **Type-safe `resultView`.** The canonical ids live in `contracts/result-views.ts`
  (`RESULT_VIEW_IDS`); `agentPresentationSchema.resultView` is a `picklist` of them, so an unknown
  id fails validation rather than silently falling back to prose, and `StepResultViewHost.vue`
  warns (dev) on an unregistered id. Adding a bespoke view is a two-step contract: add its id here
  and register the component in `StepResultViewHost.vue`. A structured agent with no bespoke UI
  uses `generic-structured`.

## Runtime symmetry rules (recap)

Per CLAUDE.md: any provider wiring or validation hook lands in BOTH `runtimes/cloudflare` and
`runtimes/node` (local inherits node), and shared gate behaviour gets a `conformance` assertion.
The gates package depends only on kernel + contracts, never on orchestration.

## Authoring checklist

1. Define a valibot schema → `defineStructuredOutput` for any structured kind.
2. `agentKindRegistry.register({ kind, systemPrompt, agent: { surface }, structuredOutput?, preOps?, postOps?, presentation? })`
   — the surface drives the prompt directives and the container requirement; `presentation.resultView`
   (if set) must be a `RESULT_VIEW_IDS` id.
3. For a gate: `defineProviderToken` + a one-line `wireX(registry, impl)`; `gateRegistry.register(kind, ctx => ({ wired: () => ctx.isProviderWired(token), probe: () => …ctx.requireProvider(token)…, helperKind, onExhausted }))`.
   The `helperKind` must be a registered container kind (or a built-in helper).
4. `pipelineRegistry.register(...)` to chain the kinds.
5. The facade wires the provider impl onto its `providerRegistry` at startup and (already) calls `validateRegistrationsOnce()`.
