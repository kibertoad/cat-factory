import type { Context } from 'hono'
import { Hono } from 'hono'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import type { LlmTokenUsage, ProxyCallObservation } from '../../runtime/gateways.js'

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
    // Proxy-entry clock: everything from here to the upstream dispatch (and after the
    // response) is transport overhead; the slice spent waiting on the model is the
    // actual execution. The two are split in the observability sink.
    const t0 = Date.now()
    const { config, spendService, gateways, llmObservability } = c.get('container')
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

    // Parse + harden the request: lock the model to the session's, and ask for
    // usage on the final streamed chunk so we can always meter. Parsed before the
    // spend gate so a refusal is still recorded with its prompt/shape for analysis.
    let payload: Record<string, unknown>
    try {
      payload = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: { message: 'Invalid JSON body' } }, 400)
    }
    payload.model = session.model

    const streaming = payload.stream === true
    const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0
    const messageCount = Array.isArray(payload.messages) ? payload.messages.length : 0
    const requestMaxTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : null
    const promptText = JSON.stringify(payload.messages ?? [])

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
    log.info({ streaming, toolCount }, 'llm proxy: forwarding chat completion')

    const waitUntil = makeWaitUntil(c)

    // Observability sink: record one metric per call (full prompt/response, the
    // output-limit headroom and the transport-vs-execution latency split), off the
    // response path. A no-op when the sink is not wired. `upstreamMs` is supplied by
    // whichever path made the call; `totalMs` is the proxy's end-to-end time.
    const observe = (obs: ProxyCallObservation): void => {
      if (!llmObservability) return
      const promptTokens = obs.usage?.prompt_tokens ?? 0
      const completionTokens = obs.usage?.completion_tokens ?? 0
      waitUntil(
        llmObservability
          .record({
            workspaceId: session.workspaceId,
            executionId: session.executionId,
            agentKind: session.agentKind,
            provider: session.provider,
            model: session.model,
            streaming,
            messageCount,
            toolCount,
            requestMaxTokens,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            finishReason: obs.finishReason,
            totalMs: Date.now() - t0,
            upstreamMs: obs.upstreamMs,
            ok: obs.ok,
            httpStatus: obs.httpStatus,
            errorMessage: obs.errorMessage,
            promptText,
            responseText: obs.responseText,
          })
          // Observability must never break the proxy.
          .catch((err) =>
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'llm proxy: failed to record metric',
            ),
          ),
      )
    }

    // Spend gate: refuse once the monthly budget is exhausted, mirroring the
    // engine's pre-step check so a container can't keep spending.
    if (await spendService.isOverBudget()) {
      logger.warn(
        { scope: 'llmProxy', workspaceId: session.workspaceId, executionId: session.executionId },
        'llm proxy: spend budget exhausted — refusing call',
      )
      observe({
        usage: null,
        finishReason: null,
        responseText: '',
        ok: false,
        httpStatus: 402,
        errorMessage: 'Spend budget exhausted',
        upstreamMs: 0,
      })
      return c.json({ error: { message: 'Spend budget exhausted' } }, 402)
    }

    // Give container agents (Pi) generous output room for in-process Workers AI models
    // (which clamp to their large ceilings gracefully). Other providers keep Pi's value
    // to respect their stricter upstream output caps.
    if (session.provider === 'workers-ai') {
      const asked = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0
      payload.max_tokens = Math.max(asked, PI_MIN_OUTPUT_TOKENS)
    }

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

    // Workers AI (and any binding-reached provider) has no external upstream: run it
    // in-process via the facade's gateway. Null means this runtime can't (e.g. Node) →
    // the provider is unavailable.
    if (session.provider === 'workers-ai') {
      // The in-process gateway reports its own observation via `recordMetric` (it
      // owns the model timing). We only record here when the dispatch itself fails.
      const dispatchAt = Date.now()
      const inProcess = gateways.llmUpstream.runInProcess({
        model: session.model,
        payload,
        streaming,
        record,
        recordMetric: observe,
        waitUntil,
        log,
      })
      if (!inProcess) {
        log.error('llm proxy: in-process provider is not available in this runtime')
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: `Provider '${session.provider}' is not available`,
          upstreamMs: 0,
        })
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
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: message,
          upstreamMs: Date.now() - dispatchAt,
        })
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
      observe({
        usage: null,
        finishReason: null,
        responseText: '',
        ok: false,
        httpStatus: 502,
        errorMessage: `Provider '${session.provider}' is not available`,
        upstreamMs: 0,
      })
      return c.json({ error: { message: `Provider '${session.provider}' is not available` } }, 502)
    }
    if (streaming) {
      payload.stream_options = { include_usage: true }
    }

    // Upstream-dispatch clock: the slice between here and the response is the model's
    // execution; the rest of the proxy's time is transport overhead.
    const dispatchAt = Date.now()
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
      observe({
        usage: null,
        finishReason: null,
        responseText: '',
        ok: false,
        httpStatus: upstreamRes.status,
        errorMessage: `Upstream returned ${upstreamRes.status}`,
        upstreamMs: Date.now() - dispatchAt,
      })
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
      })
    }

    if (streaming) {
      // Tee the SSE stream so we can scrape the trailing `usage` chunk + finish
      // reason + assistant text without buffering the response, then meter spend and
      // record the observation (off the response path) once it ends.
      const body = upstreamRes.body.pipeThrough(
        observationStream(dispatchAt, (obs) => {
          waitUntil(record(obs.usage))
          observe(obs)
        }),
      )
      return new Response(body, {
        status: upstreamRes.status,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    // Buffered JSON: read usage, meter, record the observation, and relay verbatim.
    const json = (await upstreamRes.json()) as BufferedCompletion
    const upstreamMs = Date.now() - dispatchAt
    await record(json.usage ?? null)
    observe({
      usage: json.usage ?? null,
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      responseText: assistantTextFromCompletion(json),
      ok: true,
      httpStatus: upstreamRes.status,
      errorMessage: null,
      upstreamMs,
    })
    return c.json(json as Record<string, unknown>)
  })

  return app
}

/** Shape of a buffered OpenAI completion the proxy reads (usage + first choice). */
interface BufferedCompletion {
  usage?: LlmTokenUsage
  choices?: Array<{
    message?: { content?: string | null }
    finish_reason?: string | null
  }>
}

/** Pull the assistant text out of a buffered completion (empty when tool-only). */
function assistantTextFromCompletion(json: BufferedCompletion): string {
  const content = json.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/** One OpenAI SSE chunk shape the observation scanner reads. */
interface StreamChunk {
  usage?: LlmTokenUsage | null
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
}

/**
 * A passthrough TransformStream that scans OpenAI SSE chunks, accumulating the
 * assistant text, the final `usage` and the finish reason, and reports the full
 * observation once the stream ends — so the proxy can meter spend AND record the
 * observability metric without buffering the response. `dispatchAt` anchors the
 * model-execution slice (`upstreamMs` = stream end − dispatch). OpenAI emits usage
 * in the last `data:` event when `stream_options.include_usage` is set.
 *
 * Caveat: for a streamed call `upstreamMs` is measured at `flush`, which fires when
 * the upstream closes after chunks have drained downstream — so a slow consumer can
 * fold some client-drain time into the "model execution" slice. Container readers
 * (Pi) drain fast, so the transport-vs-execution split stays a good approximation;
 * exact per-chunk attribution would need first-byte/last-byte timestamps.
 *
 * Two further limitations are accepted deliberately to keep the response unbuffered:
 * - `responseText` captures the assistant *text* deltas only (not tool-call argument
 *   deltas), matching the buffered path — a tool-only turn records empty text.
 * - `flush` only runs on a clean close, so a stream the upstream *errors* mid-flight
 *   is not recorded here; the error still propagates to the client. (The in-process
 *   Workers-AI path, which owns its generation, does record stream failures.)
 * Recording either would require buffering/teeing the body, which this seam exists to
 * avoid; revisit only if streaming-error observability becomes a real need.
 */
function observationStream(
  dispatchAt: number,
  report: (observation: ProxyCallObservation) => void,
): TransformStream {
  const decoder = new TextDecoder()
  let buffer = ''
  let lastUsage: LlmTokenUsage | null = null
  let finishReason: string | null = null
  let text = ''

  const scan = (input: string) => {
    buffer += input
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data) as StreamChunk
        if (parsed.usage) lastUsage = parsed.usage
        const choice = parsed.choices?.[0]
        if (choice) {
          const delta = choice.delta?.content
          if (typeof delta === 'string') text += delta
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
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
      report({
        usage: lastUsage,
        finishReason,
        responseText: text,
        ok: true,
        httpStatus: 200,
        errorMessage: null,
        upstreamMs: Date.now() - dispatchAt,
      })
    },
  })
}
