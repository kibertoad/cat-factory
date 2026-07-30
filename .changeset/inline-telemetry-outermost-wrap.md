---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Record the inline LLM calls that local mode serves from a host CLI, and stop filing run-scoped
inline calls under a null execution id.

The inline `llm_call_metrics` feeder was applied as the innermost provider wrap, so local mode's
subscription-inline harness — which answers a Claude Code / Codex ref with its own
`CliInlineLanguageModel` rather than delegating — was invisible to it. With `LOCAL_NATIVE_INLINE`
on (the default), every inline step on a host `claude`/`codex` login recorded zero calls while the
same step on a metered API model recorded fine. Separately, ten of the twelve inline call sites
tagged only the workspace, so their rows landed with `execution_id = NULL`: in the store, but
absent from every run-scoped read.

Attribution also no longer trusts a settled run: `resolveBlockRunContext` drops the execution id
once the run is terminal (keeping the initiator), because `block.executionId` is the block's LAST
run rather than necessarily a live one. A stale id would report an inline call's spend against a
finished run's rollup, and unlike a null nothing about a wrong-but-plausible id looks wrong.

Compatibility breaks (pre-1.0, no shims):

- `createScopedModelProviderResolver` no longer takes `instrument`, and the instrumentation and
  concurrency-limiter wraps are no longer exported individually. Apply the new
  `wrapResolverWithTelemetry(resolver, { instrument, limiter })` on top of the resolver — after any
  facade wrap that can substitute a resolved model. It owns the ORDER of the two wraps, which is
  load-bearing and which nothing in the type system holds: reversed, the composition still
  type-checks and still records every non-substituted call. Replace a `wrapResolverWithLimiter`
  call with the `limiter` field (build it with `vendorConcurrencyLimiterFromEnv`; it stays a
  pass-through when nothing is capped).
- `createNodeModelProviderResolver` builds the BASE resolver only; its `instrument` and
  `workspaceSettingsRepository` parameters are gone, and the env-built trace-sink instrument it
  used to fall back to is now the exported `inlineInstrumentFromEnv(env, workspaceBodiesEnabled)`.
  A deployment assembling its own container composes the two — and MUST: a caller that merely drops
  the removed arguments compiles fine and silently stops instrumenting its inline calls.
- `InlineInstrumentation` is now exported from `agents/modelProviderResolver` rather than derived
  from `ScopedModelProviderOptions['instrument']` (same shape, same import path from the package
  root).
- `FragmentBriefService.resolveBriefs` takes its run on an options object (`{ executionId }`)
  rather than as a third positional argument.
- `@cat-factory/agents` additionally exports `LimitedModelProvider`, so a facade wiring test can
  assert the wrapper it composed.
