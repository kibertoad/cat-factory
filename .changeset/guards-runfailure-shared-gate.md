---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/orchestration': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Retire the three shapes that let phase 2's defects happen, without changing behaviour.

Both durable drivers now fail a run through one shared `RunFailure` value
(`failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`) instead of positional
arguments each assembles itself. Every one of those parameters carried a default, so a driver
that stopped short still compiled and recorded `null` — which is how the Cloudflare driver came
to drop `AgentFailure.reason` on every path while its runtime-neutral twin forwarded it. An
omitted field is now a typecheck failure.

Controllers guard through two shared total accessors, `requireCapability` and `requireUser`
(`@cat-factory/server`'s `http/guards.ts`, the siblings of `param()`, and exported from the
package root alongside `param`). The per-controller `requireX(c): Module | null` forced every
route to restate `if (!x) return unavailable()`, and 51 controllers had each declared their own
copy of the thrower to satisfy it; making the accessor total deletes the guard line at ~300 call
sites. Each has an `assert*` twin for a route that needs a capability wired but reads nothing off
it, so the guard never reads as a discardable no-op statement.

`createStoreAgentContextGate` moves to `@cat-factory/kernel` (`StoreAgentContextGate`) and is
now the single implementation of the per-workspace body-capture rule, shared by the proxied
(`LlmObservabilityService`) and inline (`InstrumentedModelProvider`) paths. Phase 2 gave the
inline path a gate but wrote the rule a second time in a second package, leaving the two free to
drift apart exactly as they had.

Breaking (pre-1.0, no migration): `createStoreAgentContextGate` is no longer exported from
`@cat-factory/server` — import it from `@cat-factory/kernel`. Its dependency shape is unchanged.
