import { redact, redactSecrets, secretsToRedact } from './redact.js'
import { log } from './logger.js'
import { PI_MAX_OUTPUT_TOKENS } from './pi.js'

// A reusable abstraction for the "agent returns a structured JSON document as its
// final assistant message" pattern (requirements, blueprint, merger — and any future
// kind). An agent of this kind emits its result as text, not a tool call, and the
// harness parses it. A model can produce text that won't parse: truncated JSON,
// prose/fences around it, trailing commas, or the workers-ai-provider reasoning-model
// streaming corruption that duplicates every token (`serviceservice…`).
//
// Instead of failing the whole container run on the first unparseable reply, a caller
// describes its output once as a `StructuredOutputSpec<T>` (a label, a shape hint, and
// a parser) and calls `resolveStructuredOutput`. That:
//   1. tries to parse the primary (Pi) output;
//   2. on failure, makes ONE structured repair call — a single-shot, no-tools,
//      NON-streaming completion through the same proxy with `response_format:
//      json_object`, asking the model to return only the corrected JSON — and reparses;
//   3. returns the value (or null) plus structured diagnostics.
//
// It is provider-agnostic (external OpenAI-compatible upstreams honour
// `response_format`; the in-process Workers AI path ignores it but answers buffered,
// sidestepping the streaming double-emit, and the focused prompt keeps it to JSON) and
// observable (the repair call lands in `llm_call_metrics` as a NON-streaming row, and
// every parse failure / repair outcome is logged so "this happened" and "the retry
// didn't help" are both queryable).

/** Output-token ceiling for the repair call — mirrors the harness's PI_MAX_OUTPUT_TOKENS. */
const REPAIR_MAX_OUTPUT_TOKENS = PI_MAX_OUTPUT_TOKENS

/** Hard cap on how much malformed text we feed the repair model (keep the call cheap). */
const MAX_REPAIR_INPUT_CHARS = 40_000

const REPAIR_SYSTEM =
  'You repair malformed JSON. You are given text that was meant to be a single ' +
  'JSON object but does not parse. Return ONLY the corrected JSON object: no prose, ' +
  'no markdown code fences, no commentary, and never repeat or duplicate any tokens. ' +
  'Preserve the original content faithfully; only fix the JSON structure.'

/**
 * Declarative definition of one structured-output kind: how to label it, what shape
 * to ask the repair model for, and how to turn the agent's text into the domain value.
 * `parse` returns null (or throws) when the text is unusable. Built per-job when the
 * parser needs job context (e.g. a fallback service name).
 */
export interface StructuredOutputSpec<T> {
  /** Label for logs/telemetry, e.g. `requirements` / `blueprint` / `merger`. */
  label: string
  /** Compact human description of the expected top-level JSON shape, fed to the model. */
  shapeHint: string
  /** Parse the agent's text into the domain value, or null/throw when unusable. */
  parse: (text: string) => T | null
}

/** Runtime wiring to reach the LLM proxy for the repair call. */
export interface ProxyAccess {
  /** Pi-harness proxy base URL; absent for subscription harnesses (no proxy repair). */
  proxyBaseUrl?: string
  /** Pi-harness proxy session token; absent for subscription harnesses. */
  sessionToken?: string
  model: string
  jobId: string
  signal?: AbortSignal
  /** Carried for context (the subscription harnesses can't use the proxy for repair). */
  harness?: string
  subscriptionToken?: string
  subscriptionBaseUrl?: string
}

/** Structured diagnostics for a resolution attempt, surfaced to logs + the failure reason. */
export interface StructuredOutputDiagnostics {
  /** Which attempt produced a usable value (or `none` when both failed). */
  parsedOn: 'primary' | 'repair' | 'none'
  /** Length of the agent's primary (Pi) output, in characters. */
  primaryChars: number
  /** Whether the primary output looked token-doubled (advisory heuristic). */
  looksDoubled: boolean
  /** Whether a repair call was made. */
  repairAttempted: boolean
  /** Whether the repair call produced a usable value. */
  repairSucceeded: boolean
  /** One-line reason the repair call itself failed (HTTP error / still-unparseable), if any. */
  repairError?: string
}

export interface StructuredOutputResult<T> {
  value: T | null
  diagnostics: StructuredOutputDiagnostics
}

/**
 * Largest immediately-repeated run length we look for. The corruption duplicates
 * whole model tokens, which carry whitespace/punctuation context and run to ~10-15
 * chars (`"service"`, `observability`); 24 covers them with headroom while staying
 * cheap. We don't match single chars (k>=2): a lone doubled `{`/space is normal.
 */
const MAX_DOUBLE_RUN = 24

/**
 * Cap on how much of a (possibly huge) failed output the doubling heuristic scans.
 * The corruption is uniform across the whole reply, so a prefix is representative,
 * and this bounds the otherwise O(n·{@link MAX_DOUBLE_RUN}²) scan on a large
 * document. The detector only runs on the parse-failure path, so this is belt-and-
 * braces rather than a hot-path concern.
 */
const MAX_DOUBLE_SCAN_CHARS = 20_000

/**
 * Heuristic detector for the token-doubling corruption ("serviceservice",
 * "observobservabilityability", `{\n{\n`). Greedy scan over a bounded prefix: at each
 * position, find the longest 2..{@link MAX_DOUBLE_RUN}-char run that is immediately
 * repeated and count both copies as "doubled", then measure the doubled fraction of
 * the scanned text. Token-doubled text (consecutive `t t` pairs) scores near 1.0;
 * normal JSON/prose scores low (only incidental short repeats). Advisory ONLY — it
 * labels a failure for telemetry, it never mutates output.
 */
export function looksTokenDoubled(text: string): { doubled: boolean; ratio: number } {
  // Scan at most MAX_DOUBLE_SCAN_CHARS; `startsWith` stays within this prefix because
  // `maxK` bounds each match so `i + matched * 2 <= n`.
  const n = Math.min(text.length, MAX_DOUBLE_SCAN_CHARS)
  if (n < 40) return { doubled: false, ratio: 0 }
  let covered = 0
  let i = 0
  while (i < n) {
    let matched = 0
    const maxK = Math.min(MAX_DOUBLE_RUN, Math.floor((n - i) / 2))
    for (let k = maxK; k >= 2; k--) {
      // Is the k-char run at i immediately followed by an identical run?
      if (text.startsWith(text.slice(i, i + k), i + k)) {
        matched = k
        break
      }
    }
    if (matched > 0) {
      covered += matched * 2
      i += matched * 2
    } else {
      i += 1
    }
  }
  const ratio = covered / n
  return { doubled: ratio >= 0.5, ratio }
}

/**
 * Resolve a structured output: parse the agent's `primaryText` via `spec.parse`; on
 * failure, make ONE structured repair call and re-parse. Returns the value (or null
 * when both attempts fail) plus {@link StructuredOutputDiagnostics}. Logging side
 * effects only; never throws (a repair transport error is captured in the diagnostics).
 */
export async function resolveStructuredOutput<T>(
  spec: StructuredOutputSpec<T>,
  primaryText: string,
  access: ProxyAccess,
): Promise<StructuredOutputResult<T>> {
  const trace = { agent: spec.label, jobId: access.jobId }
  const primaryChars = primaryText.length

  const primary = safeParse(primaryText, spec.parse)
  if (primary !== null) {
    return {
      value: primary,
      diagnostics: {
        parsedOn: 'primary',
        primaryChars,
        looksDoubled: false,
        repairAttempted: false,
        repairSucceeded: false,
      },
    }
  }

  // Pick a repair channel. The Pi harness repairs through the LLM proxy; the
  // claude-code subscription harness has no proxy but DOES speak a standard
  // Anthropic Messages API (Anthropic itself, or an Anthropic-compatible endpoint
  // for GLM/Kimi/DeepSeek), so it repairs straight against the vendor with the
  // leased token. Codex has no simple JSON API, so it keeps the graceful no-repair
  // path (the smaller GLM/Kimi/DeepSeek models — most prone to malformed JSON — are
  // covered by the claude-code channel).
  const canProxyRepair = !!access.proxyBaseUrl && !!access.sessionToken
  const canSubscriptionRepair = access.harness === 'claude-code' && !!access.subscriptionToken
  if (!canProxyRepair && !canSubscriptionRepair) {
    return {
      value: null,
      diagnostics: {
        parsedOn: 'none',
        primaryChars,
        looksDoubled: looksTokenDoubled(primaryText).doubled,
        repairAttempted: false,
        repairSucceeded: false,
        repairError: `structured-output repair unavailable for the ${access.harness ?? 'pi'} harness`,
      },
    }
  }

  // Primary failed: label the corruption (doubling is the known reasoning-model
  // streaming bug) and record the event before spending a repair call.
  const doubled = looksTokenDoubled(primaryText)
  log.warn('structured-output: primary unparseable — attempting structured repair', {
    ...trace,
    primaryChars,
    looksDoubled: doubled.doubled,
    doubledRatio: Number(doubled.ratio.toFixed(2)),
  })

  let repairError: string | undefined
  let repaired: T | null = null
  try {
    const repairedText = await callRepair(primaryText, spec, access)
    repaired = safeParse(repairedText, spec.parse)
    if (repaired === null) repairError = 'repair output still did not parse'
  } catch (err) {
    repairError = err instanceof Error ? err.message : String(err)
  }

  if (repaired !== null) {
    log.info('structured-output: repair recovered a usable document', { ...trace, primaryChars })
    return {
      value: repaired,
      diagnostics: {
        parsedOn: 'repair',
        primaryChars,
        looksDoubled: doubled.doubled,
        repairAttempted: true,
        repairSucceeded: true,
      },
    }
  }

  // The retry did not help — the case we explicitly want visible in telemetry.
  log.error('structured-output: unrecoverable after structured repair', {
    ...trace,
    primaryChars,
    looksDoubled: doubled.doubled,
    doubledRatio: Number(doubled.ratio.toFixed(2)),
    repairError,
  })
  return {
    value: null,
    diagnostics: {
      parsedOn: 'none',
      primaryChars,
      looksDoubled: doubled.doubled,
      repairAttempted: true,
      repairSucceeded: false,
      repairError,
    },
  }
}

/**
 * Make the structured repair call and return the model's text (the corrected JSON,
 * ideally). Throws on a transport/HTTP error so the caller records it as the repair
 * failure reason. Routes to the LLM proxy (Pi harness) when present, else to the
 * claude-code subscription harness's own Anthropic-compatible endpoint.
 */
async function callRepair<T>(
  badText: string,
  spec: StructuredOutputSpec<T>,
  access: ProxyAccess,
): Promise<string> {
  if ((!access.proxyBaseUrl || !access.sessionToken) && access.subscriptionToken) {
    return callSubscriptionRepair(badText, spec, access)
  }
  // Only ever called after the caller verified the proxy is present (Pi harness).
  if (!access.proxyBaseUrl || !access.sessionToken) {
    throw new Error('structured-output repair requires the LLM proxy (Pi harness)')
  }
  const url = `${access.proxyBaseUrl.replace(/\/+$/, '')}/chat/completions`
  const messages = [
    { role: 'system', content: REPAIR_SYSTEM },
    {
      role: 'user',
      content:
        `${spec.shapeHint}\n\n` +
        'The text below was meant to be that JSON object but does not parse. Return ' +
        'ONLY the corrected JSON object.\n\n' +
        badText.slice(0, MAX_REPAIR_INPUT_CHARS),
    },
  ]
  const base = {
    // The proxy locks the model to the session's; sent for completeness.
    model: access.model,
    stream: false,
    max_tokens: REPAIR_MAX_OUTPUT_TOKENS,
    // No `temperature`: the newest models (Anthropic Opus 4.7+/the Claude 5 family) reject
    // any sampling parameter with a 400, and a single-shot repair whose system prompt already
    // forces JSON-only output doesn't need one — so we omit it for every model/provider.
    messages,
  }

  // Capability gate: ask for `json_object` structured output (honoured by external
  // OpenAI-compatible upstreams; ignored by the in-process Workers AI path). If an
  // upstream REJECTS the parameter (4xx), fall back to the prompt-only path — the
  // system prompt already demands JSON — rather than failing the repair outright.
  const withFormat = { ...base, response_format: { type: 'json_object' } }
  let res = await post(url, access, withFormat)
  if (!res.ok && res.status >= 400 && res.status < 500) {
    log.warn('structured-output: repair upstream rejected response_format — retrying prompt-only', {
      agent: spec.label,
      jobId: access.jobId,
      status: res.status,
    })
    res = await post(url, access, base)
  }
  if (!res.ok) {
    const detail = redactSecrets((await res.text().catch(() => '')).slice(0, 300))
    throw new Error(`repair call failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }
  const content = json.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

/**
 * Repair via the claude-code subscription harness's own vendor endpoint (no proxy):
 * a single non-streaming Anthropic Messages call with the leased token. Anthropic
 * itself uses the OAuth token (Bearer + the oauth beta header) against
 * api.anthropic.com; an Anthropic-compatible vendor (GLM/Kimi/DeepSeek) uses its
 * `subscriptionBaseUrl` with the API-token `x-api-key` header. Best-effort: any
 * error propagates to the caller's `repairError` and degrades to the null path.
 */
async function callSubscriptionRepair<T>(
  badText: string,
  spec: StructuredOutputSpec<T>,
  access: ProxyAccess,
): Promise<string> {
  if (!access.subscriptionToken) {
    throw new Error('structured-output subscription repair requires a subscription token')
  }
  const base = access.subscriptionBaseUrl?.replace(/\/+$/, '') ?? 'https://api.anthropic.com'
  const url = `${base}/v1/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (access.subscriptionBaseUrl) {
    // Anthropic-compatible vendor (GLM/Kimi/DeepSeek): API token via x-api-key.
    headers['x-api-key'] = access.subscriptionToken
  } else {
    // Anthropic on a Claude subscription OAuth token.
    headers.authorization = `Bearer ${access.subscriptionToken}`
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  }
  const body = {
    model: access.model,
    max_tokens: REPAIR_MAX_OUTPUT_TOKENS,
    // No `temperature`: Anthropic's newest models (Opus 4.7+/Claude 5 family) reject the
    // sampling parameters with `400 invalid_request_error: temperature is deprecated for this
    // model`. The repair prompt fully constrains the output to JSON, so determinism via
    // temperature=0 isn't needed — omitting it keeps the call valid on every model.
    system: REPAIR_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `${spec.shapeHint}\n\n` +
          'The text below was meant to be that JSON object but does not parse. Return ' +
          'ONLY the corrected JSON object.\n\n' +
          badText.slice(0, MAX_REPAIR_INPUT_CHARS),
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: access.signal,
  })
  if (!res.ok) {
    // A vendor 4xx body can echo the API key/token back; `redact` applies both the
    // GitHub-shaped pattern rules AND scrubs the leased subscription credential (the raw
    // value, and — for a JSON auth bundle — its nested token leaves) before surfacing.
    const raw = (await res.text().catch(() => '')).slice(0, 300)
    const detail = redact(raw, secretsToRedact(access.subscriptionToken ?? ''))
    throw new Error(
      `subscription repair call failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
    )
  }
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
  // Concatenate the text blocks of the Anthropic Messages response.
  return (json.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** POST a chat-completions body to the proxy with the session bearer token. */
function post(url: string, access: ProxyAccess, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: access.signal,
  })
}

/** Run `parse`, treating a thrown error (e.g. `extractJsonObject`) as "no value". */
function safeParse<T>(text: string, parse: (text: string) => T | null): T | null {
  try {
    return parse(text)
  } catch {
    return null
  }
}

/** Append a compact, human-readable diagnostics suffix to a no-document failure reason. */
export function diagnosticsSuffix(d: StructuredOutputDiagnostics): string {
  const parts: string[] = []
  if (d.looksDoubled) parts.push('output appeared token-doubled (streaming corruption)')
  if (d.repairAttempted) {
    parts.push(
      d.repairSucceeded
        ? 'structured repair recovered it'
        : `structured repair did not help${d.repairError ? ` (${d.repairError})` : ''}`,
    )
  }
  return parts.length > 0 ? ` [${parts.join('; ')}]` : ''
}
