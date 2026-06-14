import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { ContainerSessionService } from '../../infrastructure/containers/ContainerSessionService'
import { resolveOpenAiCompatibleUpstream } from '../../infrastructure/ai/providerEndpoints'

// The OpenAI Chat Completions-compatible proxy that implementation containers
// point Pi at. It is the seam that keeps provider secrets out of the container:
// the container authenticates with a short-lived, model-locked session token
// (no API key), and this Worker injects the real upstream key (qwen / Kimi /
// DeepSeek) and forwards the request. It is also the single spend-metering point
// for container runs — every forwarded call is priced into the same ledger the
// inline executor uses, and the run pauses when the budget is exhausted.

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

    const upstream = resolveOpenAiCompatibleUpstream(session.provider, c.env)
    if (!upstream) {
      return c.json({ error: { message: `Provider '${session.provider}' is not available` } }, 502)
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
