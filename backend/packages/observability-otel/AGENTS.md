# `@cat-factory/observability-otel` — opt-in OpenTelemetry (OTLP) publisher

Implements the `LlmTraceSink` port from `@cat-factory/kernel`, exporting LLM generations
(+ container tool spans) and metrics to any OTLP/HTTP backend. Two transports behind one
port — a workerd-safe fetch exporter (`.`) and the official-SDK exporter (`./node`) — kept
conformant by a shared mapping layer. **See [README.md](./README.md).**

**Entries:** `src/index.ts` (`createOtelSink`, fetch), `src/node.ts` (`createNodeOtelSink`,
SDK). Shared mapping: `src/mapping.ts` (the single source of truth both transports use).
