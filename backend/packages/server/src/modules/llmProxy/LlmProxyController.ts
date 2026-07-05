import { Hono } from 'hono'
import { cachedTokensFromUsage, promptCacheParams } from '@cat-factory/agents'
import { isLocalRunner } from '@cat-factory/contracts'
import { fetchLocalRunner } from '@cat-factory/integrations'
import { type ApiKeyProvider, contextWindowFor } from '@cat-factory/kernel'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { makeWaitUntil } from '../../http/waitUntil.js'
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
 * Output-token floor applied to every container-agent call on a `workers-ai` provider
 * (native `@cf/...` and AI-catalog slugs both): `max_tokens = max(asked, this)`.
 *
 * This is the EFFECTIVE per-call output ceiling, not a mere safety net. Production
 * telemetry showed every workers-ai call recording exactly 16384 — Pi does NOT forward
 * its model-entry `maxTokens` (the harness `PI_MAX_OUTPUT_TOKENS`) as the request
 * `max_tokens`, so `asked` is always ≤ this floor and the floor governs. Raising the
 * harness ceiling alone therefore does nothing; this is the value to change. Keep it in
 * step with the harness `PI_MAX_OUTPUT_TOKENS` (32k). A ceiling, not a target — unused
 * tokens are not billed. It is itself capped per-call against the model's context window
 * below: a small-window model (e.g. qwen3-30b-a3b-fp8 at 32K total) does NOT clamp a
 * too-large output request, it rejects the whole call (error 8007 → HTTP 502).
 */
const PI_MIN_OUTPUT_TOKENS = 32_768

/**
 * Chars-per-token used to estimate a prompt's input-token cost from its serialized
 * length when capping the output request against a model's context window. Kept LOW (a
 * dense-JSON ratio) on purpose so the estimate runs HIGH and the cap stays conservative:
 * over-reserving input room only trims output a little, while under-reserving risks the
 * very overflow the cap exists to prevent.
 */
const PROMPT_CHARS_PER_TOKEN = 3

/**
 * Tokens held back from the context window beyond the estimated input — covers role/
 * formatting overhead the char estimate misses and the model's own generation headroom.
 */
const CONTEXT_WINDOW_MARGIN = 512

/**
 * The output-token ceiling for a workers-ai container call: Pi's asked value floored to
 * {@link PI_MIN_OUTPUT_TOKENS}, then capped so input + output fits the model's context
 * window (when the catalog declares one). A small-window model rejects the WHOLE request
 * (Workers AI error 8007 → HTTP 502) when the output request alone fills the window, so we
 * reserve room for the prompt: estimate its input-token cost from the serialized
 * prompt + tool definitions (`inputChars`) and hold that back. The cap only NARROWS the
 * floor; an unknown window or ample room leaves it untouched. Pure + exported for testing.
 */
export function workersAiOutputCeiling(args: {
  asked: number
  contextWindow: number | undefined
  inputChars: number
}): number {
  let ceiling = Math.max(args.asked, PI_MIN_OUTPUT_TOKENS)
  if (args.contextWindow) {
    const estimatedInputTokens = Math.ceil(args.inputChars / PROMPT_CHARS_PER_TOKEN)
    const outputRoom = args.contextWindow - estimatedInputTokens - CONTEXT_WINDOW_MARGIN
    if (outputRoom > 0 && outputRoom < ceiling) ceiling = outputRoom
  }
  return ceiling
}

/** Pull the bearer token from the Authorization header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

export function llmProxyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/v1/chat/completions', async (c) => {
    // Proxy-entry clock: everything from here to the upstream dispatch (and after the
    // response) is transport overhead; the slice spent waiting on the model is the
    // actual execution. The two are split in the observability sink.
    const t0 = Date.now()
    const {
      config,
      spendService,
      gateways,
      llmObservability,
      executionEventPublisher,
      apiKeys,
      localModelEndpoints,
    } = c.get('container')
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

    // Prompt caching: route this conversation's calls to the same cached prefix on
    // providers that support it (keyed on the execution id, stable across the run's
    // turns). A no-op for providers that cache automatically on the prefix or not at
    // all — see `promptCacheParams`.
    Object.assign(payload, promptCacheParams(session.provider, session.executionId))

    const streaming = payload.stream === true
    const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0
    const messageCount = Array.isArray(payload.messages) ? payload.messages.length : 0
    // The EFFECTIVE output ceiling: updated below if the proxy overrides max_tokens
    // (e.g. the Workers AI floor), so the recorded metric reflects what actually
    // applied, not just what the client asked for.
    let requestMaxTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : null
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

    // One id per proxied call, minted here so the SAME id rides both the live
    // `llmCall` activity event and the persisted metric row — the drill-down panel
    // keys its lazy body-load by it, and a live-appended summary row reconciles with
    // the stored row on reload instead of duplicating.
    const callId = `llm_${crypto.randomUUID()}`

    // Per-call observation handling, off the response path: (1) push a COMPACT live
    // activity event (no prompt/response bodies) so an open "Model activity" panel
    // updates in real time, independent of the durable driver — the proxy records
    // calls even while the run's poll loop is evicted; (2) persist the full metric to
    // the observability sink when it is wired. `upstreamMs` is supplied by whichever
    // path made the call; `totalMs` is the proxy's end-to-end time. Both are
    // best-effort and must never break the proxy.
    const observe = (obs: ProxyCallObservation): void => {
      const promptTokens = obs.usage?.prompt_tokens ?? 0
      const completionTokens = obs.usage?.completion_tokens ?? 0
      const cachedPromptTokens = obs.cachedPromptTokens ?? cachedTokensFromUsage(obs.usage)
      const totalMs = Date.now() - t0

      // Live activity event — emitted regardless of whether the persistence sink is
      // wired, so the live view works even on a deployment that does not retain
      // metrics. This fires on EVERY observed outcome, including refusals/errors (spend
      // exhausted, unavailable provider, upstream non-2xx) where no model work ran:
      // surfacing those live (with `ok:false`) is intentional and matches what the sink
      // persists. Best-effort: a publish failure (no subscribers, transient hub error)
      // must not break metering.
      waitUntil(
        Promise.resolve(
          // `?.` on the publisher itself, not just the method: a minimal container
          // (e.g. the harness's real-proxy acceptance test) may omit it, and the live
          // emit is best-effort — a missing publisher must never break metering.
          executionEventPublisher?.llmCallObserved?.(session.workspaceId, {
            id: callId,
            workspaceId: session.workspaceId,
            executionId: session.executionId,
            agentKind: session.agentKind,
            provider: session.provider,
            model: session.model,
            createdAt: Date.now(),
            streaming,
            messageCount,
            toolCount,
            requestMaxTokens,
            promptTokens,
            cachedPromptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            finishReason: obs.finishReason,
            upstreamMs: obs.upstreamMs,
            overheadMs: Math.max(0, totalMs - obs.upstreamMs),
            totalMs,
            ok: obs.ok,
            httpStatus: obs.httpStatus,
            errorMessage: obs.errorMessage,
          }),
        ).catch(() => {}),
      )

      if (!llmObservability) return
      waitUntil(
        llmObservability
          .record({
            id: callId,
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
            cachedPromptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            finishReason: obs.finishReason,
            totalMs,
            upstreamMs: obs.upstreamMs,
            ok: obs.ok,
            httpStatus: obs.httpStatus,
            errorMessage: obs.errorMessage,
            promptText,
            responseText: obs.responseText,
            reasoningText: obs.reasoningText ?? '',
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
    if (
      await spendService.isOverBudget(session.workspaceId, {
        accountId: session.accountId,
        userId: session.userId,
      })
    ) {
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
      const toolsText = Array.isArray(payload.tools) ? JSON.stringify(payload.tools) : ''
      const floored = workersAiOutputCeiling({
        asked,
        contextWindow: contextWindowFor({ provider: session.provider, model: session.model }),
        inputChars: promptText.length + toolsText.length,
      })
      payload.max_tokens = floored
      // Record the ceiling we actually applied, not the (often absent) asked value.
      requestMaxTokens = floored
    }

    // The pooled API key leased for this call (non-binding providers), so usage can be
    // folded back into its rolling-window rotation counters when the call completes.
    let leasedApiKeyId: string | null = null

    const record = (usage: LlmTokenUsage | null): Promise<number> => {
      if (!usage) return Promise.resolve(0)
      const inputTokens = usage.prompt_tokens ?? 0
      const outputTokens = usage.completion_tokens ?? 0
      // Fold usage into the leased key's rotation counters (best-effort, off the meter).
      if (leasedApiKeyId && apiKeys) {
        void apiKeys.recordUsage(leasedApiKeyId, { inputTokens, outputTokens }).catch(() => {})
      }
      return spendService.record({
        workspaceId: session.workspaceId,
        accountId: session.accountId,
        userId: session.userId,
        executionId: session.executionId,
        agentKind: session.agentKind,
        model: `${session.provider}:${session.model}`,
        usage: { inputTokens, outputTokens },
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

    // Resolve the upstream base URL + bearer key. Two paths:
    //  - LOCAL runners (Ollama / LM Studio / …): the endpoint is configured PER USER, so
    //    resolve it by the run INITIATOR (`session.userId`) and use its optional key
    //    directly — NO DB key lease (these runners are keyless by default; a placeholder
    //    bearer is harmless). `leasedApiKeyId` stays undefined so no spend key is attributed.
    //  - Cloud providers: resolve the base URL from the gateway and lease the key from the
    //    DB-backed pool (workspace + account + initiator).
    let baseURL: string
    let apiKey: string
    const localRunner = isLocalRunner(session.provider)
    if (localRunner) {
      const resolved =
        session.userId && localModelEndpoints
          ? await localModelEndpoints.resolve(session.userId, session.provider)
          : null
      if (!resolved) {
        log.error('llm proxy: no local runner endpoint configured for the run initiator')
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: `No local runner '${session.provider}' configured for this run`,
          upstreamMs: 0,
        })
        return c.json(
          { error: { message: `No local runner '${session.provider}' configured for this run` } },
          502,
        )
      }
      baseURL = resolved.baseUrl.replace(/\/+$/, '')
      // Most local runners ignore auth; the SDK/fetch still emit an Authorization header.
      apiKey = resolved.apiKey || 'local'
    } else {
      const upstream = gateways.llmUpstream.resolveOpenAiCompatible(session.provider)
      if (!upstream) {
        log.error('llm proxy: provider is not available (no base URL resolved)')
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
      // Lease the API key for this provider from the DB-backed pool (workspace + owning
      // account + the run initiator), scoped from the signed session claims. Keys are no
      // longer env-baked: an empty pool means the provider is not configured.
      if (!apiKeys) {
        log.error('llm proxy: API-key store is not configured')
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: 'API-key store is not configured',
          upstreamMs: 0,
        })
        return c.json({ error: { message: 'API-key store is not configured' } }, 502)
      }
      try {
        const leased = await apiKeys.lease(
          session.workspaceId,
          session.provider as ApiKeyProvider,
          {
            accountId: session.accountId,
            userId: session.userId,
          },
        )
        leasedApiKeyId = leased.keyId
        apiKey = leased.secret
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ err: message }, 'llm proxy: no API key configured for provider')
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: message,
          upstreamMs: 0,
        })
        return c.json(
          { error: { message: `No API key configured for provider '${session.provider}'` } },
          502,
        )
      }
      baseURL = upstream.baseURL
    }
    if (streaming) {
      payload.stream_options = { include_usage: true }
    }

    // Upstream-dispatch clock: the slice between here and the response is the model's
    // execution; the rest of the proxy's time is transport overhead.
    const dispatchAt = Date.now()
    const upstreamUrl = `${baseURL}/chat/completions`
    const upstreamInit: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
    let upstreamRes: Response
    if (localRunner) {
      // The local-runner base URL is user-supplied and forwarded server-side, so follow
      // redirects manually and re-validate every hop against the SSRF allow-list — a
      // reachable runner must not 302 us into the cloud-metadata endpoint or a public
      // host. Cloud providers use a trusted, hardcoded base URL, so they keep plain fetch.
      try {
        upstreamRes = await fetchLocalRunner(upstreamUrl, upstreamInit)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error({ err: message }, 'llm proxy: local runner request blocked')
        observe({
          usage: null,
          finishReason: null,
          responseText: '',
          ok: false,
          httpStatus: 502,
          errorMessage: message,
          upstreamMs: Date.now() - dispatchAt,
        })
        return c.json({ error: { message } }, 502)
      }
    } else {
      upstreamRes = await fetch(upstreamUrl, upstreamInit)
    }

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
      reasoningText: reasoningTextFromCompletion(json),
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
    message?: {
      content?: string | null
      /** Reasoning trace on a separate channel: DeepSeek-style / OpenRouter-style. */
      reasoning_content?: string | null
      reasoning?: string | null
    }
    finish_reason?: string | null
  }>
}

/** Pull the assistant text out of a buffered completion (empty when tool-only). */
function assistantTextFromCompletion(json: BufferedCompletion): string {
  const content = json.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/**
 * Pull the reasoning/"thinking" trace out of a buffered completion, across the field
 * names OpenAI-compatible providers use (`reasoning_content` on DeepSeek, `reasoning`
 * on OpenRouter and others). Empty for non-reasoning models.
 */
function reasoningTextFromCompletion(json: BufferedCompletion): string {
  const message = json.choices?.[0]?.message
  const reasoning = message?.reasoning_content ?? message?.reasoning
  return typeof reasoning === 'string' ? reasoning : ''
}

/** One OpenAI SSE chunk shape the observation scanner reads. */
interface StreamChunk {
  usage?: LlmTokenUsage | null
  choices?: Array<{
    delta?: {
      content?: string | null
      /** Streamed reasoning deltas (DeepSeek-style / OpenRouter-style). */
      reasoning_content?: string | null
      reasoning?: string | null
    }
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
  let reasoning = ''

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
          const reasoningDelta = choice.delta?.reasoning_content ?? choice.delta?.reasoning
          if (typeof reasoningDelta === 'string') reasoning += reasoningDelta
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
        reasoningText: reasoning,
        ok: true,
        httpStatus: 200,
        errorMessage: null,
        upstreamMs: Date.now() - dispatchAt,
      })
    },
  })
}
