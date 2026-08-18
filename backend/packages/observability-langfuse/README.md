# @cat-factory/observability-langfuse

Opt-in [Langfuse](https://langfuse.com) trace sink for the Agent Architecture Board.

It implements the runtime-neutral `LlmTraceSink` port from `@cat-factory/kernel`, so
when wired into a facade every LLM call: container-agent calls (through the LLM proxy)
**and** inline calls (requirements review, document planner, fragment selector, inline
agent): surfaces in Langfuse as a generation grouped under its run's trace, plus
optional container tool spans.

## What it is: the OTLP exporter, pointed at Langfuse

The sink is `@cat-factory/observability-otel`'s fetch-based OTLP/HTTP exporter with three
Langfuse-specific decisions in its constructor: the endpoint `{baseUrl}/api/public/otel`
(onto which the exporter appends `/v1/traces`), HTTP Basic auth over the key pair, and the
`x-langfuse-ingestion-version: 4` header that v4 needs for real-time ingestion. Metrics
are off, because Langfuse implements the traces signal only.

It used to be its own client speaking Langfuse's batch **ingestion API**
(`POST /api/public/ingestion`). That API is deprecated, sunsets on Langfuse Cloud on
**2026-11-16**, and the `trace-create` / `generation-create` / `span-create` events it sent
are already unsupported on the v4 data model. OTLP is the supported path and this repo
already spoke it.

Neither package depends on the official `langfuse` Node SDK or on any `@opentelemetry/*`
package: those rely on Node-only APIs unavailable on the Cloudflare Worker runtime
(workerd), which is what keeps the sink byte-for-byte identical on both facades.

## Behaviour

- Never throws into the caller: every flush swallows its own errors (logging at most a
  warning). Observability must never break agent work.
- Honours the same `LLM_RECORD_PROMPTS` privacy switch as the local metric store: when
  prompt recording is off, generations carry usage/timing/metadata but no prompt or
  response bodies.

## Usage

```ts
import { createLangfuseSink } from '@cat-factory/observability-langfuse'

const sink = createLangfuseSink({
  publicKey: env.LANGFUSE_PUBLIC_KEY,
  secretKey: env.LANGFUSE_SECRET_KEY,
  baseUrl: env.LANGFUSE_BASE_URL, // optional; defaults to Langfuse Cloud
})
```

Wired into a facade via its container's `selectLangfuseSink(config)`; absent config ⇒
the sink is never built and there is no external emission or behaviour change.
