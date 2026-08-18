# `@cat-factory/observability-langfuse`: opt-in Langfuse trace sink

The workerd-safe OTLP/HTTP exporter pointed at Langfuse's OpenTelemetry endpoint, streaming LLM
generations and container tool spans; runs unchanged on both the Cloudflare Worker (workerd) and
Node facades. The legacy batch ingestion API it used to speak sunsets on Langfuse Cloud on
2026-11-16. **See [README.md](./README.md).**

**Entry:** `src/index.ts`.
