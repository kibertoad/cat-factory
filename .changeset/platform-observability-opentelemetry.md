---
'@cat-factory/observability-otel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Expose the deployment-level (platform-operator) observability aggregates via OpenTelemetry.

A periodic, runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, like the
retention sweeps) now pushes the same run-health projection the operator dashboard renders —
run outcomes by status, the failure-kind taxonomy, live/parked depth, and the avg/min/max +
p50/p90/p99 duration percentiles — to any OTLP/HTTP backend as OpenTelemetry **gauge**
metrics (`cat_factory.platform.*`), per account (the bounded tenant scope) and stamped with
the projection's `generatedAt`. The OTel backend builds trends from the gauge series, so the
sweep exports the shortest trailing window (`1h` default).

`@cat-factory/observability-otel` gains a fetch-based `PlatformMetricsOtelExporter`
(`createPlatformMetricsOtelExporter`) — the workerd-safe transport used on BOTH runtimes
(the platform push is a stateless snapshot POST, so it needs no SDK, mirroring the Langfuse
sink's fetch-on-both shape). The runtime-neutral `sweepPlatformMetrics` driver + the
`distinctAccountIds` account enumeration live in `@cat-factory/orchestration`.

Opt-in on top of the base OTel exporter (it adds recurring DB rollup load): off unless
`OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
(`1h`/`24h`/`7d`) and, on Node, `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it. A deployment
that hasn't opted in emits nothing and runs no sweep.
