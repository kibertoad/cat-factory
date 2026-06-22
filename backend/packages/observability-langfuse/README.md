# @cat-factory/observability-langfuse

Opt-in [Langfuse](https://langfuse.com) trace sink for the Agent Architecture Board.

It implements the runtime-neutral `LlmTraceSink` port from `@cat-factory/kernel`, so
when wired into a facade every LLM call — container-agent calls (through the LLM proxy)
**and** inline calls (requirements review, document planner, fragment selector, inline
agent) — surfaces in Langfuse as a generation grouped under its run's trace, plus
optional container tool spans.

## Why fetch-only

The sink talks to Langfuse's public **ingestion API** (`POST /api/public/ingestion`,
HTTP Basic auth, batched JSON events) using only the global `fetch` / `crypto` /
`btoa`. It deliberately does **not** depend on the official `langfuse` Node SDK or any
`@opentelemetry/*` package — those rely on Node-only APIs that are unavailable on the
Cloudflare Worker runtime (workerd). Using the raw ingestion API keeps the sink
byte-for-byte identical on both the Worker and Node facades.

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
