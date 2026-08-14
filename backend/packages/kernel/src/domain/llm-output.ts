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
 * whole extraction collapsing to `null`. Fenced code blocks (```` ```json … ``` ````) are
 * searched first, in the order written: a model that fenced its reasoning before emitting the
 * real object still gets read, and so does one whose payload sits in a later fence.
 *
 * A span that is valid JSON except for RAW control characters inside a string literal is
 * REPAIRED rather than refused (see {@link escapeControlCharsInStrings}) — but only in a second
 * pass, after every candidate in every source has been tried AS WRITTEN.
 *
 * That two-pass order is the whole safety property, and repairing inside the scan loop broke it:
 * a repair makes an earlier span parse that would otherwise have been skipped, so an example
 * shape or a prose aside ("Notes on the field: {"name": "the field<newline>I mean"}") starts
 * SHADOWING the real verdict written after it. A verdict is the one thing that must not be
 * guessed, and a model told to lay a field out over several lines writes exactly the
 * malformation that used to make such a span skippable. So a strictly-parseable value anywhere
 * in the reply outranks a repaired one, and the repair only ever recovers a reply that had no
 * readable JSON at all.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  // Fence bodies first (a deliberate delimiter of the payload), then the whole reply. The same
  // ordered list is walked by both passes, so the fence preference holds within each.
  const sources = [...fencedBodies(trimmed), trimmed]
  for (const mode of PARSE_MODES) {
    for (const source of sources) {
      const value = extractJsonValue(source, mode)
      if (value !== null) return value
    }
  }
  return null
}

/** Strict first, everywhere; repair only once nothing parsed as written. See {@link extractJson}. */
const PARSE_MODES = ['strict', 'repair'] as const
type ParseMode = (typeof PARSE_MODES)[number]

/**
 * The body of every fenced block in the reply, in the order written.
 *
 * All of them, not just the first: the fence a payload sits in is not always the first one (a
 * model fences its reasoning, or shows an example, before the object), and in the repair pass the
 * ordering decides which candidate wins. A nested fence (a code block inside a string value) makes
 * the split imperfect by construction — the closing ``` of the inner block ends the outer match —
 * which is why the whole reply stays in the list as the final source.
 */
function fencedBodies(text: string): string[] {
  return [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1] ?? '')
}

/**
 * Scan `candidate` for the first balanced JSON object/array that parses, skipping any
 * earlier bracket whose balanced span is not valid JSON (e.g. a bracket inside prose).
 */
function extractJsonValue(candidate: string, mode: ParseMode): unknown {
  for (let from = 0; from < candidate.length;) {
    const rel = candidate.slice(from).search(/[[{]/)
    if (rel === -1) return null
    const start = from + rel
    const value = parseBalancedFrom(candidate, start, mode)
    if (value !== null) return value
    from = start + 1
  }
  return null
}

/** Parse the balanced JSON value that starts at `candidate[start]`, or null if it doesn't parse. */
function parseBalancedFrom(candidate: string, start: number, mode: ParseMode): unknown {
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
      if (depth === 0) return parseSpan(candidate.slice(start, i + 1), mode)
    }
  }
  return null
}

/**
 * Parse one balanced span: as written in the `strict` pass, with its string literals re-escaped
 * in the `repair` one (see {@link escapeControlCharsInStrings}). Null when it doesn't parse, which
 * sends the caller on to the next bracket rather than claiming a value nobody wrote.
 */
function parseSpan(span: string, mode: ParseMode): unknown {
  // A span carrying no raw control character cannot be repaired into anything a strict parse did
  // not already refuse, so the rewrite is skipped rather than run over every bracket in a long
  // reply (a tester quoting a code block puts hundreds of them in prose).
  if (mode === 'repair' && !hasRawControlChar(span)) return null
  try {
    return JSON.parse(mode === 'repair' ? escapeControlCharsInStrings(span) : span)
  } catch {
    return null
  }
}

/** Whether `span` holds any raw control character: the cheap gate on attempting a repair. */
function hasRawControlChar(span: string): boolean {
  for (let i = 0; i < span.length; i++) {
    if (span.charCodeAt(i) < 0x20) return true
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
 * Re-escape raw control characters that sit INSIDE a JSON string literal.
 *
 * `JSON.parse` rejects a literal newline in a string, and that is the malformation a model
 * reliably produces once a field is asked for as several lines (a review verdict laid out as
 * blocks, a rationale with a bullet list): it writes the layout it was told to write and drops
 * the `\n` escape. The reply is otherwise the verdict, so refusing it loses a whole review to a
 * quoting slip. Only characters inside a string are rewritten, so the structural whitespace
 * between tokens keeps its meaning and a genuinely broken reply still fails to parse.
 *
 * Copied in SLICES around each rewritten character rather than one character at a time: this runs
 * over a whole span per failing candidate bracket, and a reply that quotes a code block has many.
 * A span needing no rewrite therefore costs one pass and no allocation.
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
    // Only a control character needs rewriting; everything else (a surrogate pair included) is
    // carried by the slices, untouched.
    if (json.charCodeAt(i) >= 0x20) continue
    const escape = CONTROL_ESCAPES[ch] ?? `\\u${json.charCodeAt(i).toString(16).padStart(4, '0')}`
    out += json.slice(copiedTo, i) + escape
    copiedTo = i + 1
  }
  return out + json.slice(copiedTo)
}
