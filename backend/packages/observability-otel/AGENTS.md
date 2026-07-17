# `@cat-factory/observability-otel` — opt-in OpenTelemetry (OTLP) publisher

Implements the `LlmTraceSink` port from `@cat-factory/kernel`, exporting LLM generations
(+ container tool spans) and metrics to any OTLP/HTTP backend. Two transports behind one
port — a workerd-safe fetch exporter (`.`) and the official-SDK exporter (`./node`) — kept
conformant by a shared mapping layer. **See [README.md](./README.md).**

**Entries:** `src/index.ts` (`createOtelSink`, fetch), `src/node.ts` (`createNodeOtelSink`,
SDK). Shared mapping: `src/mapping.ts` (the single source of truth both transports use);
shared OTLP/JSON encode + POST helpers: `src/otlp.ts`.

Also exports the **platform-operator metrics** exporter (`src/platform.ts`,
`createPlatformMetricsOtelExporter`) — a fetch-based OTLP GAUGE publisher for the
deployment-level run-health aggregates (the dual of the per-call LLM sink). Fetch-on-both
runtimes (no SDK counterpart); driven by `sweepPlatformMetrics` in `@cat-factory/orchestration`
and wired into each facade's scheduler. See README.md.
