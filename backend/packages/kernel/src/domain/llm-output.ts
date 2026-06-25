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
  for (let from = 0; from < candidate.length; ) {
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
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
