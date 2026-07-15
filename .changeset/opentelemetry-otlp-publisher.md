---
'@cat-factory/observability-otel': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/cli': patch
---

Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
conformant by a shared mapping layer + a conformity test.

- **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
  destinations (Langfuse and/or OTLP) fan out through the single sink slot.
- **server:** new `OtelConfig` on `AppConfig`.
- **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
  everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
  `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
  `OTEL_SERVICE_NAME` optional).
- **cli:** advertise the `OTEL_*` vars in the generated `.env`.
