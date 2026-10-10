// The tree walk and the comment rule shared by the SPA guards (`check-frontend-palette.mjs`,
// `check-frontend-radius.mjs`, `check-frontend-type-scale.mjs`). The three must scan the same files
// with the same idea of what a comment is, so both live here once.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The layer AND the deployment template: `deploy/frontend` is what a consumer copies, so an
// offender there ships as the pattern to copy.
export const SPA_SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

// A class list can be built in a composable (`.ts`) or applied with `@apply` (`.css`), so the scan
// reads more than `.vue`. `.html` is opt-in: `spa-loading-template.html` is hand-written CSS that
// renders before the app does, and a guard decides for itself whether that shell is in scope.
const BASE_EXTENSIONS = ['.vue', '.ts', '.css']

/** Every scanned source file under the SPA roots, as `{ abs, rel }` with a forward-slash `rel`. */
export function* spaSourceFiles({ html = false } = {}) {
  const extensions = html ? [...BASE_EXTENSIONS, '.html'] : BASE_EXTENSIONS
  for (const root of SPA_SCAN_ROOTS) yield* walk(root, extensions)
}

function* walk(dirAbs, extensions) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) {
      yield* walk(abs, extensions)
    } else if (extensions.some((ext) => abs.endsWith(ext))) {
      yield { abs, rel: relative(repoRoot, abs).replaceAll('\\', '/') }
    }
  }
}

/** A file's lines, each as `{ raw, code, prev }`: `raw` is the line as written, `code` is the same
 * line with every comment blanked, and `prev` is the raw line before it (where a guard's waiver may
 * sit). A guard matches against `code`, so a line ABOUT a rule is never read as an application of
 * it, and reads its waiver from `raw` / `prev`, because a waiver is itself a comment.
 *
 * Comments are tracked ACROSS lines. A line opening with `*` is a comment only inside a block the
 * scan has seen open: outside one it is the CSS universal selector (`* { ... }`), which is code.
 * A leading `#` is never a comment marker, being an ID selector in CSS.
 *
 * `//` opens a comment only at the start of a line or after whitespace, so `https://x` stays code.
 * A file that ends inside a block or HTML comment THROWS: the likeliest cause is a `/*` inside a
 * string (a glob such as `'src/**' + '/*.vue'`), and silently blanking the rest of the file would
 * hide every offender after it. */
export function codeLines(text, file = '<input>') {
  const state = { block: false, html: false }
  const lines = text.split('\n')
  const out = lines.map((raw, i) => ({
    raw,
    code: blankComments(raw, state),
    prev: lines[i - 1] ?? '',
  }))
  if (state.block || state.html) {
    const opener = state.block ? '/*' : '<!--'
    throw new Error(
      `${file}: a ${opener} comment is never closed, so the SPA guards cannot tell code from ` +
        'prose after it. If the opener sits inside a string, split the string.',
    )
  }
  return out
}

/** Whether the module at `moduleUrl` is the CLI entry point. A guard runs its filesystem scan only
 * then, so importing it for tests has no side effects. `process.argv[1]` is undefined in the REPL
 * and under `node -e`, where an import must still work. */
export function isCliEntry(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(process.argv[1]).href
}

/** Read and split one file through `codeLines`. */
export function readCodeLines({ abs, rel }) {
  return codeLines(readFileSync(abs, 'utf8'), rel)
}

const OPENERS = /\/\*|<!--|(?:^|(?<=\s))\/\//g

function blankComments(line, state) {
  let code = ''
  let i = 0
  while (i < line.length) {
    if (state.block || state.html) {
      const closer = state.block ? '*/' : '-->'
      const end = line.indexOf(closer, i)
      if (end < 0) return code
      i = end + closer.length
      code += ' '
      state.block = false
      state.html = false
      continue
    }
    OPENERS.lastIndex = i
    const open = OPENERS.exec(line)
    if (!open) return code + line.slice(i)
    code += line.slice(i, open.index)
    if (open[0] === '//') return code
    state.block = open[0] === '/*'
    state.html = open[0] === '<!--'
    i = open.index + open[0].length
  }
  return code
}
