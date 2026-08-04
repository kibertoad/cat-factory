# `@cat-factory/observability-otel`: opt-in OpenTelemetry (OTLP) publisher

Implements the `LlmTraceSink` port from `@cat-factory/kernel`, exporting LLM generations
(+ container tool spans) and metrics to any OTLP/HTTP backend. Two transports behind one
port: a workerd-safe fetch exporter (`.`) and the official-SDK exporter (`./node`): kept
conformant by a shared mapping layer. **See [README.md](./README.md).**

**Entries:** `src/index.ts` (`createOtelSink`, fetch), `src/node.ts` (`createNodeOtelSink`,
SDK). Shared mapping: `src/mapping.ts` (the single source of truth both transports use);
shared OTLP/JSON encode + POST helpers: `src/otlp.ts`.

Two things in `src/mapping.ts` bind changes here:

- **The span hierarchy is built from DERIVED ids, never shared state.** `deriveRunSpanId` /
  `deriveStepSpanId` are pure functions of the run, which is what lets a stateless per-call
  emission name a parent emitted hours later (at run settlement, via `recordRunSpans`). A new
  span type picks its parent by deriving one, and a transport must emit `MappedSpan.spanId`
  verbatim rather than minting its own — an SDK-generated id for a parent orphans every child.
  Derived ids also make the parents REPLAY-safe, but only together with a replay-safe extent:
  the settlement hook fires again for an already-settled run, so whatever feeds `LlmRunSpan` /
  `LlmStepSpan` must fold recorded stamps rather than read a clock (see `buildRunTraceSpans` in
  orchestration), or one run exports the same span ids with a duration that keeps moving.
- **A span NAME is a bounded class.** `chat {model}`, `execute_tool {tool}`,
  `invoke_agent {agentKind}` and the bare `run` are all closed vocabularies; a new span type
  keeps free text (a pipeline name, a task title, a repo) in an attribute, because the name is
  what a span-metrics connector turns into a time series.
- **`ATTR` and the README's GenAI semantic-convention coverage table are edited together.**
  The convention is experimental, so what we cover, extend and deliberately omit is documented
  rather than inferred.

Also exports the **platform-operator metrics** exporter (`src/platform.ts`,
`createPlatformMetricsOtelExporter`): a fetch-based OTLP GAUGE publisher for the
deployment-level run-health aggregates (the dual of the per-call LLM sink). Fetch-on-both
runtimes (no SDK counterpart); driven by `sweepPlatformMetrics` in `@cat-factory/orchestration`
and wired into each facade's scheduler. See README.md.
