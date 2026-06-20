import { redactSecrets } from './git.js'
import { log } from './logger.js'

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
const REPAIR_MAX_OUTPUT_TOKENS = 16_384

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
  proxyBaseUrl: string
  sessionToken: string
  model: string
  jobId: string
  signal?: AbortSignal
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
 * Heuristic detector for the token-doubling corruption ("serviceservice",
 * "observobservabilityability", `{\n{\n`). Greedy scan: at each position, find the
 * longest 2..{@link MAX_DOUBLE_RUN}-char run that is immediately repeated and count
 * both copies as "doubled", then measure the doubled fraction of the whole string.
 * Token-doubled text (consecutive `t t` pairs) scores near 1.0; normal JSON/prose
 * scores low (only incidental short repeats). Advisory ONLY — it labels a failure for
 * telemetry, it never mutates output.
 */
export function looksTokenDoubled(text: string): { doubled: boolean; ratio: number } {
  const n = text.length
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
 * failure reason. Non-streaming + `response_format: json_object` + a focused prompt.
 */
async function callRepair<T>(
  badText: string,
  spec: StructuredOutputSpec<T>,
  access: ProxyAccess,
): Promise<string> {
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
    temperature: 0,
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
