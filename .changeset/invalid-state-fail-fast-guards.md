---
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/gates': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Add fail-fast guards that surface invalid state early and loudly instead of letting it
flow silently into the domain.

- **Persistence read boundary** (`@cat-factory/server`): a new `decode` helper
  (`decodeEnum`/`decodeEnumOr`/`decodeJson`/`tryDecodeRow` + `DataIntegrityError`)
  re-asserts the Valibot wire contract at row→domain mapping time, replacing erased
  `as SomeType` casts. Wired through the shared mappers (block status/level, `depends_on`,
  and `rowToExecution` — which now rejects an empty `block_id` and an out-of-bounds
  `currentStep`) and, symmetrically across both runtimes, the agent-run kind, notification
  type/status/severity, and subscription vendor reads. A corrupt enum/JSON now logs with
  row context and throws a 500 (engine-critical) or degrades (cosmetic) rather than
  smuggling a fake-valid value downstream.
- **Execution engine** (`@cat-factory/orchestration`): `disposeReview` rejects a
  non-positive iteration cap / sub-1 counter; `StepGraph.loopCompanionProducer` replaces
  `companion!`/`steps[-1]!` force-unwraps with diagnostic guards.
- **Gates** (`@cat-factory/gates`): `warnUnwiredGates(logger)` logs (once per gate per
  process) any built-in gate left as a silent pass-through, so a deployment that forgot to
  wire the GitHub App no longer auto-merges without checking CI. Called at both facades'
  container build.

Scope notes: lower-severity source-kind casts and deep JSON-blob shape validation are
deliberately deferred (the primitives are in place to extend to them). No guards were
added inside the durable drive path (e.g. `finalizeBlock`) where a throw would wedge the
retry loop, and the intentional Node-vs-Cloudflare container-executor fail-mode asymmetry
is left unchanged.
