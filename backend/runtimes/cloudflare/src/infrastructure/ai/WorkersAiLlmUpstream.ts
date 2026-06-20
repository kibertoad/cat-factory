import type {
  LlmInProcessRequest,
  LlmTokenUsage,
  LlmUpstream,
  LlmUpstreamEndpoint,
} from '@cat-factory/server'
import type { Ai } from '@cloudflare/workers-types'
import {
  type LanguageModel,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  generateText,
  jsonSchema,
  tool,
} from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { openai as openAiGatewayPlugin } from 'workers-ai-provider/openai'
import type { Env } from '../env'
import { resolveOpenAiCompatibleUpstream } from './providerEndpoints'

// The Worker's LLM-upstream gateway: resolves OpenAI-compatible providers from `env`
// keys, and serves the `workers-ai` provider in-process via the Cloudflare `AI`
// binding — translating between the OpenAI Chat Completions shape Pi speaks and the
// AI SDK. A Node facade would resolve providers over HTTP and have no in-process path
// (its runInProcess returns null), forwarding `workers-ai` is therefore unavailable.

export class WorkersAiLlmUpstream implements LlmUpstream {
  constructor(private readonly env: Env) {}

  resolveOpenAiCompatible(provider: string): LlmUpstreamEndpoint | null {
    return resolveOpenAiCompatibleUpstream(provider, this.env)
  }

  runInProcess(request: LlmInProcessRequest): Promise<Response> | null {
    if (!this.env.AI) return null
    return runWorkersAi({ binding: this.env.AI, ...request })
  }
}

interface WorkersAiArgs extends LlmInProcessRequest {
  binding: Ai
}

/**
 * Serve a chat completion from Cloudflare Workers AI via the `AI` binding (no
 * external HTTP, no provider key), translating the OpenAI Chat Completions
 * request/response so Pi sees the same shape as the proxied providers. Honours
 * `stream` and always reports usage so spend is metered.
 */
async function runWorkersAi(args: WorkersAiArgs): Promise<Response> {
  const { binding, model: modelId, payload, streaming, record, recordMetric, log } = args
  // Model-execution clock for the observability split: the in-process work the proxy
  // attributes to the model (everything else it does is transport overhead).
  const upstreamStart = Date.now()
  // `providers: [openai]` lets a `<provider>/<model>` AI Gateway catalog slug (e.g.
  // `deepseek/deepseek-v4-pro`, served via Fireworks) route through the account's AI
  // Gateway delegate; a `@cf/...` Workers AI id is unaffected and still runs in
  // process on the binding. The catalog route uses the account's `"default"` gateway
  // unless an id is set; it requires that gateway to exist with catalog billing on.
  const workersai = createWorkersAI({ binding, providers: [openAiGatewayPlugin] })
  // workers-ai-provider must implement the same provider spec as `ai`
  // (`@ai-sdk/provider`); workers-ai-provider@3 matches `ai` v6, so the model is used
  // directly with no cast. Keep these majors in lockstep.
  const model: LanguageModel = workersai(modelId as Parameters<typeof workersai>[0])
  // The AI SDK wants the system prompt in the dedicated `system` option, not as a
  // `role:'system'` entry in `messages`. Split it out: system text → `system`.
  const system = systemFromMessages(payload.messages)
  const messages = toModelMessages(payload.messages)
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : undefined
  const maxOutputTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined
  // Forward tool definitions so a tool-using agent (Pi) can act. The tools are
  // declared WITHOUT an `execute` fn: the model emits the calls and we relay them.
  const tools = toAiSdkTools(payload.tools)
  const toolChoice = tools ? toToolChoice(payload.tool_choice) : undefined
  const common = {
    model,
    messages,
    ...(system ? { system } : {}),
    temperature,
    maxOutputTokens,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
  }

  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const usageOf = (u: { inputTokens?: number; outputTokens?: number }): LlmTokenUsage => ({
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
  })

  // Both the buffered and the streaming response are built from ONE `generateText`
  // (non-streaming `doGenerate`) call — we deliberately do NOT use
  // `streamText`/`result.textStream` here.
  //
  // Why: production telemetry (an `@cf/qwen/qwen3-*` reasoning model, `stream:true`)
  // showed the streamed reply arriving with every token duplicated
  // (`serviceservice…`), which fails every downstream JSON parse
  // (requirements/blueprint/merger). The metrics localise the fault precisely: the
  // recorded text was ~2× the reported `completion_tokens`, so the MODEL emitted each
  // token once and the duplication happened during streamed-delta assembly — not in
  // generation, not truncation, and not our SSE encoding (`fullText` was accumulated
  // one `+= delta` per chunk). The exact component in the streaming path that doubles
  // (the AI SDK, the workers-ai-provider stream decode, or the binding's raw SSE for
  // this reasoning model) is NOT pinned down, and no upstream issue confirms it. The
  // buffered path sidesteps the entire streamed-delta assembly, so it is robust
  // regardless of which one is at fault. When the caller asked to stream we replay the
  // single generation as one content chunk; Pi (and any OpenAI client) concatenates
  // deltas, so a one-shot chunk is equivalent — the harness reads the final message,
  // and live progress comes from the todo tool, not token streaming.
  const { text, toolCalls, finishReason: rawFinish, usage } = await generateText(common)
  const u = usageOf(usage)
  const oaToolCalls = toOpenAiToolCalls(toolCalls)
  const finishReason = toOpenAiFinish(rawFinish, oaToolCalls.length > 0)
  log.info(
    {
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      textLength: text.length,
      toolCalls: oaToolCalls.length,
      finishReason,
      streaming,
    },
    'llm proxy: Workers AI completion ok',
  )
  await record(u)
  recordMetric?.({
    usage: u,
    finishReason,
    responseText: text,
    ok: true,
    httpStatus: null,
    errorMessage: null,
    upstreamMs: Date.now() - upstreamStart,
  })

  if (!streaming) {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: text.length > 0 ? text : null,
    }
    if (oaToolCalls.length > 0) message.tool_calls = oaToolCalls
    const body = {
      id,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { ...u, total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) },
    }
    return Response.json(body)
  }

  // Streaming: replay the (single, authoritative) generation as OpenAI
  // `chat.completion.chunk` SSE events (see `buildStreamChunks`), then `[DONE]`.
  const encoder = new TextEncoder()
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
  const chunks = buildStreamChunks(
    { id, created, model: modelId },
    { text, toolCalls: oaToolCalls, finishReason, usage: u },
  )
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(sse(c))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Build the ordered OpenAI `chat.completion.chunk` payloads for a single, completed
 * generation, replayed as a stream: a role chunk, ONE content chunk (only when there
 * is text — never per-token, which is the doubling regression this guards against),
 * the tool-call chunk (if any), the finish chunk, then a trailing usage-only chunk
 * (matching `stream_options.include_usage`). The `[DONE]` sentinel is appended by the
 * caller. Pure + synchronous so the streamed shape can be unit-tested without the
 * `AI` binding or `generateText`.
 */
export function buildStreamChunks(
  meta: { id: string; created: number; model: string },
  gen: {
    text: string
    toolCalls: Array<Record<string, unknown>>
    finishReason: string
    usage: LlmTokenUsage
  },
): Array<Record<string, unknown>> {
  const chunk = (choices: unknown[], usageChunk?: LlmTokenUsage) => ({
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices,
    ...(usageChunk
      ? {
          usage: {
            ...usageChunk,
            total_tokens: (usageChunk.prompt_tokens ?? 0) + (usageChunk.completion_tokens ?? 0),
          },
        }
      : {}),
  })

  const chunks: Array<Record<string, unknown>> = [
    chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]),
  ]
  if (gen.text.length > 0) {
    chunks.push(chunk([{ index: 0, delta: { content: gen.text }, finish_reason: null }]))
  }
  if (gen.toolCalls.length > 0) {
    chunks.push(chunk([{ index: 0, delta: { tool_calls: gen.toolCalls }, finish_reason: null }]))
  }
  chunks.push(chunk([{ index: 0, delta: {}, finish_reason: gen.finishReason }]))
  chunks.push(chunk([], gen.usage))
  return chunks
}

// ---- OpenAI ⇄ AI SDK translation helpers (Workers AI in-process path) -------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Flatten OpenAI message content (string, or a text/parts array) to plain text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

type AiUserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; image: string }>

/** OpenAI user content → AI SDK user content (text + image-url parts). */
function toUserContent(content: unknown): AiUserContent {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!isObject(part)) return undefined
        if (part.type === 'text' && typeof part.text === 'string') {
          return { type: 'text' as const, text: part.text }
        }
        if (
          part.type === 'image_url' &&
          isObject(part.image_url) &&
          typeof part.image_url.url === 'string'
        ) {
          return { type: 'image' as const, image: part.image_url.url }
        }
        return undefined
      })
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
    if (parts.length > 0) return parts
  }
  return ''
}

function safeParseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return isObject(raw) ? raw : {}
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Concatenate every `role:'system'` message's text (in order) so it can be passed
 * via the AI SDK's `system` option rather than inlined into `messages`. Returns
 * undefined when there is no system content.
 */
function systemFromMessages(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const parts = raw
    .filter((m): m is Record<string, unknown> => isObject(m) && m.role === 'system')
    .map((m) => contentText(m.content))
    .filter((t) => t.length > 0)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/**
 * Convert OpenAI chat messages to AI SDK `ModelMessage`s, handling the tool
 * round-trip: an assistant message's `tool_calls` become `tool-call` content parts,
 * and a `tool` message becomes a `tool-result` (its tool name recovered by id from
 * the matching assistant call, since OpenAI tool messages omit it).
 */
function toModelMessages(raw: unknown): ModelMessage[] {
  if (!Array.isArray(raw)) return []
  const toolNameById = new Map<string, string>()
  for (const m of raw) {
    if (isObject(m) && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (
          isObject(tc) &&
          typeof tc.id === 'string' &&
          isObject(tc.function) &&
          typeof tc.function.name === 'string'
        ) {
          toolNameById.set(tc.id, tc.function.name)
        }
      }
    }
  }

  const out: ModelMessage[] = []
  for (const m of raw) {
    if (!isObject(m)) continue
    if (m.role === 'system') {
      // System content is hoisted to the `system` option (see systemFromMessages).
      continue
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: toUserContent(m.content) } as ModelMessage)
    } else if (m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = []
      const text = contentText(m.content)
      if (text) parts.push({ type: 'text', text })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!isObject(tc) || !isObject(tc.function) || typeof tc.function.name !== 'string') {
            continue
          }
          parts.push({
            type: 'tool-call',
            toolCallId: typeof tc.id === 'string' ? tc.id : '',
            toolName: tc.function.name,
            input: safeParseArgs(tc.function.arguments),
          })
        }
      }
      out.push({ role: 'assistant', content: parts.length > 0 ? parts : text } as ModelMessage)
    } else if (m.role === 'tool') {
      const toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: toolNameById.get(toolCallId) ?? 'tool',
            output: { type: 'text', value: contentText(m.content) },
          },
        ],
      } as ModelMessage)
    }
  }
  return out
}

/**
 * OpenAI `tools` → AI SDK client-side tools, declared WITHOUT `execute` so the
 * model emits the call and we relay it to the caller. Returns undefined when there
 * are no usable function tools, leaving plain chat untouched.
 */
function toAiSdkTools(raw: unknown): ToolSet | undefined {
  if (!Array.isArray(raw)) return undefined
  const tools: Record<string, ReturnType<typeof tool>> = {}
  for (const entry of raw) {
    if (!isObject(entry)) continue
    const fn = isObject(entry.function) ? entry.function : undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    const parameters = isObject(fn?.parameters) ? fn.parameters : { type: 'object', properties: {} }
    tools[name] = tool({
      description: typeof fn?.description === 'string' ? fn.description : undefined,
      inputSchema: jsonSchema(parameters as Parameters<typeof jsonSchema>[0]),
    })
  }
  return Object.keys(tools).length > 0 ? (tools as ToolSet) : undefined
}

/** OpenAI `tool_choice` → AI SDK `toolChoice`. */
function toToolChoice(raw: unknown): ToolChoice<ToolSet> | undefined {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw
  if (
    isObject(raw) &&
    raw.type === 'function' &&
    isObject(raw.function) &&
    typeof raw.function.name === 'string'
  ) {
    return { type: 'tool', toolName: raw.function.name }
  }
  return undefined
}

/** AI SDK tool calls → OpenAI `tool_calls` (complete `arguments` JSON strings). */
function toOpenAiToolCalls(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
): Array<Record<string, unknown>> {
  return calls.map((tc, index) => ({
    index,
    id: tc.toolCallId,
    type: 'function',
    function: {
      name: tc.toolName,
      arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
    },
  }))
}

/** AI SDK finish reason → OpenAI `finish_reason`. */
function toOpenAiFinish(reason: string, hasToolCalls: boolean): string {
  if (hasToolCalls || reason === 'tool-calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  if (reason === 'content-filter') return 'content_filter'
  return 'stop'
}
