import type { Context } from 'hono'
import { Hono } from 'hono'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import type { LlmTokenUsage } from '../../runtime/gateways.js'

// The OpenAI Chat Completions-compatible proxy that implementation containers
// point Pi at. It is the seam that keeps provider secrets out of the container:
// the container authenticates with a short-lived, model-locked session token
// (no API key), and the facade injects the real upstream key and forwards the
// request. It is also the single spend-metering point for container runs.
//
// This controller is runtime-neutral: session verification, the spend gate,
// request hardening, the OpenAI-compatible HTTP forward and the streaming metering
// all live here. The runtime-specific bits — resolving an OpenAI-compatible
// upstream (base URL + key) and the optional in-process path for binding-reached
// providers (Cloudflare Workers AI) — are delegated to the `llmUpstream` gateway.

/**
 * Defense-in-depth floor on a container agent's per-call output budget for in-process
 * (Workers AI) models. The primary control is Pi's own model-entry `maxTokens`; this
 * is a safety net so a reasoning model is never truncated mid-`<think>`. A ceiling,
 * not a target — unused tokens are not billed.
 */
const PI_MIN_OUTPUT_TOKENS = 16_384

/** Pull the bearer token from the Authorization header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Schedule post-response work. On the Worker the runtime exposes `executionCtx.waitUntil`
 * (keeps the isolate alive past the response); on Node there is no such context, so we
 * fall back to fire-and-forget (the process is long-lived).
 */
function makeWaitUntil(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  return (p) => {
    try {
      c.executionCtx.waitUntil(p)
    } catch {
      void p.catch(() => {})
    }
  }
}

export function llmProxyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/v1/chat/completions', async (c) => {
    const { config, spendService, gateways } = c.get('container')
    const secret = config.auth.sessionSecret
    if (!secret) {
      logger.error({ scope: 'llmProxy' }, 'llm proxy: session secret not configured')
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

    // Give container agents (Pi) generous output room for in-process Workers AI models
    // (which clamp to their large ceilings gracefully). Other providers keep Pi's value
    // to respect their stricter upstream output caps.
    if (session.provider === 'workers-ai') {
      const asked = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0
      payload.max_tokens = Math.max(asked, PI_MIN_OUTPUT_TOKENS)
    }

    const streaming = payload.stream === true

    // Correlate every proxied call with its run so a bootstrap/execution can be
    // traced end to end. We log the tool count explicitly: an agent (Pi) that gets
    // no tools back can't edit files, so a toolless call is the signature of a no-op.
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

    const record = (usage: LlmTokenUsage | null): Promise<number> => {
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

    const waitUntil = makeWaitUntil(c)

    // Workers AI (and any binding-reached provider) has no external upstream: run it
    // in-process via the facade's gateway. Null means this runtime can't (e.g. Node) →
    // the provider is unavailable.
    if (session.provider === 'workers-ai') {
      const inProcess = gateways.llmUpstream.runInProcess({
        model: session.model,
        payload,
        streaming,
        record,
        waitUntil,
        log,
      })
      if (!inProcess) {
        log.error('llm proxy: in-process provider is not available in this runtime')
        return c.json(
          { error: { message: `Provider '${session.provider}' is not available` } },
          502,
        )
      }
      try {
        return await inProcess
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ err: message }, 'llm proxy: in-process call failed')
        return c.json(
          { error: { message: `In-process call failed for model '${session.model}': ${message}` } },
          502,
        )
      }
    }

    const upstream = gateways.llmUpstream.resolveOpenAiCompatible(session.provider)
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
      const body = upstreamRes.body.pipeThrough(meteringStream((usage) => waitUntil(record(usage))))
      return new Response(body, {
        status: upstreamRes.status,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    // Buffered JSON: read usage, meter, and relay the body verbatim.
    const json = (await upstreamRes.json()) as { usage?: LlmTokenUsage }
    await record(json.usage ?? null)
    return c.json(json as Record<string, unknown>)
  })

  return app
}

/**
 * A passthrough TransformStream that scans OpenAI SSE chunks for the final
 * `usage` object and reports it once the stream ends. OpenAI emits usage in the
 * last `data:` event when `stream_options.include_usage` is set.
 */
function meteringStream(report: (usage: LlmTokenUsage | null) => void): TransformStream {
  const decoder = new TextDecoder()
  let buffer = ''
  let lastUsage: LlmTokenUsage | null = null

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
        const parsed = JSON.parse(data) as { usage?: LlmTokenUsage | null }
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
