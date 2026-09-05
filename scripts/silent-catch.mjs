// Detection logic for the silent-promise-drop guard (`check-silent-catch.mjs`), kept apart from
// the file walking so the part with the judgement in it is unit-testable — see
// `silent-catch.test.mjs`. This module is pure: string in, findings out.
//
// The naive version of this guard matched the banned idiom against the raw source and then asked
// "is this match inside a comment?" with a prefix heuristic. That gets the answer wrong in both
// directions, and the false NEGATIVE is the one that matters: any `//` earlier on the line — a URL
// in a string literal being the obvious case — made the whole line look like a comment, so
//
//     void fetch('https://example.com/x').catch(() => {})
//
// sailed straight past the guard whose entire job is to catch it. A guard with a hole in the exact
// shape of the thing it guards against is worse than no guard, because it is trusted.
//
// So instead of asking after the fact, the source is MASKED first: every comment and string
// literal has its content blanked out, preserving offsets and newlines. A match against the masked
// text cannot be inside a comment or a string, because there is nothing left in there to match.
// Annotations are then read back off the ORIGINAL text at the same offsets.
//
// Masking also subsumes a case the raw-match version could not express at all: an "empty" handler
// whose body holds only a comment (`.catch(() => { /* ignored */ })`) masks down to `{ }`, so it
// is caught by the same `{\s*}` shape as the bare one. That form is the likeliest way the idiom
// grows back — it lets an author document a swallow without the reason the escape hatch demands.

/** Word-boundary tokens after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

/** Marks a stack entry as "inside a template literal's TEXT", vs. a number for `${}` brace depth. */
const TEMPLATE_TEXT = Symbol('template-text')

/**
 * Whether the `/` at `i` opens a regex literal rather than being a division operator, judged by
 * the preceding significant token. Regex literals have to be recognised because they routinely
 * contain quotes (`/["']/`) — mistaking one for the start of a string literal would mask the code
 * after it, and masked code is code the guard no longer sees.
 *
 * `masked` is the partially-masked output, so a comment already blanked to spaces is skipped over
 * as whitespace and the real preceding token is found underneath it.
 */
function opensRegexLiteral(masked, i) {
  let j = i - 1
  while (j >= 0 && /\s/.test(masked[j])) j--
  if (j < 0) return true
  const ch = masked[j]
  // A value ends here (`x`, `1`, `)`, `]`) ⇒ division — unless the value is a keyword that takes
  // an expression, in which case it is a regex.
  if (ch === ')' || ch === ']') return false
  if (/[\w$]/.test(ch)) {
    let k = j
    while (k >= 0 && /[\w$]/.test(masked[k])) k--
    return REGEX_PRECEDING_KEYWORDS.has(masked.slice(k + 1, j + 1).join(''))
  }
  return true
}

/** Mask a `//` line comment whole; returns the index of its newline (or EOF). */
function maskLineComment(source, i, blank) {
  const end = source.indexOf('\n', i)
  const stop = end === -1 ? source.length : end
  blank(i, stop)
  return stop
}

/** Mask a block comment whole, delimiters included, so no stray `/` survives to be re-scanned. */
function maskBlockComment(source, i, blank) {
  const end = source.indexOf('*/', i + 2)
  const stop = end === -1 ? source.length : end + 2
  blank(i, stop)
  return stop
}

/**
 * Mask a regex literal's body, returning the index past its closing `/`. Returns null when it
 * never closes on this line — the `/` was a division after all, and masking on that guess would
 * blank the rest of the file.
 */
function maskRegexLiteral(source, i, blank) {
  let j = i + 1
  let inClass = false
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n') return null
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      blank(i + 1, j)
      return j + 1
    }
    j++
  }
  return null
}

/**
 * Mask a `'`/`"` string's content, keeping its delimiters. An unterminated string stops at the
 * newline rather than swallowing the rest of the file.
 */
function maskStringLiteral(source, i, blank) {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === quote || c === '\n') break
    j++
  }
  blank(i + 1, j)
  return source[j] === quote ? j + 1 : j
}

/**
 * Advance one character of a template literal's TEXT: mask it, or transition — a backtick closes
 * the literal, `${` re-enters CODE mode with a brace depth of 0.
 */
function stepTemplateText(source, i, templates, blank) {
  const ch = source[i]
  if (ch === '\\') {
    blank(i, i + 2)
    return i + 2
  }
  if (ch === '`') {
    templates.pop()
    return i + 1
  }
  if (ch === '$' && source[i + 1] === '{') {
    templates[templates.length - 1] = 0
    return i + 2
  }
  blank(i, i + 1)
  return i + 1
}

/** Track `{}` depth inside a `${…}` interpolation, so its closing brace re-enters template text. */
function trackInterpolationBraces(ch, templates) {
  const top = templates.at(-1)
  if (typeof top !== 'number') return
  if (ch === '{') templates[templates.length - 1] = top + 1
  else if (ch === '}') templates[templates.length - 1] = top === 0 ? TEMPLATE_TEXT : top - 1
}

/**
 * Blank the CONTENT of every comment, string literal, template literal and regex literal, leaving
 * the source's length and line structure untouched so an index into the result still addresses the
 * same character of the original. Delimiters are kept; only what is between them is spaced out.
 *
 * Template interpolations (`${…}`) are NOT masked — they hold real code, and a `.catch(() => {})`
 * inside one is a real drop — so the scanner tracks brace depth and re-enters code mode for them.
 *
 * Returns the masked characters as an array: the scan reads back over its own output to judge
 * regex-vs-division, and {@link maskCommentsAndStrings} joins it for callers.
 */
function maskToChars(source) {
  const out = [...source]
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  /** One entry per open template literal: TEMPLATE_TEXT in its text, or a `${}` brace depth. */
  const templates = []

  let i = 0
  while (i < source.length) {
    if (templates.at(-1) === TEMPLATE_TEXT) {
      i = stepTemplateText(source, i, templates, blank)
      continue
    }
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      i = maskLineComment(source, i, blank)
    } else if (ch === '/' && source[i + 1] === '*') {
      i = maskBlockComment(source, i, blank)
    } else if (ch === '/' && opensRegexLiteral(out, i)) {
      i = maskRegexLiteral(source, i, blank) ?? i + 1
    } else if (ch === "'" || ch === '"') {
      i = maskStringLiteral(source, i, blank)
    } else if (ch === '`') {
      templates.push(TEMPLATE_TEXT)
      i++
    } else {
      trackInterpolationBraces(ch, templates)
      i++
    }
  }
  return out
}

/** {@link maskToChars} as a string, for callers that just want the masked source. */
export function maskCommentsAndStrings(source) {
  return maskToChars(source).join('')
}

const PARAMS = String.raw`\(\s*[^()]*\)`
/** `() =>`, `(e) =>`, `(e: unknown) =>`, `e =>`, each optionally `async`. */
const ARROW_HEAD = String.raw`(?:async\s+)?(?:${PARAMS}|[\w$]+)\s*=>`
/** `function () `, `function named(e) `, each optionally `async`. */
const FUNCTION_HEAD = String.raw`(?:async\s+)?function\s*[\w$]*\s*${PARAMS}`

/**
 * The banned idiom: a `.catch` whose handler body is empty once comments are masked away, however
 * the handler itself is spelled. Written as a regex over masked text rather than a parse because
 * the shape is fixed and this runs on every PR.
 *
 * `.catch(noop)` and friends are deliberately NOT matched: whether a named function is empty is
 * not a question this file can answer, and guessing would make the guard unpredictable.
 */
const SILENT_CATCH = new RegExp(
  String.raw`\.catch\(\s*(?:${ARROW_HEAD}|${FUNCTION_HEAD})\s*\{\s*\}\s*\)`,
  'g',
)

/** An opt-out marker with a stated reason, e.g. `// silent-catch-ok: <why>`. */
const ALLOW_MARKER = /\/\/\s*silent-catch-ok:\s*\S/

/**
 * Whether the CONTIGUOUS `//` comment block directly above the drop carries the opt-out marker.
 * A block rather than a single line, so a reason that needs two lines to be a real sentence still
 * counts; a blank line or any code ends the block, so the marker can't be inherited from afar.
 * `linesBefore` is every line preceding the drop's own line, plus the empty trailing element the
 * slice-and-split leaves behind.
 */
function isAnnotated(linesBefore) {
  for (let i = linesBefore.length - 2; i >= 0; i--) {
    const line = linesBefore[i]?.trim() ?? ''
    if (!line.startsWith('//')) return false
    if (ALLOW_MARKER.test(line)) return true
  }
  return false
}

/**
 * Every un-annotated silent promise drop in `source`, as 1-based line numbers.
 *
 * Detection runs against the masked text (so a match can never be a comment or a string) while
 * annotations are read off the original at the same offsets (so the marker, which IS a comment,
 * is still visible).
 */
export function findSilentCatches(source) {
  const masked = maskToChars(source).join('')
  const found = []
  for (const match of masked.matchAll(SILENT_CATCH)) {
    const lineStart = masked.lastIndexOf('\n', match.index) + 1
    const linesBefore = source.slice(0, lineStart).split('\n')
    if (isAnnotated(linesBefore)) continue
    found.push(linesBefore.length)
  }
  return found
}
