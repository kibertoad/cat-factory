#!/usr/bin/env node
// Bans corner radii that do not follow the theme in the SPA layer (issue #2251).
//
// The SCALE itself is fixed at the mechanism, not here. Nuxt UI rebuilds seven of Tailwind's
// radius steps on `--ui-radius`, and `app/assets/css/main.css` binds the last two spellings that
// sat outside that (`--radius`, which the bare `rounded` alias resolves through, and
// `--radius-4xl`). So EVERY `rounded-*` utility now follows a theme document's `radius`, and this
// guard has no opinion about which step a box picks. Two shapes still opt out, because both name a
// number instead of the scale:
//
//   1. An ARBITRARY value: `rounded-[10px]`, `rounded-t-[0.6rem]`, and Tailwind v4's
//      CSS-variable shorthand `rounded-(--x)`. Welded to one number the way a px font size is, and
//      unnameable besides. The SPA has none; the ban keeps it that way.
//   2. A raw `border-radius` DECLARATION in an absolute unit, in a stylesheet or a `<style>`
//      block, where no utility exists for rule 1 to catch. The per-corner longhands count
//      (`border-top-left-radius`, the logical `border-start-start-radius`), as does the JS
//      `borderRadius` / `'border-radius'` spelling a `:style` binding or an `element.style`
//      assignment uses.
//
// A raw declaration reaches the scale through `var(--ui-radius)`, optionally inside a `calc()`
// (`calc(var(--ui-radius) * 2)` is the `rounded-lg` step; `calc(var(--ui-radius) - 1px)` is an
// inner box kept concentric with its parent, and follows the theme just as well). It must NOT name
// a `--radius-*` theme variable: Tailwind emits those only where the COMPILED stylesheet graph
// references them, so one works until the last reference elsewhere is deleted and then silently
// computes to 0. `--ui-radius` is an ordinary custom property on `:root` and is always there, in a
// scoped SFC `<style>` block too.
//
// Exempt, because neither is a step that should scale: `rounded-full` / `rounded-none`, and the
// CSS spellings of the same intent (`9999px`, `50%`, `0`).
//
// Rule 1 needs no notion of where a class list lives, because `rounded-[` and `rounded-(` are not
// English: an earlier draft read the bare `rounded` token and had to tell a class list from prose,
// which cost a quote-context scanner, a wrapped-attribute state machine and five rounds of holes.
// Comments are still stripped, so a line ABOUT the rule is not read as an application of it.
//
// Policy: ZERO offenders, no ratchet. A line that genuinely needs a fixed radius says why with a
// `radius-literal-ok:` comment, on that line or the one before it; nothing in the tree needs one.
//
// Usage:  node scripts/check-frontend-radius.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer AND the deployment template, the same two roots `check-frontend-palette.mjs` scans:
// `deploy/frontend` is what a consumer copies, so a fixed radius there ships as the pattern to copy.
const SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

// An arbitrary radius in either v4 syntax, behind any side or corner prefix. `(?<![\w-])` is a LEFT
// boundary, so `group-rounded-[…]` does not match on a substring. Neither bracket form is a word,
// so this needs no quote context: prose never contains `rounded-[` or `rounded-(`.
const ARBITRARY_UTILITY = /(?<![\w-])rounded(?:-[a-z]+)*-(?:\[[^\]]*\]|\([^)]*\))/g
// A raw declaration's VALUE, up to the `;` or `}` that ends it. The per-corner longhands are
// claimed too, physical and logical alike: `border-top-left-radius: 4px` is the same defect as the
// shorthand and contains no `border-radius:` substring for a shorthand-only pattern to find. CSS
// allows a space before the colon, and a Vue `:style` object may write the kebab-case name as a
// QUOTED key, so both sit between the name and the value.
const DECLARATION =
  /border-(?:(?:top|bottom|start|end)-(?:left|right|start|end)-)?radius["']?\s*:\s*([^;}]*)/g
// The same declaration spelled as a JS style property, which is how a Vue `:style` binding and a
// direct `element.style` assignment write it. A camelCase name contains no `border-radius`
// substring for `DECLARATION` to find. The separator is `:` in an object literal and `=` in an
// assignment, and a JS value ends at a `,` as well as a `;` or a `}`.
const STYLE_PROPERTY =
  /border(?:(?:Top|Bottom|Start|End)(?:Left|Right|Start|End))?Radius\s*[:=]\s*([^,;}]*)/g
// `9999px` and friends are `rounded-full` spelled in CSS: a pill, not a step. They are removed from
// the value rather than suppressing the whole line, so the `8px` in `50% 50% 8px 8px` still counts.
// The left boundary keeps the removal from reaching INSIDE a longer number: without it `4999px`
// loses its `999px` and the leftover `4` carries no unit, so a real literal reads as clean.
const PILL_VALUE = /(?<![\d.])(?:9999px|999px|100vmax|50%|100%)/g
// Every absolute and font-relative length, not px alone: `4pt` is as welded as `4px`, and a `rem`
// or `em` radius tracks a FONT SIZE, which is a different theme knob. `0` and `50%` carry no unit
// and so never match.
const ABSOLUTE = /\d*\.?\d+(?:px|pt|pc|in|cm|mm|q|rem|em|ch|ex)\b/i
// The scale, however the value reaches it: `var(--ui-radius)` alone or inside a `calc()`.
const UI_RADIUS = /var\(\s*--ui-radius\b/
// A `--radius-*` theme variable (and the bare `--radius`). Correct TODAY and latently broken: see
// the header. `--ui-radius` does not match, its `--ui-` prefix sitting where `--radius` would start.
const RADIUS_VAR = /var\(\s*--radius(?:-[A-Za-z0-9]+)?\s*[,)]/
const LITERAL_OK = 'radius-literal-ok:'
// A line that opens with a comment marker is prose about the rule, not an application of it. Two
// characters look like markers and are NOT: in a `.css` file a leading `#` is an ID selector, and a
// leading `*` is the UNIVERSAL selector, so `* p { border-radius: 4px }` is a rule to check and not
// a JSDoc continuation. What tells them apart is what follows: a selector continues into a
// combinator (whitespace included, which is the descendant combinator), a `{`, a `,` or a class /
// id / attribute / pseudo, where a JSDoc continuation runs straight into prose.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*(?!\s*[,{>+~*]|\s+[A-Za-z.#[:*]|[:.#[>+~*])|<!--)/
// A trailing comment is prose too, and `COMMENT_LINE` only sees a line that OPENS with one. `//`
// opens a comment only after whitespace or at the start of the line: in `https://...` it follows a
// colon. A CLOSED block or HTML comment is blanked wherever it sits, so code after it still reads.
const TRAILING_COMMENT = /(?:^|\s)\/\/.*$|\/\*.*?\*\/|<!--.*?-->/g

/** Every non-scaling radius on a CODE line (deduplicated), or [] for a clean or exempted line. The
 * `radius-literal-ok:` waiver is honoured on the line itself OR on the line before it (the
 * `eslint-disable-next-line` shape), so a waiver never forces the class off its own line. Pure, so
 * the companion test can drive it with fixture strings. */
export function findFixedRadii(line, prevLine = '') {
  if (line.includes(LITERAL_OK) || prevLine.includes(LITERAL_OK)) return []

  const code = stripComments(line)
  if (COMMENT_LINE.test(code) || !code.trim()) return []

  const found = [...(code.match(ARBITRARY_UTILITY) ?? [])]
  for (const pattern of [DECLARATION, STYLE_PROPERTY]) {
    for (const [match, value] of code.matchAll(pattern)) {
      const property = match.match(/^[^:=]*/)[0].trim().replaceAll(/["']/g, '')
      const trimmed = value.trim().replace(/^["']|["']\s*$/g, '')
      if (isFixedValue(trimmed)) found.push(`${property}: ${trimmed}`)
    }
  }

  return [...new Set(found)]
}

/** Whether a declaration's VALUE fails to follow `--ui-radius`: a `--radius-*` theme variable
 * (correct today, silently 0 once nothing else references it), or an absolute length outside the
 * pill spellings that the scale is not part of. A `calc()` AROUND `var(--ui-radius)` may carry a
 * literal, because the result still moves with the theme. */
function isFixedValue(value) {
  if (RADIUS_VAR.test(value)) return true
  if (UI_RADIUS.test(value)) return false
  return ABSOLUTE.test(value.replaceAll(PILL_VALUE, ''))
}

/** A line with its comments blanked, so a radius a developer WROTE ABOUT is not read as one they
 * applied. Exported for the companion test; `main()` reaches it through `findFixedRadii`. */
export function stripComments(line) {
  return line.replaceAll(TRAILING_COMMENT, ' ')
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) {
      yield* sourceFiles(abs)
    } else if (
      abs.endsWith('.vue') ||
      abs.endsWith('.ts') ||
      abs.endsWith('.css') ||
      abs.endsWith('.html')
    ) {
      // Beyond `.vue`: a class list can be built in a composable (`.ts`, as `ImageCompare.vue`'s
      // canvas class is), applied with `@apply` (`.css`), and `spa-loading-template.html` is
      // hand-written CSS that renders before the app does.
      yield abs
    }
  }
}

function main() {
  const offenders = []
  for (const file of SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)])) {
    const rel = relative(repoRoot, file).replaceAll('\\', '/')
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const matches = findFixedRadii(line, lines[i - 1] ?? '')
      if (matches.length) offenders.push({ file: rel, line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Corner radii that do not follow the theme are banned in the SPA (issue #2251).')
    console.error(
      'Every `rounded-*` utility derives from `--ui-radius`, so a theme document`s `radius`\n' +
        'reaches it: pick the NAMED step you want and nothing else is needed. An arbitrary value\n' +
        '(`rounded-[10px]`, `rounded-(--x)`) is welded to one number instead.\n' +
        'In CSS, write `border-radius: var(--ui-radius)` or a `calc()` of it\n' +
        '(`calc(var(--ui-radius) * 2)` is the `rounded-lg` step). Never a `--radius-*` theme\n' +
        'variable: Tailwind emits those only where the compiled stylesheet references them, so one\n' +
        'works until the last other reference goes and then computes to 0.\n' +
        '`rounded-full`, `rounded-none`, `9999px`, `50%` and `0` are fine.\n' +
        'A line that genuinely needs a fixed radius says why with a `radius-literal-ok:` comment, on\n' +
        'that line or the one above. See frontend/app/README.md, "Radius through the theme scale".\n',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a radius that ignores the theme.`)
    process.exit(1)
  }

  console.log('check-frontend-radius: every corner radius in the SPA follows --ui-radius.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
