import type { AttributeMap, AttributeValue } from './mapping.js'
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
    // OTLP/HTTP returns 200 on full success and may return 200 with a partial-success body;
    // any non-2xx is a failure we only log — observability never breaks the caller.
    if (!res.ok) {
      opts.logger?.warn('otel: OTLP endpoint rejected batch', { scope: 'otel', status: res.status })
    }
  } catch (err) {
    opts.logger?.warn('otel: failed to POST OTLP batch', {
      scope: 'otel',
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
