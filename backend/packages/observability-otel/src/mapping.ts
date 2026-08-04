import type {
  LlmGenerationEvent,
  LlmRunSpan,
  LlmStepSpan,
  LlmToolSpan,
  LlmToolSpanContext,
  OperationalCounter,
  OperationalCounterSample,
  OperationalGauge,
  OperationalGaugeSample,
} from '@cat-factory/kernel'
import type { PlatformObservability } from '@cat-factory/contracts'

// The SINGLE source of truth for how a cat-factory observability event becomes
// OpenTelemetry telemetry. BOTH transports import from here — the workerd-safe fetch
// exporter (`./index`) and the official-SDK exporter (`./node`) — so the attribute keys,
// metric names/units, span shape, trace-id grouping and timestamps they emit are
// identical by construction. `src/conformity.test.ts` feeds the same events through both
// and asserts the emitted telemetry matches; this module is why that holds.
//
// Nothing here depends on `@opentelemetry/*` or on any runtime API beyond the `crypto`
// global (present on both workerd and Node), so it stays importable from the fetch entry
// that must not pull the Node-only SDK into the Worker bundle.

/** Default OTLP resource `service.name`; overridable via `OTEL_SERVICE_NAME`. */
export const DEFAULT_SERVICE_NAME = 'cat-factory'

/** The instrumentation scope name stamped on every emitted span/metric. */
export const SCOPE_NAME = '@cat-factory/observability-otel'

/**
 * Attribute keys, following the OpenTelemetry GenAI semantic conventions where they exist
 * (`gen_ai.*`) plus a small `cat_factory.*` namespace for our own dimensions. Centralised
 * so the two transports can never disagree on a key. What of the convention we cover, what
 * we deliberately omit, and where we extend it is documented per key in the README's "GenAI
 * semantic-convention coverage" table — that table and this object are edited together.
 */
export const ATTR = {
  system: 'gen_ai.system',
  operationName: 'gen_ai.operation.name',
  requestModel: 'gen_ai.request.model',
  inputTokens: 'gen_ai.usage.input_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read_input_tokens',
  cacheWriteTokens: 'gen_ai.usage.cache_creation_input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  finishReasons: 'gen_ai.response.finish_reasons',
  tokenType: 'gen_ai.token.type',
  agentName: 'gen_ai.agent.name',
  toolName: 'gen_ai.tool.name',
  workspaceId: 'cat_factory.workspace_id',
  agentKind: 'cat_factory.agent_kind',
  executionId: 'cat_factory.execution_id',
  pipeline: 'cat_factory.pipeline',
  stepCount: 'cat_factory.step_count',
  attemptCount: 'cat_factory.attempt_count',
  serviceName: 'service.name',
} as const

/**
 * The `gen_ai.operation.name` values we emit. The convention's registry is open, but every
 * value here is one of its own: `chat` for a model call, `execute_tool` for a tool
 * invocation, `invoke_agent` for an agent's whole turn (our step span). A run's ROOT span
 * carries none of them on purpose — a pipeline run is not a GenAI operation, so claiming one
 * would put non-model work on an operator's GenAI dashboards.
 */
export const OPERATION = {
  chat: 'chat',
  executeTool: 'execute_tool',
  invokeAgent: 'invoke_agent',
} as const

/**
 * The run root span's name. A constant rather than an interpolation, because a span name is a
 * low-cardinality CLASS; see {@link mapRunSpan} for why the pipeline stays an attribute.
 */
export const RUN_SPAN_NAME = 'run'

/** Metric names + units (OTel GenAI client metrics). */
export const METRIC = {
  tokenUsage: 'gen_ai.client.token.usage',
  duration: 'gen_ai.client.operation.duration',
} as const
export const TOKEN_UNIT = '{token}'
export const DURATION_UNIT = 's'

/** Span event names carrying the prompt / completion bodies (only when recorded). */
const EVENT = {
  prompt: 'gen_ai.content.prompt',
  completion: 'gen_ai.content.completion',
} as const
const EVENT_ATTR = {
  prompt: 'gen_ai.prompt',
  completion: 'gen_ai.completion',
} as const

/** A neutral attribute value both transports understand (string / number / string list). */
export type AttributeValue = string | number | string[]
export type AttributeMap = Record<string, AttributeValue>

interface MappedEvent {
  name: string
  /** Epoch ms. */
  timeMs: number
  attributes: AttributeMap
}

/**
 * Which OTel span kind a mapped span carries, named neutrally so the two transports each
 * translate it into their own enum instead of the caller passing a proto number to one and an
 * SDK enum to the other (which is a way for them to silently disagree).
 */
export type MappedSpanKind = 'client' | 'internal'

/** A transport-neutral span, ready to encode as OTLP JSON or feed the SDK tracer. */
export interface MappedSpan {
  /** 32-hex trace id (a run's spans share one; standalone calls get a random one). */
  traceId: string
  /** 16-hex span id. Random for a leaf; DERIVED for a parent (see {@link deriveRunSpanId}). */
  spanId: string
  /**
   * 16-hex id of this span's parent, or undefined for a root. A leaf names its parent by
   * DERIVING the id rather than by having been told it, which is what lets a stateless
   * per-call emission take part in a hierarchy assembled by the backend.
   */
  parentSpanId?: string
  name: string
  kind: MappedSpanKind
  /** Epoch ms. */
  startTimeMs: number
  /** Epoch ms. */
  endTimeMs: number
  /** false ⇒ the span carries ERROR status + {@link statusMessage}. */
  ok: boolean
  statusMessage?: string
  attributes: AttributeMap
  events: MappedEvent[]
}

/** One token-usage counter data point (one per {@link ATTR.tokenType}). */
interface MappedTokenUsage {
  value: number
  attributes: AttributeMap
}

/** The metrics derived from one generation. */
export interface MappedMetrics {
  tokenUsage: MappedTokenUsage[]
  /** Request duration in seconds (histogram value). */
  durationSeconds: number
  durationAttributes: AttributeMap
  /** Epoch ms bounds for the (delta) data points. */
  startTimeMs: number
  endTimeMs: number
}

/** Hex-encode `bytes` random bytes via the `crypto` global (both workerd and Node). */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  let out = ''
  for (const b of arr) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Deterministic hex of `bytes` bytes from a string, so every call of a run derives the
 * SAME trace id and the backend groups them into one trace — the fetch and SDK transports
 * therefore agree without sharing state. FNV-1a, re-hashed with a counter salt to fill the
 * width. Guaranteed non-zero (OTLP rejects an all-zero id).
 *
 * A SPREADING function, not a cryptographic one, and the ids it derives are chosen so that is
 * enough: the only ones that must not collide are the handful within a single trace (one run
 * span plus one step span per agent kind, each keyed on a distinct prefixed string), and a
 * trace id collides only across two different execution ids over the full 128 bits. Nothing
 * here is a security boundary, and no leaf span id comes from it: those are `randomSpanId`.
 * A collision-resistant hash would be the right answer the moment an id is derived from
 * something an untrusted party chooses.
 */
function hashHex(input: string, bytes: number): string {
  let out = ''
  for (let i = 0; out.length < bytes * 2; i++) {
    let h = 0x811c9dc5
    const salted = `${i}:${input}`
    for (let j = 0; j < salted.length; j++) {
      h ^= salted.charCodeAt(j)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  out = out.slice(0, bytes * 2)
  return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out
}

export function randomTraceId(): string {
  return randomHex(16)
}

export function randomSpanId(): string {
  return randomHex(8)
}

/** The trace id a call belongs to: derived from its run, else a fresh standalone id. */
function deriveTraceId(executionId: string | null): string {
  return executionId ? hashHex(executionId, 16) : randomTraceId()
}

// The span hierarchy is `run → agent-kind step → (generations, tool calls)`, and it is built
// WITHOUT any shared state: the two parent ids are pure functions of ids every emitter already
// holds, so a generation recorded by the LLM proxy on one isolate and a tool span drained by the
// engine on another both name the same parent without either having seen it. The parents
// themselves are emitted once, when the run settles (`mapRunSpan` / `mapStepSpan`) — the same
// ordering any OTel SDK produces, where a parent exports after the children it outlives.
//
// The prefixes matter: without them a run and its step of the same id string would hash to the
// same span id, and a run whose agent kind happened to equal its own id would collide with its
// own root.

/** The DERIVED span id of a run's root span. */
export function deriveRunSpanId(executionId: string): string {
  return hashHex(`run:${executionId}`, 8)
}

/**
 * The DERIVED span id of one `(run, agent kind)` step span — the parent every generation and
 * tool span of that kind hangs under. Keyed on the agent kind because that is all a generation
 * event carries; see `LlmStepSpan` for why that grain is the right one rather than a compromise.
 */
export function deriveStepSpanId(executionId: string, agentKind: string): string {
  return hashHex(`step:${executionId}:${agentKind}`, 8)
}

/** Epoch ms → OTLP unix-nano string (string arithmetic avoids float precision loss). */
export function toUnixNano(ms: number): string {
  return `${Math.round(ms)}000000`
}

/**
 * The LOW-cardinality dimensions safe to carry on a metric time series: provider, model,
 * and agent kind are all bounded sets. Deliberately EXCLUDES the workspace id — it is
 * unbounded (one value per tenant), so putting it on a metric would explode the backend's
 * time-series cardinality (and cost). The workspace id belongs on spans, where high
 * cardinality is expected; see {@link generationDimensions}.
 */
function metricDimensions(event: LlmGenerationEvent): AttributeMap {
  return {
    [ATTR.system]: event.provider,
    [ATTR.requestModel]: event.model,
    [ATTR.agentKind]: event.agentKind,
  }
}

/**
 * The dimensions on a generation's SPAN: the metric dimensions plus the ids too
 * high-cardinality for a metric time series but exactly what a trace is searched by.
 */
function generationDimensions(event: LlmGenerationEvent): AttributeMap {
  const attrs = metricDimensions(event)
  if (event.workspaceId) attrs[ATTR.workspaceId] = event.workspaceId
  if (event.executionId) attrs[ATTR.executionId] = event.executionId
  return attrs
}

/** Map one completed LLM call to a neutral span. */
export function mapGeneration(event: LlmGenerationEvent): MappedSpan {
  const attributes: AttributeMap = {
    ...generationDimensions(event),
    [ATTR.operationName]: OPERATION.chat,
    // The three input classes stay APART on the span: they are priced ~0.1× / 1.25–2× / 1×
    // base input respectively, so a consumer that sums them loses the only signal that says
    // whether a long run is riding a warm cache or re-writing it every turn.
    [ATTR.inputTokens]: event.promptTokens,
    [ATTR.cacheReadTokens]: event.cacheReadTokens,
    [ATTR.cacheWriteTokens]: event.cacheWriteTokens,
    [ATTR.outputTokens]: event.completionTokens,
  }
  if (event.finishReason) attributes[ATTR.finishReasons] = [event.finishReason]

  const events: MappedEvent[] = []
  // Bodies are present only when prompt recording is on (upstream blanks them otherwise),
  // so an empty string means "not recorded" and is omitted — matching the Langfuse sink.
  if (event.input) {
    events.push({
      name: EVENT.prompt,
      timeMs: event.startedAt,
      attributes: { [EVENT_ATTR.prompt]: event.input },
    })
  }
  if (event.output) {
    events.push({
      name: EVENT.completion,
      timeMs: event.endedAt,
      attributes: { [EVENT_ATTR.completion]: event.output },
    })
  }

  return {
    traceId: deriveTraceId(event.executionId),
    spanId: randomSpanId(),
    // A run-scoped call hangs under its agent kind's step span; a standalone inline call
    // (requirements review, doc planner, fragment selector) has no run and stays a ROOT, which
    // is the honest shape — there is no hierarchy above it to point at.
    ...(event.executionId
      ? { parentSpanId: deriveStepSpanId(event.executionId, event.agentKind) }
      : {}),
    // The convention's span name is `{operation} {request model}`. The agent kind that used to
    // name this span is now the STEP span's name one level up, so nothing was lost by adopting
    // it — and it still rides here as `cat_factory.agent_kind`.
    name: `${OPERATION.chat} ${event.model}`,
    kind: 'client',
    startTimeMs: event.startedAt,
    endTimeMs: event.endedAt,
    ok: event.ok,
    ...(event.ok ? {} : { statusMessage: event.errorMessage ?? undefined }),
    attributes,
    events,
  }
}

/** Map one completed LLM call to its token-usage + duration metrics. */
export function mapGenerationMetrics(event: LlmGenerationEvent): MappedMetrics {
  // Metrics use the low-cardinality dimensions only (no workspace id) — see metricDimensions.
  const dims = metricDimensions(event)
  return {
    tokenUsage: [
      { value: event.promptTokens, attributes: { ...dims, [ATTR.tokenType]: 'input' } },
      { value: event.cacheReadTokens, attributes: { ...dims, [ATTR.tokenType]: 'cache_read' } },
      { value: event.cacheWriteTokens, attributes: { ...dims, [ATTR.tokenType]: 'cache_write' } },
      { value: event.completionTokens, attributes: { ...dims, [ATTR.tokenType]: 'output' } },
    ],
    durationSeconds: Math.max(0, event.endedAt - event.startedAt) / 1000,
    durationAttributes: dims,
    startTimeMs: event.startedAt,
    endTimeMs: event.endedAt,
  }
}

// ---------------------------------------------------------------------------
// Platform-operator observability → OpenTelemetry metrics. The dual of the per-run
// generation metrics above: where those describe ONE LLM call, these describe the
// deployment's aggregate run health (outcomes, failure taxonomy, live/parked depth,
// durations) over a trailing window, scoped to an account. A periodic sweep computes the
// `PlatformObservability` projection and feeds it here; the fetch exporter (`./platform`)
// encodes the result as OTLP GAUGE data points (point-in-time aggregates the OTel backend
// itself trends over the series). Emitted here (not `./index`) so the mapping stays the
// single source of truth for both signals.
// ---------------------------------------------------------------------------

/** Metric names for the deployment-level platform observability gauges. */
export const PLATFORM_METRIC = {
  /** Windowed run count, split by run status (done/failed/running/…). */
  runs: 'cat_factory.platform.runs',
  /** Windowed `done / (done + failed)` success ratio (0..1). */
  runSuccessRate: 'cat_factory.platform.run_success_rate',
  /** Windowed failed-run count, split by failure kind. */
  runFailures: 'cat_factory.platform.run_failures',
  /** Current live/parked run count (a snapshot, not windowed), split by lifecycle state. */
  liveRuns: 'cat_factory.platform.live_runs',
  /** Windowed wall-clock run duration (seconds), split by statistic (avg/min/max/pNN). */
  runDuration: 'cat_factory.platform.run_duration',
} as const

/**
 * Attribute keys for the platform metrics. `account_id` is the tenant scope (bounded — the
 * billing entity, far fewer than workspaces, so safe on a metric time series, unlike the
 * workspace id excluded from the per-call metrics); `window` labels the trailing aggregation
 * window. The remaining keys are the bounded split dimensions of each gauge.
 */
export const PLATFORM_ATTR = {
  accountId: 'cat_factory.account_id',
  window: 'cat_factory.window',
  runStatus: 'cat_factory.run_status',
  runState: 'cat_factory.run_state',
  failureKind: 'cat_factory.failure_kind',
  durationStat: 'cat_factory.duration_stat',
} as const

/** Metric units: a dimensionless run count, a dimensionless ratio, and seconds. */
export const RUN_UNIT = '{run}'
export const RATIO_UNIT = '1'
/** The unit of the operational queue-depth gauge (live, dead-lettered, or otherwise). */
export const JOB_UNIT = '{job}'

/** One gauge data point: its dimensions, value, and whether to encode as int or double. */
export interface MappedGaugePoint {
  attributes: AttributeMap
  value: number
  /** true ⇒ encode as an integer (counts); false ⇒ a double (ratios/durations). */
  isInt: boolean
}

/** A gauge metric ready to encode as OTLP or feed the SDK meter. */
export interface MappedGauge {
  name: string
  unit: string
  points: MappedGaugePoint[]
}

/**
 * Map a {@link PlatformObservability} projection to the OpenTelemetry gauge metrics. All are
 * point-in-time gauges (the OTel backend builds trends from the series over time), stamped
 * with the projection's `generatedAt`. Every point carries the `account_id`; the windowed
 * gauges additionally carry the `window` label. Null/absent aggregates (e.g. a success rate
 * or percentiles with no terminal runs) are omitted rather than emitted as a misleading zero.
 */
export function mapPlatformMetrics(
  snapshot: PlatformObservability,
  dims: { accountId: string },
): MappedGauge[] {
  const base: AttributeMap = { [PLATFORM_ATTR.accountId]: dims.accountId }
  const windowed: AttributeMap = { ...base, [PLATFORM_ATTR.window]: snapshot.window }
  const gauges: MappedGauge[] = []

  const o = snapshot.outcomes
  const runStatuses: [string, number][] = [
    ['done', o.done],
    ['failed', o.failed],
    ['running', o.running],
    ['blocked', o.blocked],
    ['paused', o.paused],
    ['other', o.other],
  ]
  gauges.push({
    name: PLATFORM_METRIC.runs,
    unit: RUN_UNIT,
    points: runStatuses.map(([status, value]) => ({
      attributes: { ...windowed, [PLATFORM_ATTR.runStatus]: status },
      value,
      isInt: true,
    })),
  })

  if (o.successRate !== null) {
    gauges.push({
      name: PLATFORM_METRIC.runSuccessRate,
      unit: RATIO_UNIT,
      points: [{ attributes: windowed, value: o.successRate, isInt: false }],
    })
  }

  if (snapshot.failures.length > 0) {
    gauges.push({
      name: PLATFORM_METRIC.runFailures,
      unit: RUN_UNIT,
      points: snapshot.failures.map((f) => ({
        attributes: { ...windowed, [PLATFORM_ATTR.failureKind]: f.kind },
        value: f.count,
        isInt: true,
      })),
    })
  }

  const live = snapshot.live
  gauges.push({
    name: PLATFORM_METRIC.liveRuns,
    unit: RUN_UNIT,
    // Live/parked depth is a snapshot, NOT windowed — so these points carry no window label.
    points: (
      [
        ['running', live.running],
        ['blocked', live.blocked],
        ['paused', live.paused],
        ['pending', live.pending],
      ] as [string, number][]
    ).map(([state, value]) => ({
      attributes: { ...base, [PLATFORM_ATTR.runState]: state },
      value,
      isInt: true,
    })),
  })

  const d = snapshot.durations
  const durationStats: [string, number | null][] = [
    ['avg', d.avgMs],
    ['min', d.minMs],
    ['max', d.maxMs],
    ['p50', d.p50Ms],
    ['p90', d.p90Ms],
    ['p99', d.p99Ms],
  ]
  const durationPoints: MappedGaugePoint[] = durationStats
    .filter(([, ms]) => ms !== null)
    .map(([stat, ms]) => ({
      attributes: { ...windowed, [PLATFORM_ATTR.durationStat]: stat },
      // OTel duration convention is seconds; the projection carries ms.
      value: (ms as number) / 1000,
      isInt: false,
    }))
  if (durationPoints.length > 0) {
    gauges.push({ name: PLATFORM_METRIC.runDuration, unit: DURATION_UNIT, points: durationPoints })
  }

  return gauges
}

/** Map one container tool call to a neutral span under its agent kind's step span. */
export function mapToolSpan(context: LlmToolSpanContext, span: LlmToolSpan): MappedSpan {
  const attributes: AttributeMap = {
    [ATTR.operationName]: OPERATION.executeTool,
    [ATTR.toolName]: span.tool,
    [ATTR.agentKind]: context.agentKind,
  }
  if (context.workspaceId) attributes[ATTR.workspaceId] = context.workspaceId
  if (context.executionId) attributes[ATTR.executionId] = context.executionId
  return {
    // Tool spans only reach here with a non-null executionId (the sinks guard on it).
    traceId: deriveTraceId(context.executionId),
    spanId: randomSpanId(),
    ...(context.executionId
      ? { parentSpanId: deriveStepSpanId(context.executionId, context.agentKind) }
      : {}),
    name: `${OPERATION.executeTool} ${span.tool}`,
    kind: 'internal',
    startTimeMs: span.startedAt,
    endTimeMs: span.endedAt,
    ok: span.ok,
    attributes,
    events: [],
  }
}

/**
 * Map a settled run to its ROOT span: the ancestor of every step span, and transitively of
 * every generation and tool span the run emitted.
 *
 * It carries no `gen_ai.operation.name`. A pipeline run is orchestration, not a model
 * operation, and stamping one would file the wait on a human decision as GenAI activity.
 *
 * The name is the bare `run`, with the pipeline riding as `cat_factory.pipeline` rather than
 * interpolated into it. A span name is the one field a backend treats as a low-cardinality
 * CLASS: it keys the RED metrics a span-metrics connector derives, and the trace-side
 * counterpart of the rule that a metric dimension must be BOUNDED. Every other name here is a
 * closed vocabulary (an operation, a model, an agent kind, a tool), but a pipeline is
 * workspace-authored free text, so interpolating it would let a tenant mint an unbounded
 * number of series on an operator's backend by renaming pipelines.
 */
export function mapRunSpan(run: LlmRunSpan): MappedSpan {
  const attributes: AttributeMap = {
    [ATTR.executionId]: run.executionId,
    [ATTR.pipeline]: run.pipelineName,
  }
  if (run.workspaceId) attributes[ATTR.workspaceId] = run.workspaceId
  return {
    traceId: deriveTraceId(run.executionId),
    spanId: deriveRunSpanId(run.executionId),
    name: RUN_SPAN_NAME,
    kind: 'internal',
    startTimeMs: run.startedAt,
    endTimeMs: run.endedAt,
    ok: run.ok,
    ...(run.ok ? {} : { statusMessage: run.errorMessage ?? undefined }),
    attributes,
    events: [],
  }
}

/**
 * Map one `(run, agent kind)` slice to the step span its generations and tool calls hang under.
 *
 * A HELPER kind (a gate's `ci-fixer`, a Tester's fixer, a `fork-proposer`) names its hosting
 * kind as parent instead of the run, so an escalation reads as what it is rather than as a
 * pipeline step of its own.
 */
export function mapStepSpan(step: LlmStepSpan): MappedSpan {
  const attributes: AttributeMap = {
    [ATTR.operationName]: OPERATION.invokeAgent,
    [ATTR.agentName]: step.agentKind,
    [ATTR.agentKind]: step.agentKind,
    [ATTR.executionId]: step.executionId,
    // Both counts are stated ALWAYS, not only when they exceed one: a reader who has to infer a
    // fold from its absence reads a two-step slice as one step that took twice as long, and a
    // six-round fixer loop as one long fix. `step_count` folds steps of a kind; `attempt_count`
    // folds the DISPATCHES inside them, which is the cycle a run actually repeats.
    [ATTR.stepCount]: step.stepCount,
    [ATTR.attemptCount]: step.attemptCount,
  }
  if (step.workspaceId) attributes[ATTR.workspaceId] = step.workspaceId
  return {
    traceId: deriveTraceId(step.executionId),
    spanId: deriveStepSpanId(step.executionId, step.agentKind),
    parentSpanId: step.parentAgentKind
      ? deriveStepSpanId(step.executionId, step.parentAgentKind)
      : deriveRunSpanId(step.executionId),
    name: `${OPERATION.invokeAgent} ${step.agentKind}`,
    kind: 'internal',
    startTimeMs: step.startedAt,
    endTimeMs: step.endedAt,
    ok: step.ok,
    ...(step.ok ? {} : { statusMessage: step.errorMessage ?? undefined }),
    attributes,
    events: [],
  }
}

// ---------------------------------------------------------------------------
// Operational metrics: the deployment's own behaviour (sweeper activity, container dispatch
// failures + evictions, queue depth, dropped telemetry, cache hit/miss), as opposed to the
// run aggregates above. These come from the kernel `OperationalMetrics` seam rather than from
// a projection over a table, because they describe EVENTS rather than rows.
//
// The temporality split is the load-bearing part. Counters are accumulated per process
// (Node/local) or per isolate (the Worker) and flushed by whoever holds them, so they are
// exported as DELTA sums: two flushers each reporting their own delta sum correctly in the
// backend, where two flushers each reporting a cumulative total would not. `queue.depth` is a
// genuine gauge — probed at export time from something that already knows the answer.
// ---------------------------------------------------------------------------

/**
 * Metric name per operational counter. An exhaustive `Record` over the kernel union, so
 * adding a counter there fails to compile until it is named here — the same guard the
 * `STATUS_BY_CODE` error map gives the wire vocabulary.
 */
export const OPERATIONAL_METRIC: Record<OperationalCounter, string> = {
  'sweep.run_redriven': 'cat_factory.platform.sweep_runs_redriven',
  'sweep.run_finalized': 'cat_factory.platform.sweep_runs_finalized',
  'sweep.run_stalled': 'cat_factory.platform.sweep_runs_stalled',
  'sweep.failed': 'cat_factory.platform.sweep_failures',
  'container.dispatch_failed': 'cat_factory.platform.container_dispatch_failures',
  'container.evicted': 'cat_factory.platform.container_evictions',
  'telemetry.export_dropped': 'cat_factory.platform.telemetry_exports_dropped',
  'notification.delivery_failed': 'cat_factory.platform.notification_delivery_failures',
  'cache.hit': 'cat_factory.platform.cache_hits',
  'cache.miss': 'cat_factory.platform.cache_misses',
  'auth.throttle.limited': 'cat_factory.platform.auth_throttle_limited',
  'auth.throttle.store_unavailable': 'cat_factory.platform.auth_throttle_store_unavailable',
}

/** Metric name per operational gauge. Exhaustive, for the same reason. */
export const OPERATIONAL_GAUGE_METRIC: Record<OperationalGauge, string> = {
  'queue.depth': 'cat_factory.platform.queue_depth',
}

/**
 * Unit per operational counter — a decision at the point a signal is added rather than a
 * default, because `{run}` and `{read}` trend very differently and an operator reading a
 * dashboard has only the unit to tell them apart.
 */
const OPERATIONAL_UNIT: Record<OperationalCounter, string> = {
  'sweep.run_redriven': RUN_UNIT,
  'sweep.run_finalized': RUN_UNIT,
  'sweep.run_stalled': RUN_UNIT,
  'sweep.failed': '{failure}',
  'container.dispatch_failed': '{failure}',
  'container.evicted': '{eviction}',
  'telemetry.export_dropped': '{export}',
  'notification.delivery_failed': '{failure}',
  'cache.hit': '{read}',
  'cache.miss': '{read}',
  'auth.throttle.limited': '{refusal}',
  'auth.throttle.store_unavailable': '{failure}',
}

/**
 * Namespace a sample's dimension keys onto the `cat_factory.` attribute prefix every other
 * emitted attribute uses, so an operational point sits beside the platform gauges in the same
 * backend without a second naming convention.
 */
function operationalAttributes(dimensions: Readonly<Record<string, string>>): AttributeMap {
  const attributes: AttributeMap = {}
  for (const [key, value] of Object.entries(dimensions)) attributes[`cat_factory.${key}`] = value
  return attributes
}

/** One counter metric ready to encode as an OTLP delta sum. */
export interface MappedCounter {
  name: string
  unit: string
  points: MappedGaugePoint[]
}

/**
 * Map drained counter deltas onto OTLP delta sums, one metric per counter with a data point
 * per dimension set. Samples for the same counter are grouped, because OTLP wants one metric
 * carrying many points rather than the same metric repeated.
 *
 * Deliberately NOT account-scoped: an eviction or a cache miss belongs to the deployment, not
 * to a tenant, and stamping a synthetic account on it would invent an attribution the event
 * does not have.
 */
export function mapOperationalCounters(samples: OperationalCounterSample[]): MappedCounter[] {
  const byMetric = new Map<OperationalCounter, MappedGaugePoint[]>()
  for (const sample of samples) {
    const points = byMetric.get(sample.counter) ?? []
    points.push({
      attributes: operationalAttributes(sample.dimensions),
      value: sample.value,
      isInt: true,
    })
    byMetric.set(sample.counter, points)
  }
  return [...byMetric].map(([counter, points]) => ({
    name: OPERATIONAL_METRIC[counter],
    unit: OPERATIONAL_UNIT[counter],
    points,
  }))
}

/** Map probed gauge readings onto OTLP gauges, one metric per gauge. */
export function mapOperationalGauges(samples: OperationalGaugeSample[]): MappedGauge[] {
  const byMetric = new Map<OperationalGauge, MappedGaugePoint[]>()
  for (const sample of samples) {
    const points = byMetric.get(sample.gauge) ?? []
    points.push({
      attributes: operationalAttributes(sample.dimensions),
      value: sample.value,
      isInt: true,
    })
    byMetric.set(sample.gauge, points)
  }
  return [...byMetric].map(([gauge, points]) => ({
    name: OPERATIONAL_GAUGE_METRIC[gauge],
    unit: JOB_UNIT,
    points,
  }))
}
