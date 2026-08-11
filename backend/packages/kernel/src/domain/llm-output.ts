// Shared helpers for parsing a model's free-text reply. Pure (no IO/clock), so the
// domain packages (orchestration/integrations) and the agents facade all extract JSON
// from an LLM response the same robust way instead of each shipping its own copy.

/**
 * Extract the first JSON value (object or array) embedded in a model's reply that
 * actually parses.
 *
 * The brace/bracket matcher is string-literal aware: braces inside a JSON string value
 * (e.g. a `rationale` containing an unbalanced `}`) are skipped, so a valid reply isn't
 * truncated into a parse failure. It scans FORWARD from each candidate bracket: a `[` or
 * `{` whose balanced span doesn't parse (e.g. preamble prose like `I weighed [the auth
 * flow] and concluded: {…}` — the `[the auth flow]` is not JSON) is skipped and the next
 * bracket is tried, so the real object after the prose is still found rather than the
 * whole extraction collapsing to `null`. A fenced code block (```` ```json … ``` ````) is
 * preferred when it contains a JSON value, but if the first fence holds no JSON (e.g. a
 * model fenced its reasoning before emitting the real object) we fall back to scanning the
 * whole reply, so the JSON that follows the fence is still found.
 *
 * A span that is valid JSON except for RAW control characters inside a string literal is
 * repaired rather than refused (see {@link escapeControlCharsInStrings}).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    const fromFence = extractJsonValue(fenced[1]!)
    if (fromFence !== null) return fromFence
  }
  return extractJsonValue(trimmed)
}

/**
 * Scan `candidate` for the first balanced JSON object/array that parses, skipping any
 * earlier bracket whose balanced span is not valid JSON (e.g. a bracket inside prose).
 */
function extractJsonValue(candidate: string): unknown {
  for (let from = 0; from < candidate.length;) {
    const rel = candidate.slice(from).search(/[[{]/)
    if (rel === -1) return null
    const start = from + rel
    const value = parseBalancedFrom(candidate, start)
    if (value !== null) return value
    from = start + 1
  }
  return null
}

/** Parse the balanced JSON value that starts at `candidate[start]`, or null if it doesn't parse. */
function parseBalancedFrom(candidate: string, start: number): unknown {
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return parseOrRepair(candidate.slice(start, i + 1))
    }
  }
  return null
}

/**
 * Parse one balanced span, giving it a second chance with its string literals re-escaped (see
 * {@link escapeControlCharsInStrings}). Null when neither attempt parses, which sends the caller
 * on to the next bracket rather than claiming a value nobody wrote.
 */
function parseOrRepair(span: string): unknown {
  try {
    return JSON.parse(span)
  } catch {
    // Not JSON as written. One malformation is worth a second attempt.
  }
  try {
    return JSON.parse(escapeControlCharsInStrings(span))
  } catch {
    return null
  }
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
 * Re-escape raw control characters that sit INSIDE a JSON string literal.
 *
 * `JSON.parse` rejects a literal newline in a string, and that is the malformation a model
 * reliably produces once a field is asked for as several lines (a review verdict laid out as
 * blocks, a rationale with a bullet list): it writes the layout it was told to write and drops
 * the `\n` escape. The reply is otherwise the verdict, so refusing it loses a whole review to a
 * quoting slip. Only characters inside a string are rewritten, so the structural whitespace
 * between tokens keeps its meaning and a genuinely broken reply still fails to parse.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      escaped = false
      out += ch
      continue
    }
    if (ch === '\\') {
      escaped = true
      out += ch
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    out +=
      CONTROL_ESCAPES[ch] ??
      (ch < ' ' ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch)
  }
  return out
}
