---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

LLM observability for container-based agent execution.

Every container agent talks to models only through the runtime-neutral LLM proxy, so
that single chokepoint now records one rich metric per call — the full prompt and
response, token usage, how close the call ran to its output-token limit (truncation),
and the latency split between transport/proxy overhead and actual model execution —
plus errors and warnings (non-2xx, in-process failures, spend-gate refusals,
`finish_reason: length`/`content_filter`).

- New `LlmCallMetricRepository` kernel port + `LlmObservabilityService`
  (orchestration), composed only when a metric repository is wired (default-off, so
  tests and unconfigured facades are unaffected). Persisted on both runtimes: a new
  D1 table (`llm_call_metrics`, migration 0026) and a Drizzle/Postgres table, kept in
  lock-step by a cross-runtime conformance repository-parity suite.
- The proxy is instrumented across the buffered, streaming, and in-process (Workers
  AI) paths; recording is scheduled off the response path so it never adds latency.
- The execution engine rolls the per-run, per-agent-kind aggregates onto each
  pipeline step (`step.metrics`) and ships them over the existing execution event, so
  the board shows tokens, an output-limit headroom bar, a transport-vs-execution split
  and error/warning badges live — on the step cards, the pipeline timeline and the
  step-detail overlay. A new drill-down panel (`GET …/executions/:id/llm-metrics`)
  lists every call with its full prompt + response, and an LLM-friendly JSON export
  (`…/llm-metrics/export`) bundles totals + per-agent insights + every call (with
  derived ratios) for handing a run straight to a model to analyse.
- The full request/response bodies make the table heavy, so it is pruned aggressively
  by the retention cron — default 3 days (`LLM_CALL_METRICS_RETENTION_DAYS`).
