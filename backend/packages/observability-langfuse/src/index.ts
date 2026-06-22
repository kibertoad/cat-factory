import type {
  LlmGenerationEvent,
  LlmToolSpan,
  LlmToolSpanContext,
  LlmTraceSink,
} from '@cat-factory/kernel'

// A fetch-based Langfuse trace sink. It speaks Langfuse's public **ingestion API**
// (`POST /api/public/ingestion`, HTTP Basic auth = public:secret key, batched JSON
// events) using only the global `fetch`/`crypto`/`btoa` — NO `langfuse` Node SDK and
// NO `@opentelemetry/*`, both of which depend on Node-only APIs that are unavailable on
// the Cloudflare Worker runtime (workerd). This keeps the sink byte-for-byte identical
// across the Worker and Node facades, which is the whole reason it exists as its own
// package: see `LlmTraceSink` in `@cat-factory/kernel`.
//
// Observability must never break the product, so every method swallows its own errors
// (logging at most a warning) and the caller additionally schedules the call off the
// response path. A failed flush drops that batch; it never propagates.

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com'

/** Minimal structured logger (pino-compatible); optional. */
export interface LangfuseLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

export interface LangfuseSinkConfig {
  /** Langfuse public key (`pk-lf-…`). */
  publicKey: string
  /** Langfuse secret key (`sk-lf-…`). */
  secretKey: string
  /** Host of the Langfuse instance. Default: Langfuse Cloud (`https://cloud.langfuse.com`). */
  baseUrl?: string
  /** Optional logger for swallowed errors. */
  logger?: LangfuseLogger
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** One event envelope in an ingestion batch. */
interface IngestionEvent {
  id: string
  type: string
  timestamp: string
  body: Record<string, unknown>
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function basicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`
}

export class LangfuseTraceSink implements LlmTraceSink {
  private readonly endpoint: string
  private readonly authorization: string
  private readonly logger?: LangfuseLogger
  private readonly fetchImpl: typeof fetch

  constructor(config: LangfuseSinkConfig) {
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.endpoint = `${base}/api/public/ingestion`
    this.authorization = basicAuth(config.publicKey, config.secretKey)
    this.logger = config.logger
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async recordGeneration(event: LlmGenerationEvent): Promise<void> {
    // Group every call of a run under one trace (keyed by the execution id); inline
    // single-shot calls (no execution) become their own standalone trace.
    const traceId = event.executionId ?? crypto.randomUUID()
    const generation: Record<string, unknown> = {
      id: crypto.randomUUID(),
      traceId,
      name: event.agentKind,
      startTime: iso(event.startedAt),
      endTime: iso(event.endedAt),
      model: event.model,
      usage: {
        input: event.promptTokens,
        output: event.completionTokens,
        total: event.totalTokens,
        unit: 'TOKENS',
      },
      level: event.ok ? 'DEFAULT' : 'ERROR',
      metadata: {
        provider: event.provider,
        agentKind: event.agentKind,
        finishReason: event.finishReason,
        workspaceId: event.workspaceId,
      },
    }
    // Prompt/response bodies are present only when prompt recording is on (the same
    // `LLM_RECORD_PROMPTS` switch the local store honours): omit empty bodies entirely.
    if (event.input) generation.input = event.input
    if (event.output) generation.output = event.output
    if (event.errorMessage) generation.statusMessage = event.errorMessage

    await this.send([
      {
        id: crypto.randomUUID(),
        type: 'trace-create',
        timestamp: iso(event.endedAt),
        body: {
          id: traceId,
          name: event.executionId ? `run ${event.executionId}` : event.agentKind,
          tags: [event.agentKind],
          metadata: { workspaceId: event.workspaceId },
        },
      },
      {
        id: crypto.randomUUID(),
        type: 'generation-create',
        timestamp: iso(event.endedAt),
        body: generation,
      },
    ])
  }

  async recordToolSpans(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> {
    // Tool spans are only meaningful as children of a run's trace.
    if (!context.executionId || spans.length === 0) return
    const traceId = context.executionId
    const batch: IngestionEvent[] = spans.map((span) => ({
      id: crypto.randomUUID(),
      type: 'span-create',
      timestamp: iso(span.endedAt),
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: span.tool,
        startTime: iso(span.startedAt),
        endTime: iso(span.endedAt),
        level: span.ok ? 'DEFAULT' : 'ERROR',
        metadata: { agentKind: context.agentKind },
      },
    }))
    await this.send(batch)
  }

  private async send(batch: IngestionEvent[]): Promise<void> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authorization,
        },
        body: JSON.stringify({ batch }),
      })
      // 207 = partial success (per-event errors in the body); anything else non-2xx is
      // a hard failure. Either way we only log — observability never breaks the caller.
      if (!res.ok && res.status !== 207) {
        this.logger?.warn(
          { scope: 'langfuse', status: res.status },
          'langfuse: ingestion rejected batch',
        )
      }
    } catch (err) {
      this.logger?.warn(
        { scope: 'langfuse', err: err instanceof Error ? err.message : String(err) },
        'langfuse: failed to post ingestion batch',
      )
    }
  }
}

/** Build a {@link LangfuseTraceSink}. Returns the opt-in sink wired into a facade. */
export function createLangfuseSink(config: LangfuseSinkConfig): LangfuseTraceSink {
  return new LangfuseTraceSink(config)
}
