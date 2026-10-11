#!/usr/bin/env node
// Bans a hand-written full-screen `fixed` surface in the SPA layer.
//
// A phone's notch and home indicator cover whatever sits at the screen edge, and on every screen
// without them nothing looks wrong, so a takeover that forgets its safe-area padding ships
// unnoticed: five did. `frontend/app/app/utils/safeArea.ts` owns the two root class lists that
// carry the padding and the `100dvh` cap (`FULL_BLEED_TAKEOVER_CLASS`, `WINDOWED_OVERLAY_CLASS`),
// so an overlay that binds one cannot drop either. What is left to ban is a surface that spells
// its own full-screen positioning instead.
//
// A line offends when it carries a `fixed` token (any variant prefix) beside a token that spans the
// viewport along a whole side: `inset-0`, `inset-x-0`, `inset-y-0`, a full or viewport height or
// width (`h-full`, `h-screen`, `h-dvh`, `w-full`, `w-screen`, ...), or both of an opposite pair of
// edges (`top-0` with `bottom-0`, `left-0` with `right-0`, `start-0` with `end-0`). Token order
// does not matter, and `.ts` and `.css` files are read too, because a class list can live in a
// constant. The match is per LINE: a class list split across lines is not joined. The formatter
// keeps a class string on one line, so the gap is a list built from several string literals.
//
// `safeArea.ts` itself is the one sanctioned spelling and is not scanned. A surface with no edge
// content to protect (a scrim, a pointer-events-none drawing layer) or one that pads its own edges
// says why with a `safe-area-ok:` comment: on the line or the one above it, or, for a template
// element, directly above the element's opening tag.
//
// Usage:  node scripts/check-frontend-safe-area.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readFileSync } from 'node:fs'
import {
  codeLines,
  isCliEntry,
  isWaived,
  isWaivedAbove,
  MAX_TAG_LINES,
  openingTag,
  spaSourceFiles,
} from './lib/frontend-scan.mjs'

const SANCTIONED = 'frontend/app/app/utils/safeArea.ts'
const MARKER = 'safe-area-ok:'

// A class token, up to the quote, backtick, comma, bracket or whitespace around it.
const TOKEN_SPLIT = /[\s"'`,()[\]{}]+/
// Tokens that span the viewport along a whole side on their own.
const SPANNING = new Set([
  'inset-0',
  'inset-x-0',
  'inset-y-0',
  'h-full',
  'h-screen',
  'h-dvh',
  'h-svh',
  'h-lvh',
  'min-h-screen',
  'min-h-dvh',
  'w-full',
  'w-screen',
  'w-dvw',
])
// Opposite edges: a surface pinned to both spans the axis between them.
const OPPOSITE_PAIRS = [
  ['top-0', 'bottom-0'],
  ['left-0', 'right-0'],
  ['start-0', 'end-0'],
]

/** A token without its variant prefixes (`lg:`, `rtl:`) and its `!` important marker. */
const base = (token) => token.slice(token.lastIndexOf(':') + 1).replace(/^!|!$/g, '')

/** Whether one line of code (comments blanked) spells a full-screen `fixed` surface. Pure, so the
 * companion test can drive it with fixtures. */
export function isFullScreenFixed(code) {
  const tokens = new Set(code.split(TOKEN_SPLIT).filter(Boolean).map(base))
  if (!tokens.has('fixed')) return false
  if ([...SPANNING].some((token) => tokens.has(token))) return true
  return OPPOSITE_PAIRS.some(([a, b]) => tokens.has(a) && tokens.has(b))
}

/** The 1-based line of the opening tag that line `index` (0-based) belongs to, or null when the
 * line is not inside a tag within reach. A class attribute sits on its own line inside a wrapped
 * tag, where no comment can go, so a template waiver sits above the tag instead. */
function enclosingTagLine(lines, index) {
  for (let i = index; i >= 0 && index - i < MAX_TAG_LINES; i--) {
    const at = lines[i].search(/<[A-Za-z]/)
    if (at < 0) continue
    const span = openingTag(lines, i, at).split('\n').length
    return i + span - 1 >= index ? i + 1 : null
  }
  return null
}

/** Every offending line of one source text, as 1-based line numbers. */
export function findFullScreenFixed(text, file = '<input>') {
  const raw = text.split('\n')
  const offenders = []
  codeLines(text, file).forEach((line, i) => {
    if (!isFullScreenFixed(line.code)) return
    if (isWaived(line.raw, line.prev, MARKER)) return
    const tagLine = enclosingTagLine(raw, i)
    if (tagLine !== null && isWaivedAbove(raw, tagLine, MARKER)) return
    offenders.push(i + 1)
  })
  return offenders
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (file.rel === SANCTIONED) continue
    for (const line of findFullScreenFixed(readFileSync(file.abs, 'utf8'), file.rel)) {
      offenders.push(`${file.rel}:${line}`)
    }
  }

  if (offenders.length) {
    console.error(
      'A full-screen `fixed` surface must take its root classes from utils/safeArea.ts.',
    )
    console.error(
      'Bind `FULL_BLEED_TAKEOVER_CLASS` (a takeover) or `WINDOWED_OVERLAY_CLASS` (a window on a\n' +
        'backdrop) on the root and add only stacking, direction and backdrop beside it, so the\n' +
        'safe-area padding and the 100dvh cap cannot be dropped. A surface with no edge content (a\n' +
        'scrim) or one that pads its own edges says why with a `safe-area-ok:` comment, on the line\n' +
        'or above it, or above the element. See frontend/app/README.md, "Full-screen overlays".\n',
    )
    for (const o of offenders) console.error(`  ${o}`)
    console.error(`\n${offenders.length} hand-written full-screen surface(s).`)
    process.exit(1)
  }

  console.log('check-frontend-safe-area: every full-screen surface carries the safe-area padding.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
