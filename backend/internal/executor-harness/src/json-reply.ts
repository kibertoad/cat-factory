// Reading a JSON object out of an agent's final message.
//
// This is the harness half of a pair: the engine reads the SAME reply again with kernel's
// `extractJson` (see `CompanionController.parseContainerVerdict`). The harness reads it FIRST, and
// what it fails to read costs a real, billed repair completion (`resolveStructuredOutput`), so the
// two must agree about which replies are READABLE AT ALL — a shape only kernel accepts is a model
// call the run pays for and nobody needed. The container image is built from `src/` plus typescript
// alone, so that agreement cannot be had by importing kernel: the control-character repair below is
// a deliberate COPY, pinned by `test/json-reply.conformity.test.ts` exactly like `host-markdown.ts`.
//
// WHICH object each half picks can still differ (kernel scans forward from every bracket; this half
// takes the outermost `{…}` span, which is what its caller's one-object contract wants), so the
// conformity suite pins readability, not identity.

/**
 * Extract the JSON object from an agent's final message, tolerating a fence and surrounding prose.
 * Throws when the reply holds no readable JSON.
 *
 * A reply that is valid JSON except for RAW control characters inside a string literal is REPAIRED
 * rather than refused, and — as in kernel — only in a SECOND pass, after the reply has been tried
 * as written. A model asked to lay a field out over several lines (a review verdict written as
 * blocks) writes the layout and drops the `\n` escape, which is worth recovering; recovering it
 * before the reply has been read as written is not, because a repair makes text parse that was
 * meant to be skipped.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced ? (fenced[1] ?? '') : trimmed
  const asWritten = parseWholeOrSpan(body)
  if (asWritten !== undefined) return asWritten
  // No raw control character ⇒ the repair pass would hand `JSON.parse` the same bytes again.
  if (hasRawControlChar(body)) {
    const repaired = parseWholeOrSpan(escapeControlCharsInStrings(body))
    if (repaired !== undefined) return repaired
  }
  throw new Error('agent did not return a JSON object')
}

/**
 * Parse `source`, else its outermost `{…}` span (the object inside the model's prose). Undefined
 * when neither parses — a value `JSON.parse` itself can never return, so `null` stays a result.
 */
function parseWholeOrSpan(source: string): unknown {
  const whole = parseOrUndefined(source)
  if (whole !== undefined) return whole
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  return parseOrUndefined(source.slice(start, end + 1))
}

function parseOrUndefined(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Whether `text` holds any raw control character: the cheap gate on attempting a repair at all. */
function hasRawControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) return true
  }
  return false
}

/** The control characters JSON gives a short escape; the rest go to `\uXXXX`. */
const CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
}

/**
 * Re-escape raw control characters that sit INSIDE a JSON string literal. Only characters inside a
 * string are rewritten, so the structural whitespace between tokens keeps its meaning and a
 * genuinely broken reply still fails to parse. Copied from kernel's `llm-output.ts`.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = ''
  let copiedTo = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!
    if (!inString) {
      if (ch === '"') inString = true
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = false
      continue
    }
    if (json.charCodeAt(i) >= 0x20) continue
    const escape = CONTROL_ESCAPES[ch] ?? `\\u${json.charCodeAt(i).toString(16).padStart(4, '0')}`
    out += json.slice(copiedTo, i) + escape
    copiedTo = i + 1
  }
  return out + json.slice(copiedTo)
}
