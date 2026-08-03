---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/caching': minor
'@cat-factory/integrations': minor
'@cat-factory/observability-otel': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': patch
---

Count the deployment's operational EVENTS, and let the health alerts see a dead one.

The platform-observability projection answers "how are the runs doing" by aggregating
`agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
times?" is answerable after the process (or the isolate) that did it is gone.

`platform_health` gained three conditions. The important one is zero-throughput: every existing
condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
`evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
making any of them fire.

Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling that an
hourly sweep reports on.
