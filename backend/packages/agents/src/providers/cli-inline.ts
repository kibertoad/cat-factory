import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'

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
}

/** What the CLI runner returns after one completion. */
export interface InlineCliResult {
  text: string
  /** `length` when the model hit its output cap (the reviewer rejects a truncated doc). */
  finishReason?: 'stop' | 'length'
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** Runs one inline completion through the harness CLI; supplied by the facade. */
export type InlineCliRunner = (request: InlineCliRequest) => Promise<InlineCliResult>

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
  const input = usage?.inputTokens
  const output = usage?.outputTokens
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

export class CliInlineLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(
    readonly provider: string,
    readonly modelId: string,
    private readonly run: InlineCliRunner,
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { system, user } = flattenPrompt(options.prompt)
    const result = await this.run({
      model: this.modelId,
      system,
      prompt: user,
      ...(options.maxOutputTokens != null ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    })
    const reason = result.finishReason ?? 'stop'
    return {
      content: result.text ? [{ type: 'text', text: result.text }] : [],
      finishReason: { unified: reason, raw: reason },
      usage: toUsage(result.usage),
      warnings: [],
    }
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
