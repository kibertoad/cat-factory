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
}

// The four leading fields, plus whatever a future version appends. `00` is EXACTLY these four
// (the spec fixes it at 55 characters), so the trailing group is refused for it below; a higher
// version may carry more `-`-delimited fields and the spec requires a parser to read the four it
// understands and ignore the rest. Anchored at both ends with fixed widths, so the only thing
// that ever matches is the exact grammar.
const TRACEPARENT_PATTERN = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-[\da-f-]*)?$/
const VERSION_00 = '00'
const ALL_ZERO_TRACE_ID = '0'.repeat(32)
const ALL_ZERO_SPAN_ID = '0'.repeat(16)
/**
 * The longest header worth looking at, checked BEFORE the value is normalised or matched.
 *
 * Version `00` is 55 characters and a future version adds `-`-delimited fields to that, so this
 * is generous by an order of magnitude and still refuses a megabyte header outright rather than
 * lower-casing it first. The regex is anchored and would fail such input anyway; this keeps the
 * work proportional to the header a real caller sends, on a path that runs on every request.
 */
const MAX_TRACEPARENT_LENGTH = 512

/**
 * Parse a `traceparent` header value, or null when it is absent or malformed.
 *
 * The header is UNTRUSTED input on any public deployment, and what it buys an attacker is worth
 * naming: the value is echoed into every exported line for the request. So the length is bounded
 * first, the parse is strict by shape (fixed-width, fully anchored hex) rather than lenient, and
 * only the matched GROUPS are returned. There is nothing to sanitise afterwards, which is the
 * point of accepting only the exact grammar.
 *
 * Malformed means IGNORED, never rejected: the request is real work and a bad correlation
 * header is not a reason to refuse it. The line then falls back to its own correlation (the
 * request id, and a run's derived trace id where there is a run), which is what it had before
 * the header existed.
 *
 * Forward-compatible on VERSION, per the spec: an unknown future version still has these four
 * fields at the front, so it is parsed rather than dropped even when it appends fields we do not
 * understand. Version `00` is the one that may NOT, being fixed at exactly four. `ff` is the one
 * reserved value and is refused. Both all-zero ids are refused too, being the spec's own
 * "invalid" sentinels: a broken instrumentation library upstream emits them, and adopting one
 * would file every such request into one enormous shared trace.
 *
 * The trace-flags byte is VALIDATED (it is part of the grammar) but its `sampled` bit is not
 * returned, because nothing here may act on it. This deployment has no sampler: a line that
 * reaches the exporter is one it chose to export, and the exported record's flags state THAT
 * decision rather than the caller's. Carrying the bit with no consumer would be a field whose
 * documented purpose no code performs. It belongs to the slice that emits a span of our own,
 * which is the first thing that would have a sampling decision to inherit.
 */
export function parseTraceparent(raw: string | undefined | null): InboundTraceContext | null {
  const value = raw?.trim()
  if (!value || value.length > MAX_TRACEPARENT_LENGTH) return null
  const match = TRACEPARENT_PATTERN.exec(value.toLowerCase())
  if (!match) return null
  const [, version, traceId, spanId, , extra] = match
  if (version === 'ff') return null
  if (version === VERSION_00 && extra !== undefined) return null
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) return null
  return { traceId: traceId!, spanId: spanId! }
}
