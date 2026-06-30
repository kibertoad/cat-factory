---
'@cat-factory/server': patch
---

Widen the mothership-mode persistence allow-list (`PILOT_PERSISTENCE_METHODS`) to cover the
org/durable repository methods the run lifecycle exercises — merge-preset `getDefault`, service
`getByFrameBlock`, notification/requirement-review `get`, requirement-review `upsert`, kaizen
grade `getByStep`/`upsert`, the kaizen run-path LLM-metric summary, and the env-config-repair +
kaizen-combo run-path reads — each bound by a scope rule (admin-gated and sweeper methods stay
mothership-internal). This is what makes a no-Postgres mothership-mode node drive a full run
to a persisted terminal state over the remote RPC.

Adds a cross-runtime `[mothership]` conformance configuration (the shared suite's execution
group run against a real in-process Node mothership) and a static allow-list completeness guard,
so a new Drizzle repository or method that isn't proxied — or is mis-scoped — fails a test
instead of a developer's first board load.
