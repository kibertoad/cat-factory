import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type {
  HarnessCallMetric,
  InlineAttributionScope,
  InlineLlmCall,
  InlineLlmCallRecorder,
  Logger,
} from '@cat-factory/kernel'
import { noopLogger, resolveInlineAttribution, runBestEffort } from '@cat-factory/kernel'

// An AI SDK `LanguageModelV3` that runs a one-shot inline completion through a subscription
// HARNESS CLI (Claude Code / Codex) instead of an HTTP provider. It exists so a deployment
// that CAN drive a harness as a host subprocess — local mode with the developer's ambient
// `claude`/`codex` login — can serve the inline LLM steps (requirements reviewer, brainstorm,
// task-estimator, inline document kinds) on a subscription model, exactly as it already runs
// the container steps. The actual subprocess lives in the facade (which owns the OS seam);
// this adapter only maps the AI SDK's call/return shapes onto the injected runner, so the
// inline services keep calling `generateText` unchanged.
//
// Only `doGenerate` is meaningful (the inline callers are all non-streaming `generateText`);
// `doStream` wraps it as a single text part so a streaming caller still works.
//
// TELEMETRY. One `doGenerate` here is not one model call: the CLI runs a whole tool loop
// behind it, so a `doc-researcher` step is routinely 16+ calls over eight minutes. That is why
// this model files its OWN `llm_call_metrics` rows (see {@link reportsOwnLlmCalls}) instead of
// leaving them to the `InstrumentedModelProvider` middleware wrapped around it. The middleware
// can only observe the SDK boundary, which means it could report exactly one row, only once the
// subprocess had exited, and — because a rejection carries no usage — zeros whenever the run was
// killed. Every one of those is a lie of a different kind about the same run.

/** The request handed to the injected CLI runner (already flattened to system + user text). */
export interface InlineCliRequest {
  /** The vendor model id, e.g. `claude-opus-4-8`. */
  model: string
  /** The composed system prompt (role + fragments). */
  system: string
  /** The concrete user prompt. */
  prompt: string
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * Publish ONE model call the CLI made, the moment the runner knows about it.
   *
   * This is the whole live-telemetry seam. A runner reading a narrated stream (Claude Code's
   * `stream-json`) calls this per call AS IT ARRIVES, so a long step's spend is on record while
   * it works rather than only if it finishes; a runner that learns its calls terminally (the
   * container inline job) calls it once per call at the end. A runner whose CLI narrates nothing
   * (`codex exec`) never calls it, and the aggregate row below stays the honest account.
   *
   * Absent when the deployment retains no metrics — a runner must then not bother assembling
   * bodies it has nowhere to send.
   */
  reportCall?: (call: HarnessCallMetric) => void
}

/** What the CLI runner returns after one completion. */
export interface InlineCliResult {
  text: string
  /** `length` when the model hit its output cap (the reviewer rejects a truncated doc). */
  finishReason?: 'stop' | 'length'
  /**
   * The call's token usage, with the input side split into its three orthogonal classes:
   * `inputTokens` is FRESH input only, exclusive of both caches, so the total input is
   * `inputTokens + cacheReadTokens + cacheWriteTokens`. A harness CLI that reports no cache
   * breakdown leaves the two cache fields absent (⇒ 0), which is honest: on that shape the
   * fresh count IS the whole input.
   */
  usage?: {
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    outputTokens?: number
  }
}

/** Runs one inline completion through the harness CLI; supplied by the facade. */
export type InlineCliRunner = (request: InlineCliRequest) => Promise<InlineCliResult>

/**
 * How a {@link CliInlineLanguageModel} files the calls its CLI reports.
 *
 * `scope` is the credential scope the provider was built for, the attribution FALLBACK for a
 * call whose `catFactoryObservability` tag names no run — resolved through the same
 * `resolveInlineAttribution` the middleware uses, so the two producers cannot disagree about
 * where a row belongs.
 */
export interface InlineCliTelemetry {
  recordCall: InlineLlmCallRecorder
  scope?: InlineAttributionScope
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number
  /** Where a dropped row reports itself. Absent ⇒ `noopLogger`. */
  logger?: Logger
}

/**
 * Whether a resolved model files its OWN `llm_call_metrics` rows, and the wrapping
 * instrumentation middleware must therefore stand down.
 *
 * There is EXACTLY ONE row per real model call, and two producers that could write it. The
 * middleware sees the SDK boundary — one lumped row per `generateText`, after the fact. A
 * harness-CLI model sees the CLI's event stream — every call the loop made, as it happens. When
 * both are wired the second is strictly better and the first is a duplicate that would double
 * every token in the step's rollup, so the model says so and the middleware yields.
 *
 * Declared as a marker the middleware READS rather than a flag a facade SETS, because the two
 * are composed by different layers: `wrapResolverWithTelemetry` puts the instrumentation outside
 * the facade wrap that substitutes this model (it has to — see that function), so the outer wrap
 * cannot know what the inner one returned except by asking the model.
 */
export interface SelfReportingLanguageModel {
  readonly reportsOwnLlmCalls: boolean
}

/** Whether `model` reports its own per-call telemetry ({@link SelfReportingLanguageModel}). */
export function reportsOwnLlmCalls(model: unknown): boolean {
  return (model as SelfReportingLanguageModel | null)?.reportsOwnLlmCalls === true
}

/** Serialise a prompt array for the store, never throwing into the call that produced it. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? [])
  } catch {
    return ''
  }
}

/** Flatten the SDK's structured prompt into the plain system + user text a CLI harness takes. */
function flattenPrompt(prompt: LanguageModelV3Prompt): { system: string; user: string } {
  const systemParts: string[] = []
  const userParts: string[] = []
  for (const message of prompt) {
    if (message.role === 'system') {
      systemParts.push(message.content)
    } else if (message.role === 'user') {
      for (const part of message.content) {
        if (part.type === 'text') userParts.push(part.text)
      }
    }
    // assistant/tool turns don't occur for the single-shot inline calls that use this model.
  }
  return { system: systemParts.join('\n\n'), user: userParts.join('\n\n') }
}

function toUsage(usage: InlineCliResult['usage']): LanguageModelV3GenerateResult['usage'] {
  const fresh = usage?.inputTokens
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  const output = usage?.outputTokens
  // `noCache` is the fresh count the runner reported; `total` is the whole input side, so the
  // cache classes are added back onto it. Reporting fresh as the total would make a
  // cache-heavy subscription run look nearly free on the trace sink.
  return {
    inputTokens: {
      total: fresh == null ? undefined : fresh + cacheRead + cacheWrite,
      noCache: fresh,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

export class CliInlineLanguageModel implements LanguageModelV3, SelfReportingLanguageModel {
  readonly specificationVersion = 'v3' as const
  readonly supportedUrls: Record<string, RegExp[]> = {}
  /**
   * True only when a recorder is wired. Without one there is nothing for this model to file, so
   * the middleware must keep doing what it can — a deployment with a trace sink but no metric
   * store still gets its one aggregate generation per step.
   */
  readonly reportsOwnLlmCalls: boolean
  private readonly now: () => number
  private readonly log: Logger

  constructor(
    readonly provider: string,
    readonly modelId: string,
    private readonly run: InlineCliRunner,
    private readonly telemetry?: InlineCliTelemetry,
  ) {
    this.reportsOwnLlmCalls = telemetry !== undefined
    this.now = telemetry?.now ?? (() => Date.now())
    this.log = (telemetry?.logger ?? noopLogger).child({ scope: 'inlineCliTelemetry' })
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { system, user } = flattenPrompt(options.prompt)
    const startedAt = this.now()
    // Per GENERATE, not per model: the ordinal counts this step's calls, and one model instance
    // is resolved per scope and reused across steps.
    let reported = 0
    // Whether ANY reported call carried tokens, which decides if the terminal cumulative figure is
    // still needed — see the aggregate below.
    let reportedTokens = false
    const filed = this.telemetry
      ? (call: HarnessCallMetric): void => {
          if (
            call.inputTokens ||
            call.cacheReadTokens ||
            call.cacheWriteTokens ||
            call.outputTokens
          )
            reportedTokens = true
          this.file(options, call, reported++)
        }
      : undefined
    try {
      const result = await this.run({
        model: this.modelId,
        system,
        prompt: user,
        ...(options.maxOutputTokens != null ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
        ...(filed ? { reportCall: filed } : {}),
      })
      const reason = result.finishReason ?? 'stop'
      // Two cases still need the step-level row, and they are the same case: the per-call channel
      // did not account for the spend. A CLI that narrated nothing (`codex exec`) reported no calls
      // at all; a CLI build that narrates turns but no per-turn `usage` reported calls that are all
      // zeros. Either way the run's cumulative total arrived only on the terminal event, so file it
      // — the container harness's `attributeCumulativeUsage` pins it to the last call for the same
      // reason. When the calls DID carry tokens this row would double every one of them.
      if (this.telemetry && !reportedTokens) {
        this.fileAggregate(options, result, this.now() - startedAt)
      }
      return {
        content: result.text ? [{ type: 'text', text: result.text }] : [],
        finishReason: { unified: reason, raw: reason },
        usage: toUsage(result.usage),
        warnings: [],
      }
    } catch (error) {
      // The calls that COMPLETED are already on record — that is the point of reporting them as
      // they arrive. What is left to state is that the step itself died, and how long it had run:
      // a row of its own, at the next ordinal, carrying no tokens because the call it stands for
      // never reported any. (The runner has already folded what the run spent into the message.)
      if (this.telemetry) {
        this.fileFailure(options, reported, this.now() - startedAt, error)
      }
      throw error
    }
  }

  /**
   * File one call the CLI reported.
   *
   * `durationMs` is 0 and `requestMaxTokens` null for the same reason the container harness's
   * recorder leaves them so: the CLIs expose neither a per-call timing nor the ceiling they
   * actually applied, and a plausible number here (this step's elapsed time, the caller's
   * `maxOutputTokens` the CLI ignores) would be fabricated. `toolCount` is 0 because the request
   * offered none — the tools this loop used are the CLI's own, not ours to claim.
   */
  private file(options: LanguageModelV3CallOptions, call: HarnessCallMetric, turnIndex: number) {
    this.record(options, {
      messageCount: call.messageCount,
      turnIndex,
      promptTokens: call.inputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      completionTokens: call.outputTokens,
      totalTokens:
        call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens + call.outputTokens,
      finishReason: call.finishReason,
      durationMs: 0,
      ok: true,
      errorMessage: null,
      promptText: () => call.promptText,
      responseText: () => call.responseText,
      reasoningText: () => call.reasoningText,
    })
  }

  /**
   * File the ONE row a CLI that reported no calls of its own leaves behind — everything the SDK
   * boundary knows about the whole step, which is what the middleware would have recorded. No
   * `turnIndex`: this is not a turn within a sequence, it IS the step.
   */
  private fileAggregate(
    options: LanguageModelV3CallOptions,
    result: InlineCliResult,
    durationMs: number,
  ) {
    const fresh = result.usage?.inputTokens ?? 0
    const cacheRead = result.usage?.cacheReadTokens ?? 0
    const cacheWrite = result.usage?.cacheWriteTokens ?? 0
    const output = result.usage?.outputTokens ?? 0
    this.record(options, {
      messageCount: options.prompt.length,
      promptTokens: fresh,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      completionTokens: output,
      totalTokens: fresh + cacheRead + cacheWrite + output,
      finishReason: result.finishReason ?? 'stop',
      durationMs,
      ok: true,
      errorMessage: null,
      promptText: () => safeJson(options.prompt),
      responseText: () => result.text,
      reasoningText: () => '',
    })
  }

  /**
   * File the row that says this step DIED, at the ordinal after the last call that completed.
   *
   * Zero tokens is the honest count: it stands for the call that was in flight and never got as
   * far as reporting usage. Everything the run DID spend is already recorded, call by call —
   * before this change a killed step's only row was this one, and its zeros read as a step that
   * had spent nothing at all after burning millions of tokens.
   *
   * `durationMs` is the whole elapsed time here (unlike a per-call row's 0): this row describes
   * the step rather than a turn, and how long it ran before dying is the first thing a reader wants.
   */
  private fileFailure(
    options: LanguageModelV3CallOptions,
    turnIndex: number,
    durationMs: number,
    error: unknown,
  ) {
    this.record(options, {
      messageCount: options.prompt.length,
      turnIndex,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      finishReason: null,
      durationMs,
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      promptText: () => safeJson(options.prompt),
      responseText: () => '',
      reasoningText: () => '',
    })
  }

  /**
   * Hand one row to the recorder: resolve where it is filed, then dispatch off the response path.
   *
   * Best-effort and fully isolated, exactly like the middleware's exit — telemetry must never
   * break the LLM call. A row with no workspace to file under is REPORTED rather than dropped in
   * silence: the facade builds this model per `ModelScope`, which always carries one, so a null
   * here means the wiring changed and this model has stood the middleware down for nothing.
   */
  private record(
    options: LanguageModelV3CallOptions,
    row: Omit<
      InlineLlmCall,
      | 'workspaceId'
      | 'executionId'
      | 'agentKind'
      | 'provider'
      | 'model'
      // Constant across every row this model files — see the two below for why.
      | 'toolCount'
      | 'requestMaxTokens'
    >,
  ): void {
    const telemetry = this.telemetry
    if (!telemetry) return
    const { workspaceId, executionId, agentKind } = resolveInlineAttribution(
      options,
      telemetry.scope,
    )
    if (!workspaceId) {
      this.log.warn('inline CLI call has no workspace to file telemetry under; dropping the row', {
        executionId,
        agentKind,
        model: this.modelId,
      })
      return
    }
    void runBestEffort(
      this.log,
      'llmObservability.recordInlineCliCall',
      () =>
        telemetry.recordCall({
          workspaceId,
          executionId,
          agentKind,
          provider: this.provider,
          model: this.modelId,
          // 0 because the REQUEST offered none: the tools this loop used are the CLI's own, and
          // claiming them here would count an agentic run's toolbox as ours.
          toolCount: 0,
          // The CLI applies its own output ceiling and never reports it; the caller's
          // `maxOutputTokens` is passed along but not honoured by `claude -p`, so echoing it back
          // would state a limit that did not apply.
          requestMaxTokens: null,
          ...row,
        }),
      { workspaceId, executionId, source: 'inline-cli' },
    )
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const generated = await this.doGenerate(options)
    const text = generated.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: generated.warnings })
        const id = '0'
        controller.enqueue({ type: 'text-start', id })
        if (text) controller.enqueue({ type: 'text-delta', id, delta: text })
        controller.enqueue({ type: 'text-end', id })
        controller.enqueue({
          type: 'finish',
          usage: generated.usage,
          finishReason: generated.finishReason,
        })
        controller.close()
      },
    })
    return { stream }
  }
}
