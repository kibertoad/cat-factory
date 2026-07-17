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

## Platform-operator metrics (deployment health)

The per-call sink above answers "what did THIS run do". The **`PlatformMetricsOtelExporter`**
(`createPlatformMetricsOtelExporter`, the `.` entry) answers "how is the WHOLE deployment
doing": a periodic sweep (Worker `scheduled` cron ⇄ Node interval, runtime-symmetric) computes
the platform-observability projection per account and this exporter pushes it to the same
OTLP endpoint as OpenTelemetry **gauge** metrics — so an operator watches deployment health in
their own metrics backend, the dual of the `post-release-health` gate that watches the
_user's_ release.

Metrics (`cat_factory.platform.*`, all gauges — the OTel backend trends the series over time):

| Metric                                  | Unit    | Split dimension             |
| --------------------------------------- | ------- | --------------------------- |
| `cat_factory.platform.runs`             | `{run}` | `cat_factory.run_status`    |
| `cat_factory.platform.run_success_rate` | `1`     | —                           |
| `cat_factory.platform.run_failures`     | `{run}` | `cat_factory.failure_kind`  |
| `cat_factory.platform.live_runs`        | `{run}` | `cat_factory.run_state`     |
| `cat_factory.platform.run_duration`     | `s`     | `cat_factory.duration_stat` |

Every point carries `cat_factory.account_id` (the bounded tenant scope — safe on a metric,
unlike the unbounded workspace id excluded from the per-call metrics); the windowed gauges
also carry `cat_factory.window`. Null aggregates (a success rate / percentiles with no
terminal runs) are omitted rather than emitted as a misleading zero.

Unlike the per-call LLM path, the platform exporter is the **fetch transport on both
runtimes** (there is no SDK counterpart): the push is a stateless, low-frequency snapshot
POST with no need for the SDK's async instruments / periodic reader, so one workerd-safe
exporter serves both facades and is tested once.

**Opt-in on top of the base exporter** (it adds recurring DB rollup load): off unless
`OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
(`1h`/`24h`/`7d`, default `1h`) sets the trailing window; on Node
`OTEL_PLATFORM_METRICS_INTERVAL_MS` (default 60s) sets the sweep cadence (the Worker is
cron-driven). The runtime-neutral `sweepPlatformMetrics` driver + `distinctAccountIds`
account enumeration live in `@cat-factory/orchestration`.
