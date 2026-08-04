# @cat-factory/observability-otel

Opt-in [OpenTelemetry](https://opentelemetry.io) (OTLP) trace + metrics + logs publisher for
the Agent Architecture Board.

It implements the runtime-neutral `LlmTraceSink` port from `@cat-factory/kernel`, so when
wired into a facade every LLM call: container-agent calls (through the LLM proxy) **and**
inline calls (requirements review, document planner, fragment selector, inline agent):
is exported to any **OTLP/HTTP** backend (Grafana Tempo/Mimir, Honeycomb, Datadog OTLP,
Jaeger, an OpenTelemetry Collector, …) as:

- **a trace span per generation**, plus a span per container tool call, arranged into a
  per-run **hierarchy** (`run → agent kind → generations + tool calls`); and
- **metrics**: a `gen_ai.client.token.usage` counter (input/output) and a
  `gen_ai.client.operation.duration` histogram: following the OpenTelemetry GenAI
  semantic conventions.

Two further exporters ship beside it, each its own opt-in: the deployment-level
[platform-operator metrics](#platform-operator-metrics-deployment-health), and the
[log export](#log-export-the-third-signal) that carries the platform's own structured log
lines to the same endpoint.

## Span hierarchy

A run's spans form a tree, not a flat set of siblings sharing a trace id:

```
run                                 (root; the whole execution, INTERNAL)
├── invoke_agent coder              (one per agent KIND that ran, INTERNAL)
│   ├── chat claude-sonnet-4-5      (one per LLM call, CLIENT)
│   ├── execute_tool edit_file      (one per container tool call, INTERNAL)
│   └── execute_tool run_command
└── invoke_agent ci                 (a gate step)
    └── invoke_agent ci-fixer       (a HELPER the gate escalated to, nested under it)
        └── chat claude-sonnet-4-5
```

Nothing is buffered to build it. **Every parent id is a pure function of the run id**
(`deriveRunSpanId` / `deriveStepSpanId` in `src/mapping.ts`), so a generation recorded by the
LLM proxy on one isolate and a tool span drained by the engine on another both name the same
parent without either having seen it, and a durable replay re-derives the identical tree
rather than a duplicate one. The parents themselves are emitted **once, when the run settles**
(`LlmTraceSink.recordRunSpans`, driven from the engine's single terminal hook), which is when
its boundaries are first known. Children therefore export before their parent: the ordinary
OpenTelemetry ordering, where a parent outlives what it contains, just over a longer span of
time than usual.

Two consequences worth knowing:

- **The step level's grain is `(run, agent kind)`, not `(run, step index)`**, because the agent
  kind is the finest thing an `LlmGenerationEvent` can name — a per-step parent would be
  unaddressable from the very spans meant to hang under it. It is also the grain the rest of the
  LLM telemetry buckets by (the prompt-chain key, the `(agentKind, phase)` rollup). A pipeline
  running two `coder` steps folds them into one span carrying `cat_factory.step_count: 2`, so a
  reader is told about the fold rather than seeing one long step.
- **A standalone inline call stays a root.** Requirements review, the doc planner and the
  fragment selector run outside any execution, so they have no run to hang under and no parent
  is claimed — rather than pointing at one that will never be emitted.
- **A HELPER kind gets its own span, nested under the step that dispatched it.** A step often
  runs work under a kind that is not its own: a gate escalating to `ci-fixer` /
  `conflict-resolver` / `on-call`, a Tester handing off to the fixer, a two-phase coder's
  `fork-proposer`. Every telemetry row that work produces is tagged with the HELPER's kind, so
  without a span of its own each of those would name a parent nobody emits and dangle inside its
  own run's trace. The run records what it dispatched (`PipelineStep.dispatches`), and the helper
  inherits its host step's window: a parent is required to contain its children, and the host's
  window is the tightest bound the run actually recorded.

### Cycles: counted, not separated

The repetition these runs actually contain is cyclical rather than duplicated. A pipeline with
two steps of one kind is rare (no built-in has one); a review that spawns fixes four times, a
Ralph loop that iterates seven, a bounced step re-run on a judge's verdict are all ordinary.

A span cannot separate those rounds, because the events hanging under it carry no attempt ordinal
to be separated BY — threading one reaches the proxy URL contract and the harness, so it is a
deliberate non-goal here. What is NOT acceptable is letting the fold pass silently, so each step
span states both of its collapses: `cat_factory.step_count` (steps of this kind) and
`cat_factory.attempt_count` (dispatches inside them). Converging in one round and thrashing
through six are otherwise the same picture, and that picture is what an operator is looking for.

The extent is stated honestly across rounds too: a re-run step's span starts at
`PipelineStep.firstStartedAt`, which survives the reset that re-stamps `startedAt`. Without it a
bounced step's parent would begin AFTER the generations of its own earlier attempts, which still
name it.

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
feeds the same events through both and asserts the emitted telemetry matches: the guard
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
  kernel `composeTraceSinks` fan-out: a deployment can export to both at once.

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

## GenAI semantic-convention coverage

The OpenTelemetry GenAI semantic conventions are still **experimental**, so this section states
exactly what is claimed rather than leaving a reader to diff the emitted attributes against a
moving spec. `src/mapping.ts`'s `ATTR` object and this table are edited together.

**Emitted, per the convention:**

| Attribute / signal                 | Where                     | Notes                                                           |
| ---------------------------------- | ------------------------- | --------------------------------------------------------------- |
| `gen_ai.operation.name`            | generation / tool / step  | `chat` / `execute_tool` / `invoke_agent`                        |
| `gen_ai.system`                    | generation span + metrics | the provider (`anthropic`, `openai`, `workers-ai`, …)           |
| `gen_ai.request.model`             | generation span + metrics | the model asked for                                             |
| `gen_ai.usage.input_tokens`        | generation span           | FRESH input only; the cache classes are separate (see below)    |
| `gen_ai.usage.output_tokens`       | generation span           |                                                                 |
| `gen_ai.response.finish_reasons`   | generation span           | a one-element list; omitted when upstream reported none         |
| `gen_ai.agent.name`                | step span                 | the agent kind                                                  |
| `gen_ai.tool.name`                 | tool span                 |                                                                 |
| `gen_ai.tool.arguments`            | tool span EVENT           | the call's arguments; only when body capture is permitted       |
| `gen_ai.tool.result`               | tool span EVENT           | what the tool returned; same gate                               |
| `gen_ai.client.token.usage`        | counter, `{token}`, DELTA | split by `gen_ai.token.type`                                    |
| `gen_ai.client.operation.duration` | histogram, `s`, DELTA     |                                                                 |
| span name `{operation} {model}`    | generation span           | e.g. `chat claude-sonnet-4-5`; other names stay low-cardinality |

**Extended beyond the convention**, because the convention has no equivalent and the fact is
load-bearing here:

| Attribute                                               | Why it exists                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `gen_ai.usage.cache_read_input_tokens`                  | The convention lumps input into one count. These are priced ~0.1x and ~1.25–2x      |
| `gen_ai.usage.cache_creation_input_tokens`              | base input, so summing them hides whether a loop rides a warm cache or rewrites it. |
| `gen_ai.token.type` values `cache_read` / `cache_write` | The same split on the counter's dimension.                                          |
| `cat_factory.workspace_id`                              | Tenant scope. Spans only — unbounded, so never a metric dimension.                  |
| `cat_factory.execution_id`                              | The run. Searchable, since the trace id is a hash of it rather than the id itself.  |
| `cat_factory.agent_kind`                                | Kept beside `gen_ai.agent.name` because it is also a bounded METRIC dimension.      |
| `cat_factory.pipeline` / `cat_factory.step_count`       | The run span's pipeline, and the step span's fold size.                             |
| `cat_factory.attempt_count`                             | Dispatches folded into a step span: the rounds of a loop, stated since not split.   |
| `cat_factory.tool_call.seq`                             | The call's ordinal in its dispatch. Start time cannot order a tool loop: several    |
|                                                         | calls routinely share one millisecond.                                              |
| `cat_factory.tool_call.arguments_dropped_chars`         | What the harness's capture cap dropped, so a truncated body is legible AS           |
| `cat_factory.tool_call.result_dropped_chars`            | truncated rather than read as the whole of a short one.                             |

**Deliberately NOT emitted**, each for a reason rather than an oversight:

- **`gen_ai.request.*` sampling parameters** (`temperature`, `top_p`, `max_tokens`, …). The event
  that reaches this package carries none of them: the proxied path records what the upstream
  returned, and the subscription harnesses lift metrics off a CLI's event stream, which never
  reports the ceiling it applied. Emitting defaults would state a request nobody made.
- **`gen_ai.response.model` / `gen_ai.response.id`.** A single `model` field rides the event, and
  it is the model the provider says SERVED the call where the transport reports one. Emitting it
  as both request and response would fabricate agreement between two facts we only have one of.
- **`gen_ai.conversation.id`.** `cat_factory.execution_id` already scopes it, and the run is the
  unit the rest of the platform threads a conversation by.
- **The log-based `gen_ai.client.inference.operation.details` event.** Prompt and completion
  bodies ride the older span events `gen_ai.content.prompt` / `gen_ai.content.completion`, which
  every OTLP backend in the compatibility list above renders today. They are emitted only when
  `LLM_RECORD_PROMPTS` is on; an empty body is omitted rather than sent blank.
- **`gen_ai.operation.name` on the RUN span.** A pipeline run is orchestration: it spends most of
  its wall clock waiting on CI and on humans. Claiming a GenAI operation for it would put that
  wait onto an operator's GenAI dashboards.
- **The pipeline name in the run span's NAME.** The root span is named the bare `run`, with the
  pipeline as `cat_factory.pipeline`. A span name is the one field a backend treats as a
  low-cardinality class (it keys the RED metrics a span-metrics connector derives), which is the
  trace-side counterpart of the rule that a metric dimension must be bounded. Every other name
  here is a closed vocabulary (an operation, a model, an agent kind, a tool); a pipeline is
  workspace-authored free text, so interpolating it would let a tenant mint unbounded series on
  an operator's backend just by renaming pipelines.

## Replaying a settled run

The parents are emitted from the engine's terminal hook, which fires again for a run that has
already settled (a durable re-drive, a decision resolved against a finished run). That is safe by
construction rather than by a claim table, and both halves are load-bearing:

- **The ids are derived**, so a re-emission names the same spans rather than minting a second
  tree beside the first.
- **The extent is folded from stamps the run recorded** (`buildRunTraceSpans` in orchestration),
  never from a clock read at emit time. Both are set-once so a replay cannot move them: a `done`
  run is bounded by its last step's `finishedAt`, a failed one by `AgentFailure.occurredAt`, and a
  step still in flight by its heartbeat. Pairing stable span ids with a duration that changed
  between emissions would give a backend a contradiction to store where it can collapse a
  byte-identical duplicate.

## Platform-operator metrics (deployment health)

The per-call sink above answers "what did THIS run do". The **`PlatformMetricsOtelExporter`**
(`createPlatformMetricsOtelExporter`, the `.` entry) answers "how is the WHOLE deployment
doing": a periodic sweep (Worker `scheduled` cron ⇄ Node interval, runtime-symmetric) computes
the platform-observability projection per account and this exporter pushes it to the same
OTLP endpoint as OpenTelemetry **gauge** metrics, so an operator watches deployment health in
their own metrics backend, the dual of the `post-release-health` gate that watches the
_user's_ release.

Metrics (`cat_factory.platform.*`, all gauges: the OTel backend trends the series over time):

| Metric                                  | Unit    | Split dimension             |
| --------------------------------------- | ------- | --------------------------- |
| `cat_factory.platform.runs`             | `{run}` | `cat_factory.run_status`    |
| `cat_factory.platform.run_success_rate` | `1`     | —                           |
| `cat_factory.platform.run_failures`     | `{run}` | `cat_factory.failure_kind`  |
| `cat_factory.platform.live_runs`        | `{run}` | `cat_factory.run_state`     |
| `cat_factory.platform.run_duration`     | `s`     | `cat_factory.duration_stat` |

Every point carries `cat_factory.account_id` (the bounded tenant scope: safe on a metric,
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

## Log export (the third signal)

The two exporters above answer "what did this run do" and "how is the deployment doing". The
**`OtelLogExporter`** (`createOtelLogExporter`, the `.` entry) carries the platform's own
**structured log lines** to `{endpoint}/v1/logs`, so an operator reads logs beside the traces
and metrics they already correlate with, in one backend, instead of tailing a Worker and
grepping a container's stdout.

It implements the kernel **`LogSink`** port, and `@cat-factory/server`'s logging adapter
(`observability/logger.ts`, the one place a logging library is named) copies every emitted line
to whichever sink a facade installed. Nothing in the domain changes: packages keep logging
through the one `Logger` port and never learn a second destination exists.

```ts
import { createOtelLogExporter } from '@cat-factory/observability-otel'
import { setLogSink } from '@cat-factory/server'

setLogSink(createOtelLogExporter({ endpoint, headers, serviceName, maxBatchSize, logger }))
```

**What a record carries.** The message is the OTLP `body`; the level maps onto the base
`SeverityNumber` of its range (`debug` 5, `info` 9, `warn` 13, `error` 17), so a backend's
`severity >= WARN` filter means what an operator reading `LOG_LEVEL` expects. The line's fields
become attributes under **the names they already have** (`workspaceId`, `executionId`, `jobId`,
`scope`, …) rather than being renamed into the `cat_factory.*` namespace the spans use: one key
works against stdout and the collector, which is worth more than symmetry with a signal whose
attribute names this package chose in the first place. `child`-bound fields are folded in, so a
line keeps the correlation the emitting scope gave it.

**Logs and traces meet structurally.** A line naming an `executionId` is stamped with the SAME
derived trace id that run's spans carry, so a backend links them without either side matching an
attribute, and the record marks that trace SAMPLED so a backend knows the id it is pointed at is
one it should have. A line with no run claims no trace (and no flags), rather than pointing at
one nobody will emit (the same rule the standalone inline call follows above).

That sharing is a **call** to the same `deriveTraceId` the spans go through, never a second copy
of the derivation, and the test asserts a log record's trace id against a **span's**. Both matter:
the two signals agreeing is the whole feature, nothing else enforces it, and a re-derivation plus
a test comparing one log record to another would let the span side drift with every test green.

**Draining is the facade's job, and the two runtimes differ only there:**

| Runtime           | When the buffer is drained                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Node / local      | An interval (`OTEL_LOGS_FLUSH_INTERVAL_MS`, default 5s), plus a final flush on shutdown bounded to 5s |
| Cloudflare Worker | The end of every invocation, as a `waitUntil` after the response                                      |

A Worker's module state is per ISOLATE and an isolate is discarded whenever the runtime decides,
so a buffered line has no later tick guaranteed to reach it: the same reasoning (and the same
per-invocation cost, stated rather than assumed) as the operational-metrics flush beside it. A
full batch also sends on its own, so a burst does not wait for the next tick.

**What it does with what it cannot deliver**, each of which was a way to make observability the
new failure class:

- **A failed POST is logged and dropped**, never thrown: `record` only buffers and `flush`
  resolves even when the delivery failed.
- **The exporter refuses to export its own failure reports.** They are logged through a logger
  bound with `otelLogExport: true` and records carrying that field are dropped, or a collector
  outage becomes an ever-growing batch of lines about a collector outage. The warning still
  reaches the local writer, which is where an operator whose collector is down can read it.
- **The buffer is bounded** (`maxBatchSize` × 8) and drops the OLDEST beyond it, because during
  an outage the newest lines are the ones being looked at. **The drop count rides the next
  batch out** as its own record: a silently short stream reads exactly like a quiet one.
- **An oversized field is capped at 8 KiB and says how much it cut.** A collector rejects an
  oversized batch whole, so one field carrying captured command output would otherwise drop
  every line beside it.
- **A field that cannot be serialised degrades to a note naming the problem**, never taking the
  line with it. Absent and empty stay distinct: a `null`/`undefined` field is omitted rather
  than exported as `""`.
- **A field that cannot even be READ degrades the same way, per field.** `LogFields` is
  `Record<string, unknown>`, so a value can throw on access (an accessor property, a Proxy trap).
  This runs on the DRAIN path, past the try/catch the logging adapter wraps `record` in, so the
  mapping owes its own guards: an unreadable value is reported under its own key (the key's
  presence is what says the emitter had something there) and its neighbours are unaffected.
- **The send chain is terminated**, so `flush` cannot reject however the drain path fails. Sends
  are serialised behind one promise tail, and an escaped rejection there is not one lost batch:
  every later send would inherit it, the exporter would go permanently silent, and on Node the
  flush interval's un-awaited call would become an unhandled rejection that the process failure
  guards answer by exiting. Observability may not take the deployment down.

**Opt-in on top of the base exporter** (it adds an egress POST per batch of lines): off unless
`OTEL_ENABLED=true` + an endpoint AND `OTEL_LOGS=true`. `OTEL_LOGS_MAX_BATCH_SIZE` (default 128)
sets the lines per POST and, with the multiplier above, the buffer bound; on Node
`OTEL_LOGS_FLUSH_INTERVAL_MS` (default 5s) sets the cadence (the Worker flushes per invocation).

**`LOG_LEVEL` governs both destinations.** The export sits behind the same threshold as the
local writer, so an operator has one dial rather than two that can disagree; there is
deliberately no separate export level.

**Two things are NOT exported, and both are stated here rather than left to be discovered:**

- **Lines emitted before config is resolved** (the `LOG_LEVEL` read, the process guards, config
  validation, migrations) reach the local writer only. The endpoint IS config, and buffering
  against one that may never arrive would be a leak on exactly the boots that fail.
- **Nothing is scrubbed here.** A field carrying command output, a URL or model text goes
  through `redactSecrets` at its emit site (`backend/docs/logging.md`); this exporter carries
  what the local writer already got, and adding a second scrub would state a guarantee the
  stdout stream does not have.
