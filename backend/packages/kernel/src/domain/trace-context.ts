// W3C Trace Context: reading the `traceparent` an inbound caller sent, so this deployment's
// telemetry can join the trace that caller is already collecting rather than starting a
// disconnected one of its own.
//
// The rule lives in kernel because TWO packages have to agree about it and neither may depend
// on the other: `@cat-factory/server` PARSES the header at the request boundary and binds the
// result onto the request-scoped logger, and `@cat-factory/observability-otel` READS those
// bound fields back off an emitted line to stamp the exported OTLP record. A second copy of
// either the field names or the validity rules would let one side adopt a trace id the other
// silently ignores, which presents as "the header does nothing" with every test green.
//
// Deliberately NOT here: emitting a `traceparent` of our own, or carrying `tracestate`.
// Neither is a parse; both are things a producer of spans owes its callees, and the request
// boundary produces no span (its evidence is the log line). Adding them is the slice that adds
// a request span, not this one.

/** The inbound propagation header, lowercase per the W3C spec (HTTP/2 requires lowercase). */
export const TRACEPARENT_HEADER = 'traceparent'

/**
 * The log fields an adopted trace context is bound under.
 *
 * They are the names an operator already greps for in stdout, per the log exporter's rule that
 * a field keeps its local name rather than being renamed into an OTLP namespace. Constants
 * rather than string literals because the binder and the reader are in different packages: a
 * typo on either side is otherwise a silently un-joined trace.
 */
export const TRACE_ID_FIELD = 'traceId'
export const SPAN_ID_FIELD = 'spanId'

/** A caller's trace context, as read off a valid `traceparent`. */
export interface InboundTraceContext {
  /** 32-hex trace id the caller is collecting under. */
  traceId: string
  /**
   * 16-hex id of the caller's own span: the parent of anything we were to emit, and what a
   * log line points at so it lands beside the caller's span rather than loose in the trace.
   */
  spanId: string
  /**
   * Whether the caller marked the trace SAMPLED (the low bit of its trace flags).
   *
   * Carried rather than assumed, because it is the caller's decision to make: a deployment
   * that exports every line regardless still owes the backend an honest answer about what the
   * upstream chose, and a backend uses it to decide whether the trace being pointed at is one
   * it should expect to hold.
   */
  sampled: boolean
}

const TRACEPARENT_PATTERN = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/
const ALL_ZERO_TRACE_ID = '0'.repeat(32)
const ALL_ZERO_SPAN_ID = '0'.repeat(16)
/** W3C `sampled`, the low bit of the trace-flags byte. */
const TRACE_FLAG_SAMPLED = 0x01

/**
 * Parse a `traceparent` header value, or null when it is absent or malformed.
 *
 * The header is UNTRUSTED input on any public deployment, and what it buys an attacker is
 * worth naming: the value is echoed into every exported line for the request, so the parse is
 * strict by shape (a fixed-width, fully anchored hex pattern) rather than lenient, and the
 * length is bounded by that pattern before the regex ever runs. There is nothing to sanitise
 * afterwards, which is the point of accepting only the exact grammar.
 *
 * Malformed means IGNORED, never rejected: the request is real work and a bad correlation
 * header is not a reason to refuse it. The line then falls back to its own correlation (the
 * request id, and a run's derived trace id where there is a run), which is what it had before
 * the header existed.
 *
 * Forward-compatible on VERSION, per the spec: an unknown future version still has these four
 * fields at the front, so it is parsed rather than dropped. `ff` is the one reserved value and
 * is refused. Both all-zero ids are refused too, being the spec's own "invalid" sentinels — a
 * broken instrumentation library upstream emits them, and adopting one would file every such
 * request into one enormous shared trace.
 */
export function parseTraceparent(raw: string | undefined | null): InboundTraceContext | null {
  const match = TRACEPARENT_PATTERN.exec(raw?.trim().toLowerCase() ?? '')
  if (!match) return null
  const [, version, traceId, spanId, flags] = match
  if (version === 'ff') return null
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) return null
  return {
    traceId: traceId!,
    spanId: spanId!,
    sampled: (Number.parseInt(flags!, 16) & TRACE_FLAG_SAMPLED) !== 0,
  }
}
