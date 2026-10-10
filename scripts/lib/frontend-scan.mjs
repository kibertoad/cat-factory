// The tree walk, the comment rule, the template reader and the waiver rules shared by the SPA
// guards (`check-frontend-palette.mjs`, `check-frontend-radius.mjs`, `check-frontend-type-scale.mjs`,
// `check-frontend-primitives.mjs`, `check-frontend-variants.mjs`). They must scan the same files
// with the same idea of what a comment, an opening tag and a waiver are, so each lives here once.

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

// How far an opening tag is followed for its attributes. The longest in the tree is well under
// this; the cap is only so a file with an unbalanced `<` cannot make the scan quadratic.
export const MAX_TAG_LINES = 40

/**
 * The opening tag that starts at `from` on `lines[index]`, up to its first `>`.
 *
 * A guard that reads ATTRIBUTES has to read the whole tag, and the formatter breaks any tag
 * carrying more than a couple of them across lines. Reading one line saw only the tags short
 * enough to fit on one, which is not the shape this repo writes: when the primitives guard read
 * one line, every `<a href>` and every `IconButton` in the SPA was wrapped, so its attribute rules
 * matched nothing at all.
 *
 * A `>` inside a QUOTED attribute value does not end the tag, because that `>` is how this tree
 * writes a condition: `v-if="total > 1"`, `v-if="s.depth >= 2"`, `v-if="x.length > 0"`. Ending
 * there truncated the tag before the attribute a guard was looking for, so the rule matched
 * nothing at exactly the sites it exists for. The quote state carries ACROSS lines: the
 * formatter breaks a long binding expression mid-value.
 */
export function openingTag(lines, index, from = 0) {
  let text = ''
  let quote = null
  for (let i = index; i < lines.length && i - index < MAX_TAG_LINES; i++) {
    const slice = i === index ? lines[i].slice(from) : lines[i]
    for (let c = 0; c < slice.length; c++) {
      const char = slice[c]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        return text + slice.slice(0, c + 1)
      }
    }
    text += `${slice}\n`
  }
  return text
}

/**
 * The template half of a `.vue` file, with the script and style blocks and the HTML comments
 * blanked out so offsets (and therefore line numbers) are preserved.
 *
 * Blanking rather than slicing is what makes `<template #slot>` safe: a `.vue` file nests template
 * tags for named slots, so matching the outer pair non-greedily stops at the first inner close and
 * silently skips everything after it.
 */
export function templateHalf(source) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  return source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
}

/**
 * Whether a LINE carries the waiver `marker`, on itself or on the line before it. The line-scoped
 * waiver every guard that matches a line uses, so its rule lives in one place.
 */
export function isWaived(line, prevLine, marker) {
  return line.includes(marker) || prevLine.includes(marker)
}

/**
 * Whether the line directly above a TAG is a comment carrying the waiver `marker`. A tag-scoped
 * waiver: unlike {@link isWaived} it cannot leak onto a second tag that starts on the same line or
 * the one after, because it has to sit on its own line, above the tag it justifies.
 */
export function isWaivedAbove(prevLine, marker) {
  const trimmed = prevLine.trim()
  return (trimmed.startsWith('<!--') || trimmed.startsWith('//')) && trimmed.includes(marker)
}

// Elements that never have children, so they open no frame in {@link walkTemplate}.
const VOID_TAGS = new Set([
  'area',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'wbr',
])

/** `u-button` → `UButton`; a PascalCase name passes through. Vue resolves both to one component. */
export function componentName(tagName) {
  return tagName.includes('-')
    ? tagName.replace(/(^|-)([a-z])/g, (_, __, char) => char.toUpperCase())
    : tagName
}

/**
 * Walk the element tree of a `.vue` source's TEMPLATE half, calling `open(node, ancestors)` for
 * every opening tag and `close(node)` when it ends. A node is `{ name, tag, index, line,
 * selfClosing, data }`: `name` normalised by {@link componentName}, `tag` the whole opening tag,
 * `line` 1-based, `data` a scratch object the caller owns. `ancestors` is the open chain, outermost
 * first.
 *
 * Comments, the script and style blocks, and `{{ … }}` mustaches are blanked first, and the scan
 * resumes AFTER each opening tag, so a `<` inside a binding (`Array<Item>`) or an expression
 * (`n<max`) is never read as an element. A stray closing tag closes nothing.
 */
export function walkTemplate(source, { open = () => {}, close = () => {} }) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  const text = templateHalf(source).replace(/\{\{[\s\S]*?\}\}/g, blank)
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineOf = (index) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const stack = []
  const tagRe = /<(\/?)([A-Za-z][\w.-]*)/g
  let m
  while ((m = tagRe.exec(text))) {
    const name = componentName(m[2])
    if (m[1]) {
      const at = stack.findLastIndex((node) => node.name === name)
      if (at >= 0) while (stack.length > at) close(stack.pop())
      continue
    }
    const tag = tagAt(text, m.index)
    tagRe.lastIndex = m.index + tag.length
    const selfClosing = tag.trimEnd().endsWith('/>') || VOID_TAGS.has(m[2].toLowerCase())
    const node = { name, tag, index: m.index, line: lineOf(m.index), selfClosing, data: {} }
    open(node, stack)
    if (selfClosing) close(node)
    else stack.push(node)
  }
  while (stack.length) close(stack.pop())
}

/** The opening tag starting at `from`, up to its first `>` outside a quoted value. */
function tagAt(text, from) {
  let quote = null
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return text.slice(from, i + 1)
    }
  }
  return text.slice(from)
}
