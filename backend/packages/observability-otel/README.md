# @cat-factory/observability-otel

Opt-in [OpenTelemetry](https://opentelemetry.io) (OTLP) trace + metrics publisher for the
Agent Architecture Board.

It implements the runtime-neutral `LlmTraceSink` port from `@cat-factory/kernel`, so when
wired into a facade every LLM call — container-agent calls (through the LLM proxy) **and**
inline calls (requirements review, document planner, fragment selector, inline agent) —
is exported to any **OTLP/HTTP** backend (Grafana Tempo/Mimir, Honeycomb, Datadog OTLP,
Jaeger, an OpenTelemetry Collector, …) as:

- **a trace span per generation**, plus a span per container tool call, all grouped under a
  shared per-run trace id (they are sibling spans sharing the trace, not parent/child —
  generations and tool calls arrive as independent, stateless emissions); and
- **metrics** — a `gen_ai.client.token.usage` counter (input/output) and a
  `gen_ai.client.operation.duration` histogram — following the OpenTelemetry GenAI
  semantic conventions.

## Two transports, one behaviour

The Cloudflare Worker runtime (workerd) cannot run the official `@opentelemetry/*` SDK
(it relies on Node-only APIs), so this package ships **two exporters** behind the same
port:

| Entry                                  | Export               | Transport                                   | Used by           |
| -------------------------------------- | -------------------- | ------------------------------------------- | ----------------- |
| `@cat-factory/observability-otel`      | `createOtelSink`     | hand-rolled **OTLP/HTTP JSON over `fetch`** | Cloudflare Worker |
| `@cat-factory/observability-otel/node` | `createNodeOtelSink` | the official **`@opentelemetry/*` SDK**     | Node / local      |

Both map events through the **same** `src/mapping.ts` layer, so they emit identical span
names, attributes, trace-id grouping and metric names/units. `src/conformity.test.ts`
feeds the same events through both and asserts the emitted telemetry matches — the guard
that the transports never drift.

The Worker entry (`.`) never imports `@opentelemetry/*`, so the SDK is kept out of the
workerd bundle; it depends only on the `fetch`/`crypto` globals.

## Behaviour

- Never throws into the caller: every method swallows its own errors (logging at most a
  warning). Observability must never break agent work.
- Honours the same `LLM_RECORD_PROMPTS` privacy switch as the local metric store: when
  prompt recording is off, spans carry usage/timing/attributes but no prompt or response
  bodies.
- Composes **alongside** the Langfuse sink (`@cat-factory/observability-langfuse`) via the
  kernel `composeTraceSinks` fan-out — a deployment can export to both at once.

## Usage

```ts
// Cloudflare Worker (workerd-safe fetch exporter)
import { createOtelSink } from '@cat-factory/observability-otel'

const sink = createOtelSink({
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, // e.g. http://collector:4318
  headers: { 'x-api-key': env.OTEL_KEY }, // optional
  serviceName: 'cat-factory', // optional; defaults to 'cat-factory'
})
```

```ts
// Node / local (official @opentelemetry/* SDK exporter)
import { createNodeOtelSink } from '@cat-factory/observability-otel/node'

const sink = createNodeOtelSink({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT! })
```

Wired into a facade via its container's `buildTraceSink(config)`; absent config (no
`OTEL_ENABLED=true` + endpoint) ⇒ the sink is never built and there is no external
emission or behaviour change.
