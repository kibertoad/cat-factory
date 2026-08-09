import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  type InputTokenClasses,
  promptCacheParams,
  readInputTokenClasses,
} from '@cat-factory/agents'
import { isLocalRunner } from '@cat-factory/contracts'
import {
  type ApiKeyProvider,
  contextWindowFor,
  normalizeCallPhase,
  redactImagePayloads,
  runBestEffort,
} from '@cat-factory/kernel'
import { openAiCompatibleBaseUrlError } from '../../agents/providerErrors.js'
import {
  type ContainerSession,
  ContainerSessionService,
} from '../../containers/ContainerSessionService.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'
import { makeWaitUntil } from '../../http/waitUntil.js'
import { logger } from '../../observability/logger.js'
import type {
  LlmTokenUsage,
  ProxyCallObservation,
  RuntimeGateways,
} from '../../runtime/gateways.js'

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

/**
 * How much text this request is actually SENDING: the messages plus the tool definitions, which is
 * what {@link workersAiOutputCeiling} reserves window room for.
 *
 * Measured off the payload being forwarded, never off the redacted copy the telemetry records.
 * Those two used to be one string, which quietly made a RECORDING decision into a correctness one:
 * an OpenAI-shape multimodal turn carries its picture inline as a `data:` URL, describing it
 * instead of copying it shrinks the measurement by the whole size of the picture, and the cap then
 * under-reserves input room by exactly that much. Under-reserving is the one direction this
 * estimate must never err in: over-reserving trims output a little, while under-reserving invites
 * the context overflow the reservation exists to prevent.
 *
 * Exported for the regression test, which is the only way to pin the coupling: both halves are
 * plausible-looking strings, so nothing else distinguishes them.
 */
export function forwardedInputChars(payload: Record<string, unknown>): number {
  const messagesText = Array.isArray(payload.messages) ? JSON.stringify(payload.messages) : ''
  const toolsText = Array.isArray(payload.tools) ? JSON.stringify(payload.tools) : ''
  return messagesText.length + toolsText.length
}

/** Pull the bearer token from the Authorization header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

/**
 * Apply the workers-ai output-token ceiling to `payload` in place and return the `max_tokens`
 * value we actually applied (so the recorded metric reflects the effective ceiling, not the
 * often-absent asked value). A no-op that returns `current` for every other provider.
 *
 * Give container agents (Pi) generous output room for in-process Workers AI models (which clamp
 * to their large ceilings gracefully). Other providers keep Pi's value to respect their stricter
 * upstream output caps.
 */
function applyWorkersAiCeiling(
  session: ContainerSession,
  payload: Record<string, unknown>,
  current: number | null,
): number | null {
  if (session.provider !== 'workers-ai') return current
  const asked = typeof payload.max_tokens === 'number' ? payload.max_tokens : 0
  const floored = workersAiOutputCeiling({
    asked,
    contextWindow: contextWindowFor({ provider: session.provider, model: session.model }),
    // Measured past the provider check, so no other provider pays for the serialization.
    inputChars: forwardedInputChars(payload),
  })
  payload.max_tokens = floored
  // Record the ceiling we actually applied, not the (often absent) asked value.
  return floored
}

/**
 * The per-call state a proxied chat completion threads through its dispatch helpers: the verified
 * session, the hardened payload, and the two closures the handler owns — `observe` (meter + emit
 * live activity) and `record` (fold usage into spend + key rotation) — which stay bound to the
 * handler's mutable `requestMaxTokens` / `leasedApiKeyId`. Bundled into one object so the helpers
 * stay within the repo's parameter budget.
 */
interface ProxyCallContext {
  session: ContainerSession
  payload: Record<string, unknown>
  streaming: boolean
  promptText: string
  log: typeof logger
  gateways: RuntimeGateways
  apiKeys: ServerContainer['apiKeys']
  localModelEndpoints: ServerContainer['localModelEndpoints']
  waitUntil: (task: Promise<unknown>) => void
  observe: (obs: ProxyCallObservation) => void
  /**
   * Meter this call into the spend ledger. `classes` carries the input split when the
   * dispatch path already reconciled it (the streaming scraper does, off the same
   * observation the metric is built from); omitted, the meter re-reads it from `usage`.
   */
  record: (usage: LlmTokenUsage | null, classes?: InputTokenClasses) => Promise<number>
}

/** A resolved OpenAI-compatible upstream (the call URL + bearer key + optional leased pool key). */
interface UpstreamTarget {
  /**
   * The fully composed `/chat/completions` URL, not a base to append to. A locally-run
   * model's base URL is USER-supplied, and appending to a string cannot state that the
   * endpoint path is still ours (a base carrying `?`/`#` swallows the suffix), so the local
   * branch composes it through the policy's `runnerRequestUrl` and there is no base left
   * here for a later edit to concatenate onto.
   */
  upstreamUrl: string
  apiKey: string
  leasedApiKeyId: string | null
  /**
   * Present only for a locally-run model: the endpoint service's policy-bound transport
   * (`LocalModelEndpointService.fetchRunner`), which re-validates the SSRF allow-list on
   * every redirect hop under the deployment's loopback/LAN policy. Bound where the
   * endpoint was resolved, because that is the one place the service is known to exist.
   * Cloud providers use a trusted, hardcoded base URL and keep plain `fetch`.
   */
  fetchRunner: ((url: string, init: RequestInit) => Promise<Response>) | null
}

/**
 * Workers AI (and any binding-reached provider) has no external upstream: run it in-process via
 * the facade's gateway, which owns the model timing and reports its own observation via
 * `recordMetric`. We only observe here when the dispatch itself is unavailable or throws.
 */
async function dispatchInProcess(c: Context<AppEnv>, ctx: ProxyCallContext): Promise<Response> {
  const { session, payload, streaming, gateways, log, observe, record, waitUntil } = ctx
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
      {
        error: {
          code: 'upstream_unavailable',
          message: `Provider '${session.provider}' is not available`,
        },
      },
      502,
    )
  }
  try {
    return await inProcess
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('llm proxy: in-process call failed', { err: message })
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
      {
        error: {
          code: 'upstream_error',
          message: `In-process call failed for model '${session.model}': ${message}`,
        },
      },
      502,
    )
  }
}

/**
 * Resolve the upstream base URL + bearer key. Two paths:
 *  - LOCAL runners (Ollama / LM Studio / …): the endpoint is configured PER USER, so resolve it
 *    by the run INITIATOR (`session.userId`) and use its optional key directly — NO DB key lease
 *    (these runners are keyless by default; a placeholder bearer is harmless). `leasedApiKeyId`
 *    stays null so no spend key is attributed.
 *  - Cloud providers: resolve the base URL from the gateway and lease the key from the DB-backed
 *    pool (workspace + account + initiator).
 *
 * Returns a ready-to-return failure `Response` (already observed) when the provider is
 * unavailable / the key store is missing / no key could be leased.
 */
async function resolveUpstreamTarget(
  c: Context<AppEnv>,
  ctx: ProxyCallContext,
): Promise<UpstreamTarget | { failure: Response }> {
  const { session, gateways, apiKeys, localModelEndpoints, log, observe } = ctx
  const localRunner = isLocalRunner(session.provider)
  if (localRunner) {
    const endpoints = localModelEndpoints
    const resolved =
      session.userId && endpoints ? await endpoints.resolve(session.userId, session.provider) : null
    if (!resolved || !endpoints) {
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
      return {
        failure: c.json(
          {
            error: {
              code: 'upstream_unavailable',
              message: `No local runner '${session.provider}' configured for this run`,
            },
          },
          502,
        ),
      }
    }
    // Compose under the deployment's runner-URL policy rather than concatenating: a row
    // written before the policy narrowed, or one whose base URL would discard the endpoint
    // path, is refused HERE instead of reaching the forward.
    const composed = endpoints.endpointUrl(resolved.baseUrl, '/chat/completions')
    if ('refusal' in composed) {
      log.error('llm proxy: local runner endpoint is refused by this deployment policy', {
        reason: composed.refusal.reason,
      })
      observe({
        usage: null,
        finishReason: null,
        responseText: '',
        ok: false,
        httpStatus: 502,
        errorMessage: composed.refusal.message,
        upstreamMs: 0,
      })
      return {
        failure: c.json(
          { error: { code: 'upstream_unavailable', message: composed.refusal.message } },
          502,
        ),
      }
    }
    // Most local runners ignore auth; the SDK/fetch still emit an Authorization header.
    return {
      upstreamUrl: composed.url,
      apiKey: resolved.apiKey || 'local',
      leasedApiKeyId: null,
      fetchRunner: (url, init) => endpoints.fetchRunner(url, init),
    }
  }
  const upstream = gateways.llmUpstream.resolveOpenAiCompatible(session.provider)
  if (!upstream) {
    log.error('llm proxy: provider is not available (no base URL resolved)')
    const message = openAiCompatibleBaseUrlError(session.provider)
    observe({
      usage: null,
      finishReason: null,
      responseText: '',
      ok: false,
      httpStatus: 502,
      errorMessage: message,
      upstreamMs: 0,
    })
    // The raw exception text from an upstream/SDK call is NOT wire-safe: a fetch or SDK
    // error routinely echoes the request URL (with its query) or an auth header back in its
    // own message, and this response crosses out of the deployment. The cause is already
    // logged above and recorded on the call metric — both of which are scrubbed sinks the
    // operator can read — so the wire gets the generic framing instead.
    return {
      failure: c.json(
        { error: { code: 'upstream_error', message: 'Upstream provider request failed' } },
        502,
      ),
    }
  }
  // Lease the API key for this provider from the DB-backed pool (workspace + owning account + the
  // run initiator), scoped from the signed session claims. Keys are no longer env-baked: an empty
  // pool means the provider is not configured.
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
    return {
      failure: c.json(
        { error: { code: 'unavailable', message: 'API-key store is not configured' } },
        502,
      ),
    }
  }
  try {
    const leased = await apiKeys.lease(session.workspaceId, session.provider as ApiKeyProvider, {
      accountId: session.accountId,
      userId: session.userId,
    })
    return {
      // A cloud provider's base URL is deployment-trusted (a gateway constant), never user
      // input, so plain composition is right here.
      upstreamUrl: `${upstream.baseURL}/chat/completions`,
      apiKey: leased.secret,
      leasedApiKeyId: leased.keyId,
      fetchRunner: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('llm proxy: no API key configured for provider', { err: message })
    observe({
      usage: null,
      finishReason: null,
      responseText: '',
      ok: false,
      httpStatus: 502,
      errorMessage: message,
      upstreamMs: 0,
    })
    return {
      failure: c.json(
        {
          error: {
            code: 'unavailable',
            message: `No API key configured for provider '${session.provider}'`,
          },
        },
        502,
      ),
    }
  }
}

/**
 * Forward the hardened request to the resolved upstream and meter the response. The local-runner
 * base URL is user-supplied and forwarded server-side, so follow redirects manually and re-validate
 * every hop against the SSRF allow-list under the deployment's loopback/LAN policy (the target's
 * `fetchRunner`); cloud providers use a trusted, hardcoded base URL, so they keep plain `fetch`.
 * Non-2xx is passed straight back (nothing to meter); a streamed body is teed through
 * {@link observationStream} so spend + the observation are recorded off the response path; a
 * buffered body is metered then relayed verbatim.
 */
async function relayUpstream(
  c: Context<AppEnv>,
  ctx: ProxyCallContext,
  target: UpstreamTarget,
): Promise<Response> {
  const { payload, streaming, log, observe, record, waitUntil } = ctx
  const { upstreamUrl, apiKey, fetchRunner } = target
  if (streaming) {
    payload.stream_options = { include_usage: true }
  }

  // Upstream-dispatch clock: the slice between here and the response is the model's execution;
  // the rest of the proxy's time is transport overhead.
  const dispatchAt = Date.now()
  const upstreamInit: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  }
  let upstreamRes: Response
  if (fetchRunner) {
    try {
      upstreamRes = await fetchRunner(upstreamUrl, upstreamInit)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('llm proxy: local runner request blocked', { err: message })
      observe({
        usage: null,
        finishReason: null,
        responseText: '',
        ok: false,
        httpStatus: 502,
        errorMessage: message,
        upstreamMs: Date.now() - dispatchAt,
      })
      return c.json({ error: { code: 'upstream_blocked', message } }, 502)
    }
  } else {
    upstreamRes = await fetch(upstreamUrl, upstreamInit)
  }

  // Non-2xx: pass the upstream error straight back, nothing to meter.
  if (!upstreamRes.ok || !upstreamRes.body) {
    log.error('llm proxy: upstream returned non-2xx', { status: upstreamRes.status })
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
        waitUntil(record(obs.usage, obs.inputTokens))
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
}

/**
 * Ceiling on the buffered proxy request body. A completion payload can carry long prompts and
 * inline (base64) images, so this is generous — but bounded, so a session-authenticated caller
 * can't pin memory up to the platform request limit (SEC-9). Consistent with the artifact
 * upload routes' explicit `bodyLimit`.
 */
const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024

/**
 * The completions paths this proxy serves. The second carries the RUN PHASE the caller was in
 * when it made the call (`agent`, `validation-repair`, `reproduction-repair`, …): the harness
 * points Pi's provider config at `${proxyBaseUrl}/phase/<phase>` for the pass it is about to
 * run, so the phase axis on `llm_call_metrics` is stamped by the component that OWNS the phase
 * boundary rather than inferred downstream from timestamps
 * (`docs/initiatives/token-burn-instrumentation.md`).
 *
 * A URL segment rather than a header because the harness does not make these requests — Pi
 * does, from a config file whose only per-run knobs are the base URL and the token. The
 * unphased path stays the canonical one: an image that predates the phase axis keeps working,
 * and its calls land in the unattributed `''` slice.
 */
const COMPLETIONS_PATHS: string[] = ['/v1/chat/completions', '/v1/phase/:phase/chat/completions']

/**
 * The per-call facts a metered call is described by, fixed at request entry. `requestMaxTokens`
 * is a GETTER because the proxy may still override `max_tokens` after this is built (the Workers
 * AI floor), and the metric must report the ceiling that actually applied.
 */
interface CallMeterContext {
  session: ContainerSession
  callId: string
  /** Proxy-entry clock, for the end-to-end `totalMs`. */
  startedAt: number
  streaming: boolean
  phase: string
  messageCount: number
  toolCount: number
  promptText: string
  requestMaxTokens: () => number | null
}

/**
 * Build the per-call observation handler: (1) push a COMPACT live activity event (no
 * prompt/response bodies) so an open "Model activity" panel updates in real time, independent
 * of the durable driver — the proxy records calls even while the run's poll loop is evicted;
 * (2) persist the full metric to the observability sink when it is wired.
 *
 * `upstreamMs` is supplied by whichever path made the call; `totalMs` is the proxy's end-to-end
 * time. Both halves are best-effort and must never break the proxy. Extracted from
 * {@link handleChatCompletion} because it is a cohesive collaborator (everything the metering
 * boundary needs is in {@link CallMeterContext}) and the handler had no headroom left under the
 * 300-line function budget.
 */
function makeCallObserver(
  meter: CallMeterContext,
  deps: {
    waitUntil: (p: Promise<unknown>) => void
    log: ReturnType<typeof logger.child>
    executionEventPublisher: ServerContainer['executionEventPublisher']
    llmObservability: ServerContainer['llmObservability']
  },
): (obs: ProxyCallObservation) => void {
  const { session, callId, startedAt, streaming, phase, messageCount, toolCount, promptText } =
    meter
  const { waitUntil, log, executionEventPublisher, llmObservability } = deps
  return (obs: ProxyCallObservation): void => {
    const completionTokens = obs.usage?.completion_tokens ?? 0
    // The three input classes are recorded ORTHOGONALLY, so total input is their sum. An
    // upstream path that already knows the split (a gateway whose own shape carries it)
    // hands all three over together; otherwise they are read off the usage payload, which
    // is where the inclusive-vs-exclusive reconciliation lives.
    const input = obs.inputTokens ?? readInputTokenClasses(obs.usage)
    const totalMs = Date.now() - startedAt
    const requestMaxTokens = meter.requestMaxTokens()
    const totalTokens = input.fresh + input.cacheRead + input.cacheWrite + completionTokens

    // Emitted regardless of whether the persistence sink is wired, so the live view works
    // even on a deployment that does not retain metrics. This fires on EVERY observed
    // outcome, including refusals/errors (spend exhausted, unavailable provider, upstream
    // non-2xx) where no model work ran: surfacing those live (with `ok:false`) is intentional
    // and matches what the sink persists. Best-effort: a publish failure (no subscribers,
    // transient hub error) must not break metering.
    waitUntil(
      runBestEffort(log, 'llmProxy.publishCallObserved', () =>
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
          phase,
          messageCount,
          toolCount,
          requestMaxTokens,
          promptTokens: input.fresh,
          cacheReadTokens: input.cacheRead,
          cacheWriteTokens: input.cacheWrite,
          completionTokens,
          totalTokens,
          finishReason: obs.finishReason,
          upstreamMs: obs.upstreamMs,
          overheadMs: Math.max(0, totalMs - obs.upstreamMs),
          totalMs,
          ok: obs.ok,
          httpStatus: obs.httpStatus,
          errorMessage: obs.errorMessage,
        }),
      ),
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
          phase,
          // A proxied call carries no job-scoped turn counter — the proxy sees one HTTP
          // request at a time — so its rows order by `createdAt`, never by a faked turn.
          turnIndex: null,
          messageCount,
          toolCount,
          requestMaxTokens,
          promptTokens: input.fresh,
          cacheReadTokens: input.cacheRead,
          cacheWriteTokens: input.cacheWrite,
          completionTokens,
          totalTokens,
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
          log.warn('llm proxy: failed to record metric', {
            err: err instanceof Error ? err.message : String(err),
          }),
        ),
    )
  }
}

/**
 * Serve one proxied chat completion: verify the container session, harden the payload, gate on
 * spend, forward to the resolved upstream and meter the call. Registered on BOTH completions
 * paths (see {@link COMPLETIONS_PATHS}), which differ only in whether the caller tagged its run
 * phase — hence a named handler rather than an inline one.
 */
async function handleChatCompletion(c: Context<AppEnv>): Promise<Response> {
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
    logger.error('llm proxy: session secret not configured', { scope: 'llmProxy' })
    return c.json({ error: { code: 'unavailable', message: 'LLM proxy is not configured' } }, 503)
  }

  const sessions = new ContainerSessionService({ secret })
  const session = await sessions.verify(bearer(c.req.header('authorization')))
  if (!session) {
    logger.warn('llm proxy: invalid or expired session token', { scope: 'llmProxy' })
    return c.json(
      { error: { code: 'unauthorized', message: 'Invalid or expired session token' } },
      401,
    )
  }

  // Parse + harden the request: lock the model to the session's, and ask for
  // usage on the final streamed chunk so we can always meter. Parsed before the
  // spend gate so a refusal is still recorded with its prompt/shape for analysis.
  let payload: Record<string, unknown>
  try {
    payload = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: { code: 'validation', message: 'Invalid JSON body' } }, 400)
  }
  payload.model = session.model

  // Prompt caching: route this conversation's calls to the same cached prefix on
  // providers that support it (keyed on the execution id, stable across the run's
  // turns). A no-op for providers that cache automatically on the prefix or not at
  // all — see `promptCacheParams`.
  Object.assign(payload, promptCacheParams(session.provider, session.executionId))

  // The run phase this call belongs to, off the (optional) path segment the caller was
  // pointed at. Read through the untyped `param()` map because the SAME handler serves the
  // unphased path too. Untrusted like any request path — a session token is all it takes to
  // write here — so it is normalised to the phase alphabet before it becomes a grouping
  // key; anything else lands in the unattributed `''` slice.
  const phase = normalizeCallPhase((c.req.param() as Record<string, string | undefined>).phase)

  const streaming = payload.stream === true
  const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0
  const messageCount = Array.isArray(payload.messages) ? payload.messages.length : 0
  // The EFFECTIVE output ceiling: updated below if the proxy overrides max_tokens
  // (e.g. the Workers AI floor), so the recorded metric reflects what actually
  // applied, not just what the client asked for.
  let requestMaxTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : null
  // What gets RECORDED, and nothing else: serialised with any image payload described rather than
  // included, because an OpenAI-shape multimodal turn carries the picture inline as a `data:` URL
  // and recording it verbatim would put a base64 copy of every attached image into the telemetry
  // store on every turn that carried one. Nothing may size the REQUEST off this string
  // (`applyWorkersAiCeiling` measures the forwarded payload itself): a shrunken record must not
  // become a shrunken measurement.
  const promptText = JSON.stringify(redactImagePayloads(payload.messages ?? []))

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
  log.info('llm proxy: forwarding chat completion', { streaming, toolCount })

  const waitUntil = makeWaitUntil(c)

  // One id per proxied call, minted here so the SAME id rides both the live
  // `llmCall` activity event and the persisted metric row — the drill-down panel
  // keys its lazy body-load by it, and a live-appended summary row reconciles with
  // the stored row on reload instead of duplicating.
  const callId = `llm_${crypto.randomUUID()}`

  // Per-call observation handling, off the response path — see `makeCallObserver`.
  const observe = makeCallObserver(
    {
      session,
      callId,
      startedAt: t0,
      streaming,
      phase,
      messageCount,
      toolCount,
      promptText,
      // Read lazily: the proxy may still raise `max_tokens` below (the Workers AI floor),
      // and the metric must report the ceiling that actually applied, not the one asked for.
      requestMaxTokens: () => requestMaxTokens,
    },
    { waitUntil, log, executionEventPublisher, llmObservability },
  )

  // Spend gate: refuse once the monthly budget is exhausted, mirroring the
  // engine's pre-step check so a container can't keep spending.
  if (
    await spendService.isOverBudget(session.workspaceId, {
      accountId: session.accountId,
      userId: session.userId,
    })
  ) {
    logger.warn('llm proxy: spend budget exhausted — refusing call', {
      scope: 'llmProxy',
      workspaceId: session.workspaceId,
      executionId: session.executionId,
    })
    observe({
      usage: null,
      finishReason: null,
      responseText: '',
      ok: false,
      httpStatus: 402,
      errorMessage: 'Spend budget exhausted',
      upstreamMs: 0,
    })
    return c.json({ error: { code: 'spend_exhausted', message: 'Spend budget exhausted' } }, 402)
  }

  // Give container agents generous output room for in-process Workers AI models (a no-op
  // for other providers); records the ceiling actually applied so the metric is accurate.
  requestMaxTokens = applyWorkersAiCeiling(session, payload, requestMaxTokens)

  // The pooled API key leased for this call (non-binding providers), so usage can be
  // folded back into its rolling-window rotation counters when the call completes.
  let leasedApiKeyId: string | null = null

  const record = (usage: LlmTokenUsage | null, classes?: InputTokenClasses): Promise<number> => {
    if (!usage) return Promise.resolve(0)
    // The SAME reconciliation the observation path applies (`readInputTokenClasses`), with the
    // same precedence for a gateway that already knew its own split. The ledger reads
    // `prompt_tokens` no longer: it is the whole prompt on the inclusive shapes and fresh-only
    // on the exclusive ones, so metering off it BOTH over-priced an OpenAI-style cached call
    // (cache reads at the fresh rate) and lost Anthropic's cache reads from the volume figure
    // entirely.
    const input = classes ?? readInputTokenClasses(usage)
    const inputTokens = input.fresh + input.cacheRead + input.cacheWrite
    const outputTokens = usage.completion_tokens ?? 0
    // Fold usage into the leased key's rotation counters (best-effort, off the meter). This
    // weight must count EVERY billed input bucket — a cached token still consumes the key's
    // rolling window — so it takes the summed total, not the fresh share.
    if (leasedApiKeyId && apiKeys) {
      void runBestEffort(
        log,
        'apiKeys.recordUsage',
        () => apiKeys.recordUsage(leasedApiKeyId!, { inputTokens, outputTokens }),
        { apiKeyId: leasedApiKeyId },
      )
    }
    return spendService.record({
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      userId: session.userId,
      executionId: session.executionId,
      agentKind: session.agentKind,
      model: `${session.provider}:${session.model}`,
      usage: { inputTokens, outputTokens },
      inputClasses: {
        promptTokens: input.fresh,
        cacheReadTokens: input.cacheRead,
        cacheWriteTokens: input.cacheWrite,
      },
    })
  }

  // The per-call state the dispatch helpers below thread through; `observe` / `record` stay
  // bound to this handler's mutable `requestMaxTokens` / `leasedApiKeyId`.
  const ctx: ProxyCallContext = {
    session,
    payload,
    streaming,
    promptText,
    log,
    gateways,
    apiKeys,
    localModelEndpoints,
    waitUntil,
    observe,
    record,
  }

  // Workers AI (and any binding-reached provider) has no external upstream: run it in-process
  // via the facade's gateway. Null-provider (e.g. Node can't) surfaces as unavailable.
  if (session.provider === 'workers-ai') return dispatchInProcess(c, ctx)

  // Resolve the upstream base URL + bearer key (local runner vs the DB-backed key pool), then
  // forward + meter. A failure is already observed and returned ready-to-send.
  const target = await resolveUpstreamTarget(c, ctx)
  if ('failure' in target) return target.failure
  leasedApiKeyId = target.leasedApiKeyId
  return relayUpstream(c, ctx, target)
}

export function llmProxyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const limit = bodyLimit({
    maxSize: MAX_PROXY_BODY_BYTES,
    onError: (c) =>
      c.json(
        { error: { code: 'payload_too_large', message: 'Request body exceeds size limit' } },
        413,
      ),
  })
  for (const path of COMPLETIONS_PATHS) app.post(path, limit, handleChatCompletion)

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
