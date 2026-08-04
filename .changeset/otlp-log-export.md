---
'@cat-factory/observability-otel': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/cli': patch
---

Add OTLP log export: the platform's own structured log lines can now be shipped to the same
OpenTelemetry endpoint as its traces and metrics.

A new kernel `LogSink` port lets a facade install a second destination on the logging adapter,
and `@cat-factory/observability-otel` implements it as a fetch-based exporter POSTing OTLP log
records to `{endpoint}/v1/logs`. Lines keep their field names, carry their `child`-bound
correlation ids, and a line naming an `executionId` is stamped with the same derived trace id
that run's spans carry, so logs and traces join in the backend.

Opt-in on top of the existing exporter: `OTEL_LOGS=true` plus `OTEL_ENABLED=true` and an
endpoint, with `OTEL_LOGS_MAX_BATCH_SIZE` and (Node only) `OTEL_LOGS_FLUSH_INTERVAL_MS`.
`LOG_LEVEL` governs what is exported. Nothing changes for a deployment that has not opted in.
