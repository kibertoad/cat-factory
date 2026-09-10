// Detection logic for the inline-model-scope guard (`check-inline-model-scope.mjs`), kept apart
// from the file walking so the part with the judgement in it is unit-testable: see
// `inline-model-scope.test.mjs`. This module is pure: source in, findings out.
//
// WHAT IT GUARDS. Every inline LLM call resolves a credential pool from a `ModelScope`, and the
// scope decides three things: which API keys are drawn on, whose local model endpoints are
// visible, and whether an individual-usage subscription (a Claude preset) can be leased at all.
// A caller that hand-builds `{ workspaceId }` while holding a run or a user drops the tiers it
// held, and NOTHING fails: the call resolves, answers, and quietly runs on the deployment's
// routing default instead of the model the workspace asked for. Six callers had done exactly
// that by the time anyone noticed, and what gave it away was a token bill.
//
// So the object literal is banned at the call site. A caller states what it HAS through kernel's
// `resolveInlineScope`, whose subject is a discriminated union, and `kind: 'workspace'` becomes a
// written claim a reviewer can check against the caller's own inputs rather than the shape you
// get by forgetting.
//
// The comment/string MASKING is borrowed wholesale from `silent-catch.mjs`, and for the same
// reason it exists there: matching against raw source gets "is this inside a comment" wrong in
// both directions, and the false negative is the one that matters.

/** Word-boundary tokens after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete'])

/**
 * The index of the `/` closing a regex literal that opens at `open`, or -1 when the line ends
 * first (in which case the `/` was division after all, and nothing may be blanked).
 *
 * A character class suspends the closing `/`, which is why `[` / `]` are tracked: `/[a/b]/` ends
 * at the last slash, not the middle one.
 */
function regexEnd(src, open) {
  let inClass = false
  for (let k = open + 1; k < src.length && src[k] !== '\n'; k += 1) {
    if (src[k] === '\\') {
      k += 1
      continue
    }
    if (src[k] === '[') inClass = true
    else if (src[k] === ']') inClass = false
    else if (src[k] === '/' && !inClass) return k
  }
  return -1
}

/**
 * Blank out every comment and string/template literal, preserving offsets and newlines.
 *
 * Offsets are preserved so a finding's index still points into the ORIGINAL text, which is what
 * lets the escape-hatch annotation be read back off the real source.
 */
export function maskLiterals(src) {
  const out = Array.from(src)
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  const prevToken = (at) => {
    let k = at - 1
    while (k >= 0 && /\s/.test(src[k])) k -= 1
    if (k < 0) return ''
    if (/[\w$]/.test(src[k])) {
      let end = k + 1
      while (k >= 0 && /[\w$]/.test(src[k])) k -= 1
      return src.slice(k + 1, end)
    }
    return src[k]
  }
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      let end = src.indexOf('\n', i)
      if (end === -1) end = src.length
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1
      while (k < src.length) {
        if (src[k] === '\\') {
          k += 2
          continue
        }
        if (src[k] === c) break
        k += 1
      }
      blank(i + 1, k)
      i = k + 1
      continue
    }
    if (c === '/') {
      // A regex literal only where a `/` cannot be division. Getting this wrong would blank real
      // code, so the conservative test is "the previous token cannot end an expression".
      const prev = prevToken(i)
      const opensRegex =
        prev === '' || REGEX_PRECEDERS.has(prev) || /[=(,:[!&|?{};+\-*%<>~^]/.test(prev)
      const close = opensRegex ? regexEnd(src, i) : -1
      if (close !== -1) {
        blank(i + 1, close)
        i = close + 1
        continue
      }
    }
    i += 1
  }
  return out.join('')
}

/** The two ways a credential pool is resolved from a scope. */
const CALL_SITE = /(?:\.forScope|resolveScopedModelProvider)\s*\(\s*/g

/** Reading a scope through the seam, in any of its spellings. */
const SEAM = /resolveInlineScope\s*\(/

/** `// inline-scope-ok: <reason>` on the line before, with a reason after the colon. */
const ANNOTATION = /\/\/\s*inline-scope-ok:\s*\S/

const NEWLINE = String.fromCharCode(10)

/** 1-indexed line number of a character offset. */
function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === NEWLINE) line += 1
  return line
}

/**
 * Whether the contiguous `//` comment block directly above `line` (1-indexed) carries the escape
 * hatch.
 *
 * The whole block rather than only the line immediately above, because a reason worth stating is
 * usually two sentences and lands on the FIRST of them. Requiring the marker on the last line
 * would make the guard reject a correctly-annotated site for its line wrapping, which trains
 * people to write a worse reason.
 */
function annotatedAbove(src, line) {
  const lines = src.split(NEWLINE)
  for (let i = line - 2; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim()
    if (!text.startsWith('//')) return false
    if (ANNOTATION.test(text)) return true
  }
  return false
}

/**
 * Every scope resolution in a file that neither states its subject through the seam nor annotates
 * why it does not.
 *
 * Two reasons, checked per CALL SITE rather than per file so the escape hatch applies to each:
 *
 *  - `literal`: an object literal handed straight to the call. This is the shape every one of the
 *    known gaps was written in, and the one a reviewer skims past.
 *  - `unseamed`: something else (a variable, a helper call) in a file that never mentions the
 *    seam at all. Following the variable would need real analysis; requiring the file to use the
 *    seam SOMEWHERE is the cheap half that closes the indirection, and the residual shape (a
 *    literal assigned to a variable in a file that also uses the seam) is one a reviewer sees.
 *
 * `seamOptional` drops the SECOND check only, for the handful of files that define or transport
 * the seam rather than consuming it (the port itself, the resolver decorators). Those legitimately
 * never call `resolveInlineScope`, being handed a scope and forwarding it. They are also ordinary
 * code that can hand-build a literal, and the file where activation scopes are CONSTRUCTED is the
 * last one worth agreeing never to look at, so the literal check still runs.
 */
export function findUnseamedScopes(src, { seamOptional = false } = {}) {
  const masked = maskLiterals(src)
  const seamed = SEAM.test(masked)
  const findings = []
  for (const match of masked.matchAll(CALL_SITE)) {
    const line = lineOf(src, match.index)
    if (annotatedAbove(src, line)) continue
    const argStart = masked[match.index + match[0].length]
    const literal = argStart === '{'
    if (!literal && (seamed || seamOptional)) continue
    findings.push({
      line,
      reason: literal ? 'literal' : 'unseamed',
      snippet: (src.split(NEWLINE)[line - 1] ?? '').trim(),
    })
  }
  return findings
}
