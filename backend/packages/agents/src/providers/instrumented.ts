import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import type { LanguageModel } from 'ai'
import type {
  InlineObservabilityContext,
  LlmGenerationEvent,
  LlmTraceSink,
  Logger,
  ModelProvider,
  ModelRef,
  StoreAgentContextGate,
} from '@cat-factory/kernel'
import {
  catFactoryObservability,
  noopLogger,
  readInlineObservabilityContext,
  runBestEffort,
} from '@cat-factory/kernel'

// Re-exported so existing `@cat-factory/agents` consumers keep importing the inline
// observability tag from here; the canonical, dependency-free definition lives in the
// kernel so any caller layer can build the tag without depending on this package.
export { catFactoryObservability }
export type { InlineObservabilityContext }

// Instruments the INLINE (non-proxied) LLM calls so they reach the SAME trace sink as
// the container-agent calls. Container calls go through the LLM proxy, which the
// orchestration `LlmObservabilityService` fans out to the sink; inline calls
// (requirements review/rework, the document planner, the fragment selector, the inline
// agent executor) call the AI SDK directly. This decorator wraps every resolved model
// with an AI SDK middleware that, after each generate, builds the SAME
// {@link LlmGenerationEvent} and calls the SAME `sink.recordGeneration` — so adding the
// inline feeder never means a second sink.
//
// The middleware is transparent: callers keep calling `generateText({ model })`
// unchanged. To group a call under its run's trace and label it, a caller passes
// `providerOptions: catFactoryObservability({ agentKind, workspaceId, executionId })`
// (the kernel helper); absent ⇒ the call still emits, as its own standalone trace
// named `inline`. The instrumentation never changes the model's behaviour and never
// throws into the call.

/** Read token counts defensively across the AI SDK's flat (v2) and nested (v3) usage shapes. */
/**
 * Read the SDK's usage into the four orthogonal classes the trace sink carries: `prompt` is
 * FRESH input only, with the two cache classes beside it, so
 * `prompt + cacheRead + cacheWrite` is the total input.
 *
 * The v3 shape already breaks the input down (`{ total, noCache, cacheRead, cacheWrite }`),
 * so the split is read straight off it rather than re-derived; `noCache` is preferred over
 * `total − read − write` because it is what the provider itself reported, and the subtraction
 * is only the fallback for a model that fills `total` but not `noCache`. The v2/flat shape
 * carries no cache breakdown at all, so both classes are 0 and the flat prompt count is
 * already the whole (uncached) input.
 */
function readUsage(usage: unknown): {
  prompt: number
  cacheRead: number
  cacheWrite: number
  completion: number
  total: number
} {
  const u = usage as Record<string, unknown> | undefined
  if (!u) return { prompt: 0, cacheRead: 0, cacheWrite: 0, completion: 0, total: 0 }
  const inputTokens = u.inputTokens
  const outputTokens = u.outputTokens
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  // v3: nested { total, noCache, cacheRead, cacheWrite }
  if (inputTokens && typeof inputTokens === 'object') {
    const input = inputTokens as {
      total?: number
      noCache?: number
      cacheRead?: number
      cacheWrite?: number
    }
    const cacheRead = num(input.cacheRead)
    const cacheWrite = num(input.cacheWrite)
    const prompt =
      typeof input.noCache === 'number'
        ? input.noCache
        : Math.max(0, num(input.total) - cacheRead - cacheWrite)
    const completion = Number((outputTokens as { total?: number })?.total ?? 0)
    const total =
      typeof u.totalTokens === 'number'
        ? u.totalTokens
        : prompt + cacheRead + cacheWrite + completion
    return { prompt, cacheRead, cacheWrite, completion, total }
  }
  // v2 / legacy flat: no cache breakdown reported.
  const prompt = Number((inputTokens as number) ?? (u.promptTokens as number) ?? 0)
  const completion = Number((outputTokens as number) ?? (u.completionTokens as number) ?? 0)
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : prompt + completion
  return { prompt, cacheRead: 0, cacheWrite: 0, completion, total }
}

/** Extract the assistant text from a generate result, across result shapes. */
function readOutputText(result: unknown): string {
  const r = result as { text?: unknown; content?: unknown }
  if (typeof r?.text === 'string') return r.text
  if (Array.isArray(r?.content)) {
    return r.content
      .filter((part) => (part as { type?: string })?.type === 'text')
      .map((part) => String((part as { text?: unknown }).text ?? ''))
      .join('')
  }
  return ''
}

function readFinishReason(result: unknown): string | null {
  const reason = (result as { finishReason?: unknown })?.finishReason
  return typeof reason === 'string' ? reason : null
}

/**
 * A {@link ModelProvider} that wraps every resolved model so inline LLM calls surface
 * on the trace sink. Build it only when a sink is wired AND the deployment opts in; an
 * unwrapped provider behaves exactly as before.
 */
export class InstrumentedModelProvider implements ModelProvider {
  private readonly inner: ModelProvider
  private readonly traceSink: LlmTraceSink
  private readonly recordPrompts: boolean
  private readonly bodiesEnabled: StoreAgentContextGate
  private readonly now: () => number
  private readonly log: Logger

  constructor(deps: {
    inner: ModelProvider
    traceSink: LlmTraceSink
    /** Honour the same `LLM_RECORD_PROMPTS` switch as the local store; default true. */
    recordPrompts?: boolean
    /**
     * The per-workspace `storeAgentContext` half of the double gate, built by the facade from
     * kernel's `createStoreAgentContextGate` — the SAME factory the proxy path's
     * `LlmObservabilityService` uses.
     *
     * REQUIRED, not optional, and for the reason `CoreDependencies.logger` is: this gate was
     * absent here entirely, so the inline path (judges, consensus, the requirements writer,
     * every inline kind) honoured only the deployment-wide switch and shipped an opted-out
     * workspace's prompt and response bodies to Langfuse/OTel. An optional privacy gate is one
     * a facade can forget, and forgetting it is silent (observability-logging-gaps.md, C2).
     */
    bodiesEnabled: StoreAgentContextGate
    /** Injectable clock (tests); defaults to `Date.now`. */
    now?: () => number
    /** Where a dropped inline export reports itself. Absent ⇒ `noopLogger`. */
    logger?: Logger
  }) {
    this.inner = deps.inner
    this.traceSink = deps.traceSink
    this.recordPrompts = deps.recordPrompts ?? true
    this.bodiesEnabled = deps.bodiesEnabled
    this.now = deps.now ?? (() => Date.now())
    this.log = (deps.logger ?? noopLogger).child({ scope: 'inlineLlmTrace' })
  }

  resolve(ref: ModelRef): LanguageModel {
    const model = this.inner.resolve(ref)
    // wrapLanguageModel only accepts a model instance (not a model-id string). A bare
    // string ref would be unusual for inline kinds, but pass it through untouched. The
    // base resolvers return current-spec (v3) models; the cast bridges the broader
    // `LanguageModel` union to wrapLanguageModel's exact model param.
    if (typeof model === 'string') return model
    return wrapLanguageModel({
      model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
      middleware: this.middlewareFor(ref),
    })
  }

  private middlewareFor(ref: ModelRef): LanguageModelMiddleware {
    return {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        const startedAt = this.now()
        try {
          const result = await doGenerate()
          this.emit(ref, params, result, startedAt, true, null)
          return result
        } catch (err) {
          this.emit(ref, params, undefined, startedAt, false, errorMessage(err))
          throw err
        }
      },
    }
  }

  private emit(
    ref: ModelRef,
    params: unknown,
    result: unknown,
    startedAt: number,
    ok: boolean,
    errMessage: string | null,
  ): void {
    const endedAt = this.now()
    const context = readInlineObservabilityContext(params)
    const usage = readUsage((result as { usage?: unknown })?.usage)
    const workspaceId = context.workspaceId ?? null
    // Best-effort and fully isolated — instrumentation must never break the LLM call.
    // `runBestEffort` covers the synchronous build/dispatch throw as well as the rejection,
    // which is what the `try` around the old `.catch(() => {})` was there for. The workspace
    // gate is read INSIDE it: the read is async (a cached settings lookup) and its failure must
    // not escape into the model call either.
    void runBestEffort(
      this.log,
      'traceSink.recordGeneration',
      async () => {
        // Numeric telemetry always exports; only the BODIES answer to the double gate.
        const recordBodies = this.recordPrompts && (await this.bodiesEnabled(workspaceId))
        const event: LlmGenerationEvent = {
          workspaceId,
          executionId: context.executionId ?? null,
          agentKind: context.agentKind,
          provider: ref.provider,
          model: ref.model,
          startedAt,
          endedAt,
          promptTokens: usage.prompt,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          completionTokens: usage.completion,
          totalTokens: usage.total,
          finishReason: ok ? readFinishReason(result) : null,
          ok,
          errorMessage: errMessage,
          input: recordBodies ? safeJson((params as { prompt?: unknown })?.prompt) : '',
          output: recordBodies && ok ? readOutputText(result) : '',
        }
        await this.traceSink.recordGeneration(event)
      },
      { workspaceId, executionId: context.executionId ?? null, source: 'inline' },
    )
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? [])
  } catch {
    return ''
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
