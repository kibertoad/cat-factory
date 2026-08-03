import { type Logger, noopLogger } from './logging.js'
import { type OperationalMetrics, noopOperationalMetrics } from './operational-metrics.js'
import { describeError } from '../shared/best-effort.js'

// Optional, opt-in sink for streaming LLM activity to an external observability
// platform (e.g. Langfuse). It is the SINGLE code path that both LLM feeders reach:
//
//  - the runtime-neutral LLM proxy (container agent calls) — the orchestration
//    `LlmObservabilityService` fans every metered call out here after persisting it;
//  - the inline (non-proxied) LLM calls (the requirements reviewer/rework, the
//    document planner, the fragment selector, the inline agent executor) — an
//    `InstrumentedModelProvider` wraps every resolved model so each `generateText`
//    surfaces the same {@link LlmGenerationEvent} here.
//
// Both build the identical {@link LlmGenerationEvent} and call {@link
// LlmTraceSink.recordGeneration}, so adding a second feeder never means a second
// sink. The port is implemented by an opt-in package (`@cat-factory/observability-langfuse`)
// and wired into a facade only when configured; absent ⇒ no external emission and no
// behaviour change. A sink MUST NOT throw into its caller (LLM work must never break
// because observability is down) — implementations swallow + log their own errors, and
// callers additionally schedule the call off the response path.

/** One completed LLM call (proxied or inline), normalised for an external trace. */
export interface LlmGenerationEvent {
  /** The workspace the call ran for, or null when not in a workspace scope. */
  workspaceId: string | null
  /**
   * The run this call belongs to, used to group every call of a run under one trace.
   * Null for inline single-shot calls (requirements review / doc planner / fragment
   * selection), which then become their own standalone trace.
   */
  executionId: string | null
  /** The agent kind / call site (`coder`, `merger`, `requirements-review`, …). */
  agentKind: string
  provider: string
  model: string
  /** Epoch ms the call started (upstream dispatch). */
  startedAt: number
  /** Epoch ms the call completed. */
  endedAt: number
  /** FRESH (uncached) input tokens — exclusive of both cache classes below. */
  promptTokens: number
  /** Input tokens served from the provider's prefix cache. */
  cacheReadTokens: number
  /** Input tokens written into the provider's cache. */
  cacheWriteTokens: number
  completionTokens: number
  totalTokens: number
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | …), or null. */
  finishReason: string | null
  /** Whether the call succeeded. */
  ok: boolean
  /** A short error message when {@link ok} is false, else null. */
  errorMessage: string | null
  /**
   * The request messages serialised as JSON (the FULL prompt, not a delta), or empty
   * when prompt recording is disabled (`LLM_RECORD_PROMPTS=false`) — the same privacy
   * switch the local metric store honours.
   */
  input: string
  /** The full assistant response text, or empty when prompt recording is disabled. */
  output: string
}

/**
 * One tool invocation inside a container agent's loop, captured by the harness and
 * drained by the backend on its existing job poll, then emitted as a child span under
 * the run's trace. Metadata only (never tool args/results) so the harness buffer stays
 * tiny and bounded.
 */
export interface LlmToolSpan {
  /** The tool name (`edit_file`, `run_command`, `todo`, …). */
  tool: string
  /** Epoch ms the tool call started. */
  startedAt: number
  /** Epoch ms the tool call ended. */
  endedAt: number
  /** Whether the tool call succeeded. */
  ok: boolean
}

/** Scope a batch of {@link LlmToolSpan tool spans} to the run that produced them. */
export interface LlmToolSpanContext {
  workspaceId: string | null
  executionId: string | null
  agentKind: string
}

export interface LlmTraceSink {
  /** Emit one completed LLM call as a generation under its run's trace. */
  recordGeneration(event: LlmGenerationEvent): Promise<void> | void
  /**
   * Emit a drained batch of container tool spans, grouped under the run's trace.
   * Optional: a sink that only cares about generations can omit it.
   */
  recordToolSpans?(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> | void
  /**
   * Flush any buffered telemetry (best-effort). Implemented by sinks that batch before
   * export (e.g. the OpenTelemetry SDK exporter); a fetch-per-call sink that already
   * awaits each request omits it. Never throws into the caller.
   */
  forceFlush?(): Promise<void> | void
  /**
   * Release resources and flush a final time before the process exits (best-effort). Wire
   * into the facade's graceful-shutdown path so the last batch isn't dropped. Implemented
   * only by sinks that own background exporters/timers; never throws into the caller.
   */
  shutdown?(): Promise<void> | void
}

/**
 * Fan one trace out to every configured sink, isolating per-sink failures. A deployment
 * that enables more than one external destination (e.g. Langfuse AND an OpenTelemetry
 * collector) wires them behind this so the single {@link LlmTraceSink} slot the facades
 * expose reaches all of them. Mirrors `CompositeNotificationChannel`: observability must
 * never break the caller, so every per-sink call is isolated — one sink throwing (or its
 * network round trip failing) can never affect the others or the LLM path.
 */
export class CompositeTraceSink implements LlmTraceSink {
  private readonly log: Logger
  private readonly metrics: OperationalMetrics

  constructor(
    private readonly sinks: LlmTraceSink[],
    observability: TraceSinkObservability = {},
  ) {
    this.log = observability.logger ?? noopLogger
    this.metrics = observability.operationalMetrics ?? noopOperationalMetrics
  }

  /**
   * Run one sink's emit, isolating it. Still best-effort — a sink failing must never block
   * the others or the caller — but no longer SILENT: telemetry completeness was the one
   * property nothing anywhere measured, so a deployment whose collector had been rejecting
   * every batch for a week looked exactly like one with nothing to report.
   */
  private async isolate(sink: LlmTraceSink, op: string, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.metrics.increment('telemetry.export_dropped', { operation: op })
      this.log.warn('trace sink export dropped', {
        scope: 'trace-sink',
        operation: op,
        sink: sink.constructor?.name ?? 'unknown',
        ...describeError(error),
      })
    }
  }

  async recordGeneration(event: LlmGenerationEvent): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        this.isolate(sink, 'recordGeneration', async () => {
          await sink.recordGeneration(event)
        }),
      ),
    )
  }

  async recordToolSpans(context: LlmToolSpanContext, spans: LlmToolSpan[]): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        this.isolate(sink, 'recordToolSpans', async () => {
          await sink.recordToolSpans?.(context, spans)
        }),
      ),
    )
  }

  async forceFlush(): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        this.isolate(sink, 'forceFlush', async () => {
          await sink.forceFlush?.()
        }),
      ),
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        this.isolate(sink, 'shutdown', async () => {
          await sink.shutdown?.()
        }),
      ),
    )
  }
}

/** How a composed sink reports the batches it drops. Both optional; both degrade to silence. */
export interface TraceSinkObservability {
  logger?: Logger
  operationalMetrics?: OperationalMetrics
}

/**
 * Compose zero or more optional sinks into a single one: none ⇒ `undefined` (nothing
 * wired, no external emission), otherwise a {@link CompositeTraceSink} fanning out to all.
 * The one helper every facade uses so the "0/1/many" collapse is identical across runtimes.
 *
 * A SINGLE sink used to be returned verbatim, to skip the wrapper's overhead. That collapse
 * is kept only when there is nothing to report through: once `observability` is supplied, one
 * sink is wrapped like any other, because a single external destination is the COMMON
 * deployment shape and unwrapping it there would leave drop counting absent from exactly the
 * deployments that have telemetry to drop — an absence that reads as "no drops".
 */
export function composeTraceSinks(
  sinks: readonly (LlmTraceSink | undefined)[],
  observability?: TraceSinkObservability,
): LlmTraceSink | undefined {
  const active = sinks.filter((sink): sink is LlmTraceSink => sink != null)
  if (active.length === 0) return undefined
  const reports = observability?.logger || observability?.operationalMetrics
  if (active.length === 1 && !reports) return active[0]
  return new CompositeTraceSink(active, observability ?? {})
}

// ----------------------------------------------------------------------------
// Inline-call observability context
//
// The inline (non-proxied) LLM callers — the requirements reviewer/rework, the
// document planner, the fragment selector, the inline agent — tag each
// `generateText` with their run context so the `InstrumentedModelProvider`
// middleware (in `@cat-factory/agents`) can group the call under its run's trace
// and label it. The tag rides on the AI SDK's `providerOptions` under a private
// namespace, which every model provider ignores — so it's invisible to the model
// and only the instrumentation reads it. Lives in the kernel (dependency-free) so
// any caller layer (orchestration, integrations, agents) can build the tag without
// depending on `@cat-factory/agents`.

/** Namespace used to smuggle observability context through the AI SDK's providerOptions. */
export const INLINE_OBSERVABILITY_NS = 'catFactoryObservability'

/** The run context an inline LLM call carries for the trace sink. */
export interface InlineObservabilityContext {
  agentKind: string
  workspaceId?: string
  executionId?: string
}

/**
 * Build the `providerOptions` fragment a caller spreads into `generateText` to tag an
 * inline call with its run context. Providers ignore unknown provider-option
 * namespaces, so this is invisible to the model — only the instrumentation reads it.
 */
export function catFactoryObservability(
  context: InlineObservabilityContext,
): Record<string, Record<string, string>> {
  return {
    [INLINE_OBSERVABILITY_NS]: {
      agentKind: context.agentKind,
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
    },
  }
}

/** Read the {@link InlineObservabilityContext} back off a model call's params. */
export function readInlineObservabilityContext(params: unknown): InlineObservabilityContext {
  const providerOptions = (params as { providerOptions?: Record<string, unknown> })?.providerOptions
  const raw = providerOptions?.[INLINE_OBSERVABILITY_NS] as Record<string, unknown> | undefined
  const agentKind = typeof raw?.agentKind === 'string' ? raw.agentKind : 'inline'
  const workspaceId = typeof raw?.workspaceId === 'string' ? raw.workspaceId : undefined
  const executionId = typeof raw?.executionId === 'string' ? raw.executionId : undefined
  return { agentKind, workspaceId, executionId }
}

/**
 * Where an inline call's row is FILED when the per-call tag doesn't say: the credential scope
 * the provider was built for. Both halves are optional because both are genuinely absent on
 * some scopes — one built outside a run has no `executionId`, one built outside a workspace
 * (a platform-level call) has no `workspaceId`.
 */
export interface InlineAttributionScope {
  workspaceId?: string
  executionId?: string
}

/** Which workspace + run one inline call's telemetry is filed under, and what to label it. */
export interface InlineAttribution {
  workspaceId: string | null
  executionId: string | null
  agentKind: string
}

/**
 * Resolve which workspace and run an inline call's telemetry belongs to: the call's OWN
 * `catFactoryObservability` tag first, then the credential scope its provider was built for.
 *
 * ONE function because there are now TWO producers of inline rows and the precedence is
 * load-bearing for both: `InstrumentedModelProvider`'s middleware records the call it wrapped,
 * and a model that reports its own per-call telemetry (`reportsOwnLlmCalls` in
 * `@cat-factory/agents`) records from inside the model, where the middleware has stood down. A
 * row filed under a DIFFERENT run than its siblings is worse than an unrecorded one — it is in
 * the store and absent from every run-scoped read (`listByExecution`, a step's rollup,
 * `/api/v1/debug/runs/*`), which reads as a step that spent nothing — so the two producers must
 * not each restate this.
 *
 * The TAG wins where present: a scope is per-provider while a tag is per-call, so a caller that
 * fans one scope out across participants (consensus) has to be able to say so. Absent on both ⇒
 * null, the honest answer for a genuinely un-run-scoped call, never guessed at from anything else.
 */
export function resolveInlineAttribution(
  params: unknown,
  scope: InlineAttributionScope | undefined,
): InlineAttribution {
  const context = readInlineObservabilityContext(params)
  return {
    workspaceId: context.workspaceId ?? scope?.workspaceId ?? null,
    executionId: context.executionId ?? scope?.executionId ?? null,
    agentKind: context.agentKind,
  }
}
