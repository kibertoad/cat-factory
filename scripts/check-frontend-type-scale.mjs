#!/usr/bin/env node
// Bans font-size LITERALS in the SPA layer (issue #2248).
//
// The SPA sizes text through named steps and nothing else: Tailwind's own (`text-xs` and up) plus
// the two the app declares below them in `frontend/app/app/assets/css/type.css` (`text-2xs` at
// 0.6875rem, `text-3xs` at 0.625rem). A literal opts out of that system in two ways:
//
//   1. It does not scale with the theme. A theme document's `fontSize` is applied as
//      `html[data-theme] { font-size: Npx }` (`app/utils/theme/css.ts`). Every rem-based step
//      follows it; a px literal does not, so the app's own text stays put while Nuxt UI's
//      components grow.
//   2. It is unnameable. Nuxt UI sizes its own components on the rem scale, so a `UBadge size="sm"`
//      beside a `text-[11px]` label is sized by a system the label cannot refer to.
//
// A `rem` literal in a utility (`text-[0.6875rem]`) scales but is still unnameable, and it is how
// the px form comes back, so it is banned too.
//
// WHAT IS MATCHED, and so what the ban covers:
//   - the arbitrary-value utility, with or without a type hint: `text-[11px]`,
//     `text-[length:11px]`, in px, rem, em or pt;
//   - the arbitrary-property utility: `[font-size:11px]`, `[font:600_11px/1.2_x]`;
//   - a CSS declaration in px: `font-size: 11px`, and the `font:` shorthand with a px size
//     (`font: 600 11px/1.2 Geist`);
//   - a JS style property in px, as a `:style` binding or an `element.style` assignment writes it:
//     `fontSize: '11px'`, `style.fontSize = '11px'`, `setProperty('font-size', '11px')`.
// A raw `rem` or `em` declaration is not matched: it already follows the root the theme sets.
//
// Nothing else. A width, a gap or a `leading-[...]` line height is a layout decision this guard has
// no opinion about. An arbitrary COLOUR (`text-[#f59e0b]`) shares the `text-[` shape and is
// `check-frontend-palette.mjs`'s to judge, so the unit set here is closed.
//
// Policy: ZERO offenders, no ratchet. A line that genuinely needs a literal says why with a
// `type-literal-ok:` comment, on that line or the one before it.
//
// Usage:  node scripts/check-frontend-type-scale.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { isCliEntry, isWaived, readCodeLines, spaSourceFiles } from './lib/frontend-scan.mjs'

// `(?<![\w-])` is a LEFT boundary on each spelling, so a utility that merely ENDS in `text-`, or a
// property that merely ends in `font`, does not match out of the middle of a longer token. A
// variant (`sm:`, `hover:`) precedes a utility and does not affect the match. In the shorthand a
// length after `/` is the line height, not the size, so it never counts.
const LENGTH = String.raw`\d*\.?\d+(?:px|rem|em|pt)`
const PX = String.raw`\d*\.?\d+px`
const SPELLINGS = [
  // Utilities.
  String.raw`text-\[(?:length:)?${LENGTH}\]`,
  String.raw`\[font-size:${LENGTH}\]`,
  String.raw`\[font:[^\]]*?(?<![A-Za-z0-9./])${PX}[^\]]*\]`,
  // CSS declarations, including a quoted `'font-size'` key in a `:style` object.
  String.raw`font-size["']?\s*:\s*["']?${PX}`,
  String.raw`font\s*:[^;{}]*?(?<![\w.#/-])${PX}`,
  // JS style properties.
  String.raw`fontSize\s*[:=]\s*[\`'"]${PX}`,
  String.raw`setProperty\(\s*["']font-size["']\s*,\s*[\`'"]${PX}`,
]
const TYPE_LITERAL = new RegExp(String.raw`(?<![\w-])(?:${SPELLINGS.join('|')})`, 'g')
const LITERAL_OK = 'type-literal-ok:'

/** Every font-size literal on one line from `codeLines` (deduplicated), or [] for a clean or
 * exempted line. The match reads `code`, the line with its comments blanked; the
 * `type-literal-ok:` waiver is read from the raw line OR the raw line before it (the
 * `eslint-disable-next-line` shape). Pure, so the companion test can drive it with fixtures. */
export function findTypeLiterals({ raw, code, prev }) {
  if (isWaived(raw, prev, LITERAL_OK)) return []
  return [...new Set(code.match(TYPE_LITERAL) ?? [])]
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles({ html: true })) {
    readCodeLines(file).forEach((line, i) => {
      const matches = findTypeLiterals(line)
      if (matches.length) offenders.push({ file: file.rel, line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Font-size literals are banned in the SPA (issue #2248).')
    console.error(
      "Size text with a named step: Tailwind's `text-xs` and up, or the app's `text-2xs` (11px) /\n" +
        '`text-3xs` (10px) from frontend/app/app/assets/css/type.css. A literal does not scale with\n' +
        "a theme document's `fontSize`, so the app's own text stays put while Nuxt UI's components\n" +
        'grow. A section eyebrow is `common/SectionLabel.vue`, which carries the step for you.\n' +
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
if (isCliEntry(import.meta.url)) main()
