import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import type { LanguageModel } from 'ai'
import type { LlmGenerationEvent, LlmTraceSink, ModelProvider, ModelRef } from '@cat-factory/kernel'

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
// `providerOptions: catFactoryObservability({ agentKind, workspaceId, executionId })`;
// absent ⇒ the call still emits, as its own standalone trace named `inline`. The
// instrumentation never changes the model's behaviour and never throws into the call.

/** Namespace used to smuggle observability context through the AI SDK's providerOptions. */
const OBSERVABILITY_NS = 'catFactoryObservability'

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
    [OBSERVABILITY_NS]: {
      agentKind: context.agentKind,
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
    },
  }
}

function readContext(params: unknown): InlineObservabilityContext {
  const providerOptions = (params as { providerOptions?: Record<string, unknown> })?.providerOptions
  const raw = providerOptions?.[OBSERVABILITY_NS] as Record<string, unknown> | undefined
  const agentKind = typeof raw?.agentKind === 'string' ? raw.agentKind : 'inline'
  const workspaceId = typeof raw?.workspaceId === 'string' ? raw.workspaceId : null
  const executionId = typeof raw?.executionId === 'string' ? raw.executionId : null
  return { agentKind, workspaceId: workspaceId ?? undefined, executionId: executionId ?? undefined }
}

/** Read token counts defensively across the AI SDK's flat (v2) and nested (v3) usage shapes. */
function readUsage(usage: unknown): { prompt: number; completion: number; total: number } {
  const u = usage as Record<string, unknown> | undefined
  if (!u) return { prompt: 0, completion: 0, total: 0 }
  const inputTokens = u.inputTokens
  const outputTokens = u.outputTokens
  // v3: nested { total, … }
  if (inputTokens && typeof inputTokens === 'object') {
    const prompt = Number((inputTokens as { total?: number }).total ?? 0)
    const completion = Number((outputTokens as { total?: number })?.total ?? 0)
    const total = typeof u.totalTokens === 'number' ? u.totalTokens : prompt + completion
    return { prompt, completion, total }
  }
  // v2 / legacy flat
  const prompt = Number((inputTokens as number) ?? (u.promptTokens as number) ?? 0)
  const completion = Number((outputTokens as number) ?? (u.completionTokens as number) ?? 0)
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : prompt + completion
  return { prompt, completion, total }
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
  private readonly now: () => number

  constructor(deps: {
    inner: ModelProvider
    traceSink: LlmTraceSink
    /** Honour the same `LLM_RECORD_PROMPTS` switch as the local store; default true. */
    recordPrompts?: boolean
    /** Injectable clock (tests); defaults to `Date.now`. */
    now?: () => number
  }) {
    this.inner = deps.inner
    this.traceSink = deps.traceSink
    this.recordPrompts = deps.recordPrompts ?? true
    this.now = deps.now ?? (() => Date.now())
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
    const context = readContext(params)
    const usage = readUsage((result as { usage?: unknown })?.usage)
    const event: LlmGenerationEvent = {
      workspaceId: context.workspaceId ?? null,
      executionId: context.executionId ?? null,
      agentKind: context.agentKind,
      provider: ref.provider,
      model: ref.model,
      startedAt,
      endedAt,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      totalTokens: usage.total,
      finishReason: ok ? readFinishReason(result) : null,
      ok,
      errorMessage: errMessage,
      input: this.recordPrompts ? safeJson((params as { prompt?: unknown })?.prompt) : '',
      output: this.recordPrompts && ok ? readOutputText(result) : '',
    }
    // Best-effort and fully isolated: the sink itself swallows + logs, but guard the
    // synchronous build/dispatch too so instrumentation can never break the LLM call.
    try {
      void Promise.resolve(this.traceSink.recordGeneration(event)).catch(() => {})
    } catch {
      // ignored
    }
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
