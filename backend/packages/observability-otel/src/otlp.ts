import type { AttributeMap, AttributeValue } from './mapping.js'
import { getErrorMessage } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/kernel'

// Shared OTLP/HTTP JSON encoding + transport helpers used by BOTH fetch-based exporters
// in this package — the per-call LLM trace/metric exporter (`./index`) and the periodic
// platform-metrics exporter (`./platform`). Kept here so the two never drift on how an
// attribute value is encoded or how a batch is POSTed. Nothing here depends on
// `@opentelemetry/*` (workerd-safe) or on any global beyond `fetch`/`AbortSignal`.

/** Hard ceiling on a single OTLP POST, so a hung collector can't tie up the caller. */
const SEND_TIMEOUT_MS = 10_000

/** An OTLP `AnyValue` in the JSON encoding (string / bool / int / double / string list). */
export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }

/** An OTLP `KeyValue` pair (an attribute). */
export interface KeyValue {
  key: string
  value: AnyValue
}

/** Encode one neutral attribute value as an OTLP `AnyValue`. */
function anyValue(value: AttributeValue): AnyValue {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } }
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'boolean') return { boolValue: value }
  return { stringValue: value }
}

/** Encode a neutral attribute map as an OTLP `KeyValue[]`. */
export function keyValues(attrs: AttributeMap): KeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }))
}

/**
 * POST an OTLP/JSON payload to `endpoint`, best-effort. Observability must never break the
 * caller, so a non-2xx response or a transport error is only logged (never thrown) and the
 * batch is dropped — the documented worst case. Bounded by {@link SEND_TIMEOUT_MS} so a
 * hung collector can't dangle the caller's budget.
 */
export async function postOtlp(opts: {
  fetchImpl: typeof fetch
  endpoint: string
  headers: Record<string, string>
  payload: unknown
  logger?: Logger
  timeoutMs?: number
}): Promise<void> {
  try {
    const res = await opts.fetchImpl(opts.endpoint, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    })
    if (!res.ok) {
      opts.logger?.warn('otel: OTLP endpoint rejected batch', { scope: 'otel', status: res.status })
      return
    }
    await reportPartialSuccess(res, opts.logger)
  } catch (err) {
    opts.logger?.warn('otel: failed to POST OTLP batch', {
      scope: 'otel',
      err: getErrorMessage(err),
    })
  }
}

/**
 * A 2xx does NOT mean the collector took everything.
 *
 * OTLP's `partial_success` is load-bearing: a server that dropped some of the batch answers 200
 * with a rejected count and a message, and it MAY warn about a batch it took whole (a zero
 * rejected count beside a non-empty `error_message`). Treating any 200 as full acceptance made
 * silently dropped spans look identical to a clean flush, which is the degrade-loudly rule with
 * the vendor's own field sitting unread. Nothing here retries: the spec forbids retrying a partial
 * success, and this exporter never retried anything.
 */
async function reportPartialSuccess(res: Response, logger: Logger | undefined): Promise<void> {
  if (!logger) return
  const partial = await readPartialSuccess(res)
  if (!partial) return
  const rejected =
    partial.rejectedSpans ?? partial.rejectedDataPoints ?? partial.rejectedLogRecords ?? 0
  if (!rejected && !partial.errorMessage) return
  logger.warn('otel: OTLP endpoint accepted the batch only in part', {
    scope: 'otel',
    rejected,
    ...(partial.errorMessage ? { detail: partial.errorMessage } : {}),
  })
}

/** The `partialSuccess` block of an OTLP/JSON response, or undefined when there is none. */
async function readPartialSuccess(res: Response): Promise<
  | {
      rejectedSpans?: number
      rejectedDataPoints?: number
      rejectedLogRecords?: number
      errorMessage?: string
    }
  | undefined
> {
  // A collector answering 200 with an empty body is the ordinary full-acceptance case, and an
  // unreadable body says nothing about what was accepted, so both read as "nothing to report".
  const body = await res.text().catch(() => '')
  if (!body.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const partial = (parsed as Record<string, unknown>).partialSuccess
  if (typeof partial !== 'object' || partial === null) return undefined
  const read = partial as Record<string, unknown>
  // 64-bit counts arrive as decimal STRINGS in the JSON encoding, and either form is legal.
  const count = (value: unknown): number | undefined => {
    const n = typeof value === 'string' ? Number(value) : value
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }
  return {
    ...(count(read.rejectedSpans) !== undefined
      ? { rejectedSpans: count(read.rejectedSpans) }
      : {}),
    ...(count(read.rejectedDataPoints) !== undefined
      ? { rejectedDataPoints: count(read.rejectedDataPoints) }
      : {}),
    ...(count(read.rejectedLogRecords) !== undefined
      ? { rejectedLogRecords: count(read.rejectedLogRecords) }
      : {}),
    ...(typeof read.errorMessage === 'string' && read.errorMessage
      ? { errorMessage: read.errorMessage }
      : {}),
  }
}
