import type { Ai } from '@cloudflare/workers-types'
import {
  type LanguageModel,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  generateText,
  jsonSchema,
  streamText,
  tool,
} from 'ai'
import { Hono } from 'hono'
import { createWorkersAI } from 'workers-ai-provider'
import { resolveOpenAiCompatibleUpstream } from '../../infrastructure/ai/providerEndpoints'
import type { AppEnv } from '../../infrastructure/http/types'
import { ContainerSessionService } from '../../infrastructure/containers/ContainerSessionService'
import { type Logger, logger } from '../../infrastructure/observability/logger'

// The OpenAI Chat Completions-compatible proxy that implementation containers
// point Pi at. It is the seam that keeps provider secrets out of the container:
// the container authenticates with a short-lived, model-locked session token
// (no API key), and this Worker injects the real upstream key (qwen / Kimi /
// DeepSeek) and forwards the request. It is also the single spend-metering point
// for container runs — every forwarded call is priced into the same ledger the
// inline executor uses, and the run pauses when the budget is exhausted.
//
// The `workers-ai` provider is special: there is no external upstream to forward
// to — Cloudflare Workers AI is reached through this Worker's own `AI` binding.
// So for that provider we run the model in-process via the binding and translate
// between the OpenAI Chat Completions shape Pi speaks and the AI SDK, instead of
// proxying an HTTP request. No provider key is involved, which is exactly why the
// container can run on Workers AI with zero extra secrets.

/**
 * Defense-in-depth floor on a container agent's per-call output budget for Workers
 * AI models. The primary control is Pi's own model-entry `maxTokens` (set in the
 * harness's writePiModelsConfig); this is a safety net in case a call still arrives
 * under-provisioned, so a reasoning model is never truncated mid-`<think>`. A
 * ceiling, not a target — unused tokens are not billed — so a generous value is
 * safe. Workers AI clamps to the model's own large limit; stricter upstreams keep
 * Pi's requested value (their hard output caps can be below this).
 */
const PI_MIN_OUTPUT_TOKENS = 16_384

/** Pull the bearer token from the Authorization header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1]! : null
}

export function llmProxyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/v1/chat/completions', async (c) => {
    const secret = c.env.AUTH_SESSION_SECRET
    if (!secret) {
      logger.error({ scope: 'llmProxy' }, 'llm proxy: AUTH_SESSION_SECRET not configured')
      return c.json({ error: { message: 'LLM proxy is not configured' } }, 503)
    }

    const sessions = new ContainerSessionService({ secret })
    const session = await sessions.verify(bearer(c.req.header('authorization')))
    if (!session) {
      logger.warn({ scope: 'llmProxy' }, 'llm proxy: invalid or expired session token')
      return c.json({ error: { message: 'Invalid or expired session token' } }, 401)
    }

    // Spend gate: refuse once the monthly budget is exhausted, mirroring the
    // engine's pre-step check so a container can't keep spending.
    const { spendService } = c.get('container')
    if (await spendService.isOverBudget()) {
      logger.warn(
        { scope: 'llmProxy', workspaceId: session.workspaceId, executionId: session.executionId },
        'llm proxy: spend budget exhausted — refusing call',
      )
      return c.json({ error: { message: 'Spend budget exhausted' } }, 402)
    }

    // Parse + harden the request: lock the model to the session's, and ask for
    // usage on the final streamed chunk so we can always meter.
    let payload: Record<string, unknown>
    try {
      payload = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: { message: 'Invalid JSON body' } }, 400)
    }
    payload.model = session.model

    // Give container agents (Pi) generous output room. A reasoning model like
    // GLM-5.2 spends tokens on `<think>` before the answer + tool calls, so a
    // small per-call cap truncates it mid-reasoning (the agent then never commits
    // edits and the run spins). Pi can under-ask, so floor the budget for Workers
    // AI models — which clamp to their (large) ceilings gracefully. Other
    // providers keep Pi's value to respect their stricter upstream output caps.
    if (session.provider === 'workers-ai') {
      const asked = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0
      payload.max_tokens = Math.max(asked, PI_MIN_OUTPUT_TOKENS)
    }

    const streaming = payload.stream === true

    // Correlate every proxied call with its run so a bootstrap/execution can be
    // traced end to end in `wrangler tail` / Logpush. We log the tool count
    // explicitly: an agent (Pi) that gets no tools back can't edit files, so a
    // toolless call is the signature of a no-op run that still "succeeds".
    const log = logger.child({
      scope: 'llmProxy',
      workspaceId: session.workspaceId,
      executionId: session.executionId,
      agentKind: session.agentKind,
      provider: session.provider,
      model: session.model,
    })
    const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0
    log.info({ streaming, toolCount }, 'llm proxy: forwarding chat completion')

    const record = (usage: OpenAiUsage | null): Promise<number> => {
      if (!usage) return Promise.resolve(0)
      return spendService.record({
        workspaceId: session.workspaceId,
        executionId: session.executionId,
        agentKind: session.agentKind,
        model: `${session.provider}:${session.model}`,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        },
      })
    }

    // Workers AI has no external upstream: run it through the Worker's `AI`
    // binding (no key needed) and translate to/from the OpenAI shape.
    if (session.provider === 'workers-ai') {
      if (!c.env.AI) {
        log.error('llm proxy: Workers AI binding (AI) is not configured')
        return c.json({ error: { message: 'Workers AI binding (AI) is not configured' } }, 502)
      }
      try {
        return await runWorkersAi({
          binding: c.env.AI,
          model: session.model,
          payload,
          streaming,
          record,
          waitUntil: (p) => c.executionCtx.waitUntil(p),
          log,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ err: message }, 'llm proxy: Workers AI call failed')
        return c.json(
          { error: { message: `Workers AI call failed for model '${session.model}': ${message}` } },
          502,
        )
      }
    }

    const upstream = resolveOpenAiCompatibleUpstream(session.provider, c.env)
    if (!upstream) {
      log.error(
        'llm proxy: provider is not available (no upstream resolved — its API key is likely unset)',
      )
      return c.json({ error: { message: `Provider '${session.provider}' is not available` } }, 502)
    }
    if (streaming) {
      payload.stream_options = { include_usage: true }
    }

    const upstreamRes = await fetch(`${upstream.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${upstream.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    // Non-2xx: pass the upstream error straight back, nothing to meter.
    if (!upstreamRes.ok || !upstreamRes.body) {
      log.error({ status: upstreamRes.status }, 'llm proxy: upstream returned non-2xx')
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
      })
    }

    if (streaming) {
      // Tee the SSE stream so we can scrape the trailing `usage` chunk without
      // buffering the response, then meter (off the response path) once it ends.
      const body = upstreamRes.body.pipeThrough(
        meteringStream((usage) => c.executionCtx.waitUntil(record(usage))),
      )
      return new Response(body, {
        status: upstreamRes.status,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    // Buffered JSON: read usage, meter, and relay the body verbatim.
    const json = (await upstreamRes.json()) as { usage?: OpenAiUsage }
    await record(json.usage ?? null)
    return c.json(json as Record<string, unknown>)
  })

  return app
}

interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface WorkersAiArgs {
  binding: Ai
  model: string
  payload: Record<string, unknown>
  streaming: boolean
  record: (usage: OpenAiUsage | null) => Promise<number>
  waitUntil: (p: Promise<unknown>) => void
  log: Logger
}

/**
 * Serve a chat completion from Cloudflare Workers AI via the Worker's `AI`
 * binding (no external HTTP, no provider key), translating the OpenAI Chat
 * Completions request/response so Pi sees the same shape as the proxied
 * providers. Honours `stream` and always reports usage so spend is metered.
 */
async function runWorkersAi(args: WorkersAiArgs): Promise<Response> {
  const { binding, model: modelId, payload, streaming, record, waitUntil, log } = args
  const workersai = createWorkersAI({ binding })
  // workers-ai-provider must implement the same provider spec as `ai`
  // (`@ai-sdk/provider`). A mismatched major emits a model `generateText`/
  // `streamText` reject at runtime ("Unsupported model version … AI SDK N only
  // supports specification version …"); workers-ai-provider@3 matches `ai` v6, so
  // the model is used directly with no cast. Keep these majors in lockstep.
  const model: LanguageModel = workersai(modelId as Parameters<typeof workersai>[0])
  // The AI SDK wants the system prompt in the dedicated `system` option, not as a
  // `role:'system'` entry in `messages` (which it flags as a prompt-injection risk
  // and warns about). Split it out: system text → `system`, the rest → `messages`.
  const system = systemFromMessages(payload.messages)
  const messages = toModelMessages(payload.messages)
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : undefined
  const maxOutputTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined
  // Forward tool definitions so a tool-using agent (Pi) can actually act. The tools
  // are declared WITHOUT an `execute` fn: we want the model to *emit* the calls and
  // relay them back to the caller (Pi runs them in its container), not run them here.
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
  const usageOf = (u: { inputTokens?: number; outputTokens?: number }): OpenAiUsage => ({
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
  })

  if (!streaming) {
    const { text, toolCalls, finishReason, usage } = await generateText(common)
    const u = usageOf(usage)
    const oaToolCalls = toOpenAiToolCalls(toolCalls)
    log.info(
      {
        inputTokens: u.prompt_tokens,
        outputTokens: u.completion_tokens,
        textLength: text.length,
        toolCalls: oaToolCalls.length,
        finishReason,
      },
      'llm proxy: Workers AI completion ok',
    )
    await record(u)
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
      choices: [
        { index: 0, message, finish_reason: toOpenAiFinish(finishReason, oaToolCalls.length > 0) },
      ],
      usage: { ...u, total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) },
    }
    return Response.json(body)
  }

  // Streaming: emit OpenAI `chat.completion.chunk` SSE events, then a trailing
  // usage-only chunk (matching `stream_options.include_usage`) and `[DONE]`.
  const result = streamText(common)
  const encoder = new TextEncoder()
  const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
  const chunk = (choices: unknown[], usage?: OpenAiUsage) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices,
    ...(usage
      ? {
          usage: {
            ...usage,
            total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          },
        }
      : {}),
  })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Errors raised here (model unavailable, AI binding failure) happen AFTER the
      // Response has been returned, so the controller's try/catch can't see them —
      // log + error the stream so the failure is visible instead of a silent hang.
      try {
        controller.enqueue(
          sse(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])),
        )
        let textLength = 0
        for await (const delta of result.textStream) {
          textLength += delta.length
          controller.enqueue(
            sse(chunk([{ index: 0, delta: { content: delta }, finish_reason: null }])),
          )
        }
        // After the text stream drains, the tool calls (if any) are resolved. We
        // relay them in a single delta with complete `arguments` — valid OpenAI
        // streaming shape, and incremental arg fragments buy a tool-runner nothing.
        const oaToolCalls = toOpenAiToolCalls(await result.toolCalls)
        if (oaToolCalls.length > 0) {
          controller.enqueue(
            sse(chunk([{ index: 0, delta: { tool_calls: oaToolCalls }, finish_reason: null }])),
          )
        }
        const finishReason = toOpenAiFinish(await result.finishReason, oaToolCalls.length > 0)
        controller.enqueue(sse(chunk([{ index: 0, delta: {}, finish_reason: finishReason }])))
        const usage = usageOf(await result.usage)
        log.info(
          {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            textLength,
            toolCalls: oaToolCalls.length,
            finishReason,
          },
          'llm proxy: Workers AI stream ok',
        )
        controller.enqueue(sse(chunk([], usage)))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        waitUntil(record(usage))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ err: message, model: modelId }, 'llm proxy: Workers AI stream failed')
        controller.error(err)
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
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
 * Convert OpenAI chat messages to AI SDK `ModelMessage`s. Crucially this handles
 * the tool round-trip the old blanket cast silently broke: an assistant message's
 * `tool_calls` become `tool-call` content parts, and a `tool` message becomes a
 * `tool-result` (its tool name recovered by id from the matching assistant call,
 * since OpenAI tool messages omit it). Without this, every turn after the first
 * tool call would be malformed and the agent could never make progress.
 */
/**
 * Concatenate every `role:'system'` message's text (in order) so it can be passed
 * via the AI SDK's `system` option rather than inlined into `messages` — which the
 * SDK warns is a prompt-injection risk. Returns undefined when there is no system
 * content, so plain chats pass no empty `system`.
 */
function systemFromMessages(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const parts = raw
    .filter((m): m is Record<string, unknown> => isObject(m) && m.role === 'system')
    .map((m) => contentText(m.content))
    .filter((t) => t.length > 0)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

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
      // System content is hoisted to the `system` option (see systemFromMessages),
      // so it is intentionally dropped from the message list here.
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
 * model emits the call and we relay it to the caller (which runs it). Returns
 * undefined when there are no usable function tools, leaving plain chat untouched.
 */
function toAiSdkTools(raw: unknown): ToolSet | undefined {
  if (!Array.isArray(raw)) return undefined
  const tools: Record<string, ReturnType<typeof tool>> = {}
  for (const entry of raw) {
    if (!isObject(entry)) continue
    const fn = isObject(entry.function) ? entry.function : undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    const parameters = isObject(fn?.parameters)
      ? fn.parameters
      : { type: 'object', properties: {} }
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

/**
 * A passthrough TransformStream that scans OpenAI SSE chunks for the final
 * `usage` object and reports it once the stream ends. OpenAI emits usage in the
 * last `data:` event when `stream_options.include_usage` is set.
 */
function meteringStream(report: (usage: OpenAiUsage | null) => void): TransformStream {
  const decoder = new TextDecoder()
  let buffer = ''
  let lastUsage: OpenAiUsage | null = null

  const scan = (text: string) => {
    buffer += text
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as { usage?: OpenAiUsage | null }
        if (parsed.usage) lastUsage = parsed.usage
      } catch {
        // Partial/non-JSON keep-alive line; ignore.
      }
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      scan(decoder.decode(chunk, { stream: true }))
      controller.enqueue(chunk)
    },
    flush() {
      scan(decoder.decode())
      report(lastUsage)
    },
  })
}
