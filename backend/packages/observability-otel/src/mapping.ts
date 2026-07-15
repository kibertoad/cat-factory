import type { LlmGenerationEvent, LlmToolSpan, LlmToolSpanContext } from '@cat-factory/kernel'

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
 * so the two transports can never disagree on a key.
 */
export const ATTR = {
  system: 'gen_ai.system',
  requestModel: 'gen_ai.request.model',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  finishReasons: 'gen_ai.response.finish_reasons',
  tokenType: 'gen_ai.token.type',
  workspaceId: 'cat_factory.workspace_id',
  agentKind: 'cat_factory.agent_kind',
  serviceName: 'service.name',
} as const

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

/** A transport-neutral span, ready to encode as OTLP JSON or feed the SDK tracer. */
export interface MappedSpan {
  /** 32-hex trace id (a run's calls share one; standalone calls get a random one). */
  traceId: string
  name: string
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

/** Epoch ms → OTLP unix-nano string (string arithmetic avoids float precision loss). */
export function toUnixNano(ms: number): string {
  return `${Math.round(ms)}000000`
}

/** The dimensions shared by a generation's span and its metrics. */
function generationDimensions(event: LlmGenerationEvent): AttributeMap {
  const attrs: AttributeMap = {
    [ATTR.system]: event.provider,
    [ATTR.requestModel]: event.model,
    [ATTR.agentKind]: event.agentKind,
  }
  if (event.workspaceId) attrs[ATTR.workspaceId] = event.workspaceId
  return attrs
}

/** Map one completed LLM call to a neutral span. */
export function mapGeneration(event: LlmGenerationEvent): MappedSpan {
  const attributes: AttributeMap = {
    ...generationDimensions(event),
    [ATTR.inputTokens]: event.promptTokens,
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
    name: event.agentKind,
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
  const dims = generationDimensions(event)
  return {
    tokenUsage: [
      { value: event.promptTokens, attributes: { ...dims, [ATTR.tokenType]: 'input' } },
      { value: event.completionTokens, attributes: { ...dims, [ATTR.tokenType]: 'output' } },
    ],
    durationSeconds: Math.max(0, event.endedAt - event.startedAt) / 1000,
    durationAttributes: dims,
    startTimeMs: event.startedAt,
    endTimeMs: event.endedAt,
  }
}

/** Map one container tool call to a neutral span under its run's trace. */
export function mapToolSpan(context: LlmToolSpanContext, span: LlmToolSpan): MappedSpan {
  const attributes: AttributeMap = { [ATTR.agentKind]: context.agentKind }
  if (context.workspaceId) attributes[ATTR.workspaceId] = context.workspaceId
  return {
    // Tool spans only reach here with a non-null executionId (the sinks guard on it).
    traceId: deriveTraceId(context.executionId),
    name: span.tool,
    startTimeMs: span.startedAt,
    endTimeMs: span.endedAt,
    ok: span.ok,
    attributes,
    events: [],
  }
}
