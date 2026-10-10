import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Reading a source tree AS CODE, for the coverage specs that CLASSIFY call sites
// (`runAdmission.coverage.spec.ts`, `intakeOrigin.coverage.spec.ts`).
//
// Those specs guard rules no typecheck can hold: a field that must stay optional, because one
// caller is genuinely entitled to the default. They work by asserting that a file passes a
// particular literal, so their whole value rests on matching what the file DOES rather than what
// it SAYS. A plain `source.includes(...)` cannot tell the two apart, and the difference is not
// academic: `RecurringPipelineService`'s `firePerTicket` documents ``intakeOrigin: 'tracker'`` in
// its own JSDoc, so deleting the value from the call site three lines down left the guard green.
// The near-miss the spec exists to catch was the one thing it could not see.
//
// So every read here goes through {@link stripComments}, and the specs match against code only.
// It also makes the INVERSE assertion usable: "this file must NOT set an origin" can now be
// written without forbidding the file from explaining why, which is the comment you most want at
// a call site that deliberately takes a default.
//
// A real lexer would be preferable and is not available: `typescript@7` ships only `version` from
// its package entry, with no compiler API to borrow a scanner from.
// ---------------------------------------------------------------------------

/**
 * Where the scanner is. `code` is also what a `${…}` interpolation re-enters, which is why the
 * frames form a stack rather than a single mode: a template may hold code holding a template.
 * `braces` counts the `{` opened inside a frame, so the `}` that closes the interpolation is
 * distinguishable from one closing an object or block within it.
 */
interface Frame {
  kind: 'code' | 'string' | 'template'
  quote?: string
  braces: number
}

/** One pass over a source file: the cursor, the emitted code, and the state stack. */
interface Scan {
  source: string
  out: string[]
  stack: Frame[]
  i: number
}

/**
 * `source` with its comments removed and everything else, string literals included, byte-for-byte
 * intact. Block comments collapse to a single space so `a/* x *\/b` cannot fuse into one token.
 *
 * Strings and template literals are tracked only so a `//` inside one is not mistaken for a
 * comment; their contents are emitted verbatim. Regex literals are NOT tracked (telling `/` apart
 * from division needs parse context), so a regex whose body contains a quote opens a spurious
 * string state. That state ends at the newline, and its only effect is that a trailing comment on
 * THAT line survives: the code text is preserved either way, which is the direction that matters.
 */
export function stripComments(source: string): string {
  const scan: Scan = { source, out: [], stack: [{ kind: 'code', braces: 0 }], i: 0 }
  while (scan.i < source.length) {
    const top = scan.stack[scan.stack.length - 1]!
    if (top.kind === 'string') stepString(scan, top)
    else if (top.kind === 'template') stepTemplate(scan, top)
    else stepCode(scan, top)
  }
  return scan.out.join('')
}

/** Emit `count` characters from the cursor unchanged. */
function emit(scan: Scan, count: number): void {
  scan.out.push(scan.source.slice(scan.i, scan.i + count))
  scan.i += count
}

/** Inside `'…'` / `"…"`. Everything is literal; only the closing quote (or a newline) ends it. */
function stepString(scan: Scan, top: Frame): void {
  const ch = scan.source[scan.i]!
  if (ch === '\\') {
    emit(scan, 2)
    return
  }
  emit(scan, 1)
  // A newline ends an unterminated string too, so one bad guess cannot swallow the file.
  if (ch === top.quote || ch === '\n') scan.stack.pop()
}

/** Inside a template literal. Only `${` (back to code) and the closing backtick are structural. */
function stepTemplate(scan: Scan, _top: Frame): void {
  const ch = scan.source[scan.i]!
  if (ch === '\\') {
    emit(scan, 2)
    return
  }
  if (ch === '`') {
    emit(scan, 1)
    scan.stack.pop()
    return
  }
  if (ch === '$' && scan.source[scan.i + 1] === '{') {
    emit(scan, 2)
    scan.stack.push({ kind: 'code', braces: 0 })
    return
  }
  emit(scan, 1)
}

/** Inside code: the only state where a comment is a comment. */
function stepCode(scan: Scan, top: Frame): void {
  const ch = scan.source[scan.i]!
  const next = scan.source[scan.i + 1]
  if (ch === '/' && (next === '/' || next === '*')) {
    skipComment(scan, next === '*')
    return
  }
  if (ch === "'" || ch === '"') {
    emit(scan, 1)
    scan.stack.push({ kind: 'string', quote: ch, braces: 0 })
    return
  }
  if (ch === '`') {
    emit(scan, 1)
    scan.stack.push({ kind: 'template', braces: 0 })
    return
  }
  if (ch === '{') top.braces++
  else if (ch === '}') {
    // The `}` that closes a `${` interpolation, rather than an object or block inside it.
    if (top.braces === 0 && scan.stack.length > 1) {
      emit(scan, 1)
      scan.stack.pop()
      return
    }
    if (top.braces > 0) top.braces--
  }
  emit(scan, 1)
}

/** Advance past a comment, emitting a space for a block one so it still separates two tokens. */
function skipComment(scan: Scan, block: boolean): void {
  if (!block) {
    while (scan.i < scan.source.length && scan.source[scan.i] !== '\n') scan.i++
    return
  }
  scan.i += 2
  while (
    scan.i < scan.source.length &&
    !(scan.source[scan.i] === '*' && scan.source[scan.i + 1] === '/')
  ) {
    scan.i++
  }
  scan.i = Math.min(scan.i + 2, scan.source.length)
  scan.out.push(' ')
}

/**
 * The comment-stripped source of every non-test `.ts` file under each root, keyed `pkg:rel`
 * (`server:modules/execution/ExecutionController.ts`).
 *
 * Read ONCE into a Map rather than re-read per assertion: a classification spec touches each
 * matched file several times, and the tree it walks is the whole of two packages.
 *
 * Test files are excluded on purpose. A spec that exercises a start path names the same call and
 * would otherwise arrive as a start path of its own, needing a classification that says nothing
 * about how the product behaves.
 */
export function loadCode(roots: Record<string, string>): Map<string, string> {
  const code = new Map<string, string>()
  for (const [pkg, root] of Object.entries(roots)) {
    for (const rel of walk(root)) {
      code.set(`${pkg}:${rel}`, stripComments(readFileSync(join(root, rel), 'utf8')))
    }
  }
  return code
}

/** Every non-test `.ts` under `dir`, as paths relative to it. */
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return walk(join(dir, entry.name), rel)
    if (!entry.name.endsWith('.ts')) return []
    return entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts') ? [] : [rel]
  })
}
