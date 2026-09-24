#!/usr/bin/env node
// Bans font-size LITERALS in the SPA layer (issue #2248).
//
// The SPA sizes text through named steps and nothing else: Tailwind's own (`text-xs` and up) plus
// the two the app declares below them in `frontend/app/app/assets/css/type.css` (`text-2xs` at
// 0.6875rem, `text-3xs` at 0.625rem). An arbitrary-value utility (`text-[11px]`) opts out of that
// system in two ways, and the second is the one that bites:
//
//   1. It is unnameable. Nuxt UI sizes its own components on the rem scale, so a `UBadge size="sm"`
//      beside a `text-[11px]` label is sized by a system the label cannot refer to, and the two
//      drift apart every time either moves.
//   2. It does not scale with the theme. A theme document's `fontSize` is applied as
//      `html[data-theme] { font-size: Npx }` (`app/utils/theme/css.ts`). Every rem-based step
//      follows it; a px literal does not. Before this guard the SPA carried 1653 of them, so a user
//      who raised the font size watched Nuxt UI's components grow while the app's own text sat
//      still. That is the bug the guard exists to keep fixed.
//
// A `rem` literal (`text-[0.6875rem]`) scales but is still unnameable, and it is how the px form
// comes back wearing a hat, so it is banned on the same line.
//
// SCOPE: font size, however it is spelled. Banning one spelling teaches the next contributor the
// others, so all four are claimed: `text-[11px]`, the same value with an explicit type hint
// (`text-[length:11px]`), the arbitrary-PROPERTY form (`[font-size:11px]`), which carries no
// `text-` prefix at all, and a raw `font-size: 11px` declaration in a stylesheet or a `<style>`
// block. The raw form is claimed in px only: a `rem` or `em` declaration already follows the root
// the theme sets.
//
// Nothing else. A width, a height or a gap in an arbitrary value is a layout decision this guard
// has no opinion about, and `leading-[...]` is line height, which #2248 left alone on purpose (the
// two named steps declare no paired line height, so a block that wants a specific rhythm still
// says so).
//
// Policy: ZERO offenders, no ratchet. The migration left none, so the moment a diff adds one this
// fails. A line that genuinely needs a literal says why with a `type-literal-ok:` comment, on that
// line or the one before it; nothing in the tree needs one today.
//
// Usage:  node scripts/check-frontend-type-scale.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer AND the deployment template, the same two roots `check-frontend-palette.mjs` scans:
// `deploy/frontend` is what a consumer copies, so a literal there ships as the pattern to copy.
const SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

// The four spellings, sharing one length pattern. A variant (`sm:`, `hover:`) precedes any of them
// and does not affect the match.
//
// `(?<![\w-])` is a LEFT boundary so a utility that merely ENDS in `text-` does not match, and so
// `[font-size:…]` is not claimed out of the middle of a longer token.
//
// The unit set is deliberately NOT open. `text-[...]` is also how an arbitrary COLOUR is written
// (`text-[#f59e0b]`, `text-[var(--x)]`), and colour is `check-frontend-palette.mjs`'s to judge, not
// this one's: two guards reporting the same line would teach a contributor to fix it twice. Only
// the absolute length units a font size is actually written in are claimed here.
const LENGTH = String.raw`\d*\.?\d+(?:px|rem|em|pt)`
const TYPE_LITERAL = new RegExp(
  String.raw`(?<![\w-])(?:text-\[(?:length:)?${LENGTH}\]|\[font-size:${LENGTH}\]|font-size:\s*\d*\.?\d+px)`,
  'g',
)
const LITERAL_OK = 'type-literal-ok:'
// A line that opens with a comment marker is prose about the rule, not an application of it. `#` is
// NOT a comment marker: in a `.css` file a leading `#` is an ID selector.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|<!--)/

/** Every font-size literal on a CODE line (deduplicated), or [] for a clean or exempted line. The
 * `type-literal-ok:` waiver is honoured on the line itself OR on the line before it (the
 * `eslint-disable-next-line` shape), so a waiver never forces the class off its own line. Pure, so
 * the companion test can drive it with fixture strings. */
export function findTypeLiterals(line, prevLine = '') {
  if (COMMENT_LINE.test(line)) return []
  if (line.includes(LITERAL_OK) || prevLine.includes(LITERAL_OK)) return []
  return [...new Set(line.match(TYPE_LITERAL) ?? [])]
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
      // Beyond `.vue`: a class list can be built in a composable (`.ts`) or applied with `@apply`
      // (`.css`), and `spa-loading-template.html` is hand-written CSS that renders before the app
      // does, so it sits inside the scan root and needs reading like any other.
      yield abs
    }
  }
}

function main() {
  const offenders = []
  for (const file of SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)])) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const matches = findTypeLiterals(line, lines[i - 1] ?? '')
      if (matches.length) offenders.push({ file: relative(repoRoot, file), line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Font-size literals are banned in the SPA (issue #2248).')
    console.error(
      "Size text with a named step: Tailwind's `text-xs` and up, or the app's `text-2xs` (11px) /\n" +
        '`text-3xs` (10px) from frontend/app/app/assets/css/type.css. A literal does not scale with\n' +
        "a theme document's `fontSize`, so the app's own text stays put while Nuxt UI's components\n" +
        'grow. This covers every spelling of the declaration: `text-[11px]`, `text-[length:11px]`,\n' +
        '`[font-size:11px]` and a raw `font-size: 11px`. A section eyebrow is\n' +
        '`common/SectionLabel.vue`, which carries the step for you.\n' +
        'See frontend/app/README.md, "Type through named steps".\n',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a font-size literal.`)
    process.exit(1)
  }

  console.log('check-frontend-type-scale: every font size in the SPA is a named step.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
