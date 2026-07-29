---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/agents': patch
'@cat-factory/kernel': patch
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

Compatibility breaks (pre-1.0, no shims):

- `createScopedModelProviderResolver` no longer takes `instrument`. Apply the new
  `wrapResolverWithInstrumentation(resolver, instrument)` on top of the resolver instead — after
  any facade wrap that can substitute a resolved model, and inside `wrapResolverWithLimiter`.
- `createNodeModelProviderResolver` builds the BASE resolver only; its `instrument` and
  `workspaceSettingsRepository` parameters are gone, and the env-built trace-sink instrument it
  used to fall back to is now the exported `inlineInstrumentFromEnv(env, workspaceBodiesEnabled)`.
  A deployment assembling its own container composes the two.
- `InlineInstrumentation` is now exported from `agents/modelProviderResolver` rather than derived
  from `ScopedModelProviderOptions['instrument']` (same shape, same import path from the package
  root).
