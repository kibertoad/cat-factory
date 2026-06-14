import type { Ai } from '@cloudflare/workers-types'
import { type LanguageModel, type ModelMessage, generateText, streamText } from 'ai'
import { Hono } from 'hono'
import { createWorkersAI } from 'workers-ai-provider'
import { resolveOpenAiCompatibleUpstream } from '../../infrastructure/ai/providerEndpoints'
import type { AppEnv } from '../../infrastructure/http/types'
import { ContainerSessionService } from '../../infrastructure/containers/ContainerSessionService'

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
      return c.json({ error: { message: 'LLM proxy is not configured' } }, 503)
    }

    const sessions = new ContainerSessionService({ secret })
    const session = await sessions.verify(bearer(c.req.header('authorization')))
    if (!session) {
      return c.json({ error: { message: 'Invalid or expired session token' } }, 401)
    }

    // Spend gate: refuse once the monthly budget is exhausted, mirroring the
    // engine's pre-step check so a container can't keep spending.
    const { spendService } = c.get('container')
    if (await spendService.isOverBudget()) {
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
    const streaming = payload.stream === true

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
        return c.json({ error: { message: 'Workers AI binding (AI) is not configured' } }, 502)
      }
      return runWorkersAi({
        binding: c.env.AI,
        model: session.model,
        payload,
        streaming,
        record,
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      })
    }

    const upstream = resolveOpenAiCompatibleUpstream(session.provider, c.env)
    if (!upstream) {
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
}

/**
 * Serve a chat completion from Cloudflare Workers AI via the Worker's `AI`
 * binding (no external HTTP, no provider key), translating the OpenAI Chat
 * Completions request/response so Pi sees the same shape as the proxied
 * providers. Honours `stream` and always reports usage so spend is metered.
 */
async function runWorkersAi(args: WorkersAiArgs): Promise<Response> {
  const { binding, model: modelId, payload, streaming, record, waitUntil } = args
  const workersai = createWorkersAI({ binding })
  // workers-ai-provider pins a slightly older @ai-sdk/provider than `ai` v5; the
  // runtime is compatible, so bridge the type-only skew with a cast (as the
  // inline CloudflareModelProvider does).
  const model = workersai(modelId as Parameters<typeof workersai>[0]) as unknown as LanguageModel
  const messages = (Array.isArray(payload.messages) ? payload.messages : []) as ModelMessage[]
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : undefined
  const maxOutputTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined
  const common = { model, messages, temperature, maxOutputTokens }

  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const usageOf = (u: { inputTokens?: number; outputTokens?: number }): OpenAiUsage => ({
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
  })

  if (!streaming) {
    const { text, usage } = await generateText(common)
    const u = usageOf(usage)
    await record(u)
    const body = {
      id,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
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
      controller.enqueue(
        sse(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])),
      )
      for await (const delta of result.textStream) {
        controller.enqueue(
          sse(chunk([{ index: 0, delta: { content: delta }, finish_reason: null }])),
        )
      }
      controller.enqueue(sse(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])))
      const usage = usageOf(await result.usage)
      controller.enqueue(sse(chunk([], usage)))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
      waitUntil(record(usage))
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
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
