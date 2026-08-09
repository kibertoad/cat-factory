// ---------------------------------------------------------------------------
// Keep IMAGE BYTES out of a recorded prompt body.
//
// Every path that records what a model was sent serialises the message array as JSON, and that was
// safe for exactly as long as a message was text. A multimodal turn carries a whole PNG in a
// content part, in one of two shapes depending on who composed it: a `Uint8Array` on an inline
// call through the AI SDK, or a `data:` URL on an OpenAI-shape request through the LLM proxy. Both
// are catastrophic to serialise verbatim — a typed array JSON-stringifies to one object ENTRY PER
// BYTE, so a half-megabyte design frame lands as several megabytes of `{"0":137,"1":80,…}` in the
// telemetry store, on every turn of the run that carried it.
//
// So a body is walked before it is serialised and each payload is replaced by a DESCRIPTION of
// itself. Stating it rather than deleting the part is the point: a reader of the recorded prompt
// has to be able to tell a turn that carried a picture from one that did not, and a silently
// removed part reads as the second.
// ---------------------------------------------------------------------------

/** The `data:` URL prefix an OpenAI-shape `image_url` part carries a picture in. */
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w-]+=[\w-]+)*(;base64)?,/i

/**
 * How long a plain string may be before it is treated as an inlined payload rather than a URL.
 *
 * A remote `image_url` is a link and belongs in the record verbatim: it is how a reader finds the
 * picture again. Only a `data:` URL carries the bytes, and this bound is the backstop for a
 * producer that inlines one some other way (a bare base64 blob), sized well above any real URL.
 */
const MAX_INLINE_STRING = 2048

/** A payload's stand-in: what it was and how big, never any of it. */
function describePayload(bytes: number, mediaType?: string): string {
  return `<binary ${mediaType ?? 'payload'} withheld: ${bytes} bytes>`
}

/**
 * Replace every binary payload in a model-message body with a description of itself.
 *
 * Structure-preserving and TYPE-agnostic: it walks arrays and plain objects and rewrites only the
 * values that ARE payloads, so the caller keeps serialising whatever shape its own SDK produced and
 * this stays correct across the two (and any third) message vocabularies. A value it does not
 * recognise is returned untouched, because the alternative — guessing at a shape — would redact a
 * field of ordinary prose the moment a vocabulary grew one.
 *
 * Never throws and never mutates its input: a recording path must not be able to fail the call it
 * is recording, and the body it was handed is the one being sent.
 */
export function redactImagePayloads<T>(value: T): T {
  return walk(value, 0) as T
}

/**
 * Depth is bounded because this runs on the hot path of every recorded call over a body the
 * platform did not author (the proxy forwards whatever the agent CLI sent). A body nested past the
 * bound is returned as-is rather than descended into: the payloads it could still hide are the same
 * ones every real vocabulary puts within a few levels of the root.
 */
const MAX_DEPTH = 8

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1))
  if (value instanceof Uint8Array) return describePayload(value.byteLength)
  if (value instanceof ArrayBuffer) return describePayload(value.byteLength)
  if (typeof value === 'string') return redactDataUrl(value)
  if (typeof value !== 'object' || value === null) return value
  // Only PLAIN objects are descended into. Anything with a prototype of its own (the AI SDK also
  // accepts a `URL` beside raw bytes, and a Buffer is a Uint8Array subclass caught above) is
  // returned as-is: a walk would rebuild it as a bare object and change what gets serialised.
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(entry, depth + 1)
  }
  return out
}

/** A `data:` URL (or an over-long inline blob) described; anything else returned unchanged. */
function redactDataUrl(value: string): string {
  const match = DATA_URL.exec(value)
  if (match) {
    // The byte count is of the ENCODED payload. Reporting the decoded size would mean decoding it,
    // which is the work this function exists to avoid, and the number is only ever read as a scale.
    return describePayload(value.length - match[0].length, match[1])
  }
  return value.length > MAX_INLINE_STRING && !/^https?:\/\//i.test(value) && isBase64ish(value)
    ? describePayload(value.length)
    : value
}

/**
 * Whether a long string looks like raw base64 rather than prose.
 *
 * Deliberately narrow: a long PROMPT is the ordinary case on every one of these paths, and
 * redacting one would destroy the record this whole subsystem exists to keep. Only a string that is
 * entirely base64 alphabet with no whitespace qualifies, which no natural-language body is.
 */
function isBase64ish(value: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(value)
}
