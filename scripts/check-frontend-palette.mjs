#!/usr/bin/env node
// Bans colour utilities that opt out of the theme in the SPA layer (issue #2239).
//
// The SPA paints through TWO kinds of theme token and nothing else:
//   - Nuxt UI's role tokens (`bg-default`, `text-muted`, `border-default`, ...) and its bare
//     mode-adaptive aliases (`text-primary`, `bg-warning/10`, `text-error`);
//   - the app's own tokens (`frontend/app/app/assets/css/tokens.css`): the mirrored numbered status
//     tokens (`bg-app-950`, `text-app-warning-300`, `border-app-error-800`), whose dark value is the
//     exact ramp shade and whose light value is the mirrored shade, and the category hues
//     (`text-app-hue-pink`).
//
// Two shapes look identical to those in dark mode and are wrong in light mode, so both are banned:
//   1. A RAW Tailwind palette utility for a hue the theme aliases (`bg-slate-900`, `text-amber-300`,
//      `border-rose-800`): welded to a fixed palette, so a theme that recolours `warning` misses it.
//   2. A FIXED NUMBERED alias utility (`text-primary-400`, `bg-warning-950/40`): follows the theme's
//      palette but not its mode, so a `300` text meant for a dark surface stays `300` on white.
//   3. A colour LITERAL (`#f59e0b`, `rgb(30 41 59)`) in an attribute, a `<style>` block or a
//      keyframe, and a hex ALPHA appended to a colour value (`accent + '22'`), which is garbage on
//      a `var()`. Both escaped the first review of the light-mode change.
// Brand accents use the BARE alias (`text-primary`, `bg-primary/10`); a category hue (an agent
// kind's identity colour) uses `text-app-hue-pink` or `var(--app-hue-pink)` in an inline style.
//
// Policy: ZERO offenders. The migration left none, so there is no ratchet of legacy allowances to
// carry: the moment a diff adds one, this fails. A hex a deployment-registered kind sends over the
// wire is data, not source, and `tint()` accepts it.
//
// Usage:  node scripts/check-frontend-palette.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer AND the deployment template: `deploy/frontend` is what a consumer copies, and its
// `acme/*` worked example mounts inside the layer's own chrome, so a fixed palette there ships as
// the pattern to copy.
const SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

/** Every Tailwind hue: a status hue rides an alias, a category hue rides `app-hue-<h>`, so no raw
 * numbered hue utility has a place left. */
const RAW_HUES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]
/** Nuxt UI's alias names; a NUMBERED shade on one of these is the fixed-mode shape. `neutral` is
 * both a hue and an alias; either way its numbered form is banned. */
const ALIASES = ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']

const PREFIX =
  '(?:bg|text|border|border-[xytrbles]|ring|ring-offset|inset-ring|divide|from|via|to|outline|outline-offset|decoration|caret|accent|fill|stroke|shadow|placeholder)'
const SHADE = '(?:50|100|200|300|400|500|600|700|800|900|950)(?!\\d)(?:\\/\\d{1,3})?'

// A colour-bearing utility prefix, then `-<hue>-`, then a valid shade and an optional `/opacity`.
// Variants (`hover:`, `dark:`, `[&_x]:`) precede the prefix and do not affect the match.
//
// `(?<![\w-])` is a LEFT boundary: without it `myaccent-indigo-400` matches on the `accent-…`
// substring, and `text-app-primary-400` (the app's own token) on `primary-400`. The prefix must
// start at a non-word, non-dash char (line start, whitespace, quote, `:` variant sep, `[`).
const RAW_PALETTE = new RegExp(`(?<![\\w-])${PREFIX}-(?:${RAW_HUES.join('|')})-${SHADE}`, 'g')
const FIXED_ALIAS = new RegExp(`(?<![\\w-])${PREFIX}-(?:${ALIASES.join('|')})-${SHADE}`, 'g')
// Brand accents use the BARE alias; a numbered `app-primary-<n>` token no longer exists, so the
// utility would silently apply nothing.
const RETIRED_PRIMARY = new RegExp(`(?<![\\w-])${PREFIX}-app-primary-${SHADE}`, 'g')

// A colour LITERAL outside the token system: a hex colour (6 or 8 digits, or 3 or 4 when a value
// terminator follows, so a template slot like `#add` or an ID selector like `#app {` stays clear
// while `#fff;` and `#fff8;` do not), or an `rgb()` / `hsl()` / `oklch()` / `oklab()` / `lab()` / `lch()` / `color()` function. These hide in SVG
// `fill`/`stroke` attributes, scoped `<style>` blocks and keyframes, where no utility class exists
// for the utility rules above to catch. The pre-JS loading shell is HTML and is not scanned; a line
// that must carry a literal (the first-paint `theme-color` fallbacks) says why with
// `colour-literal-ok:`.
//
// `(?<![\w/])` is a LEFT boundary on the hex branches: a `#` glued to a word char or a `/` is an
// issue/URL reference (`acme/web#123`, `page#abcdef`), never a colour, because a real hex is
// preceded by a value opener (`:`, whitespace, quote, `(`) or the line start (issue #2261). A
// colour function needs no such guard: `myrgb(` is not a thing.
const COLOUR_LITERAL =
  /(?<![\w/])#[0-9a-f]{6}(?:[0-9a-f]{2})?\b|(?<![\w/])#[0-9a-f]{3,4}(?=["');,\s])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/gi
// Appending a hex alpha to a colour value: valid on a hex, garbage on a `var(--app-hue-*)`, and
// nothing in the type system tells the two apart. `tint()` (`utils/colorTint.ts`) is the seam.
const ALPHA_CONCAT =
  /\b(?:color|accent)\s*\+\s*['"][0-9a-f]{2}['"]|\$\{[^}]*(?:color|accent)[^}]*\}[0-9a-f]{2}/gi
const LITERAL_OK = 'colour-literal-ok:'
// Comment lines may name a colour when explaining one; the guard reads code, not prose. `#` is NOT
// a comment marker here: in the scanned `.css` and `.vue` files a line starting with `#` is an ID
// selector, and `#app { color: #ff0000 }` must not slip past.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|<!--)/

/** Every offending utility on a line (deduplicated), or [] for a clean line. Pure, so the
 * companion test can drive it with fixture strings. */
export function findRawPalette(line) {
  return [
    ...new Set([
      ...(line.match(RAW_PALETTE) ?? []),
      ...(line.match(FIXED_ALIAS) ?? []),
      ...(line.match(RETIRED_PRIMARY) ?? []),
    ]),
  ]
}

/** Every colour literal or hex-alpha concatenation on a CODE line, or [] for a clean line. */
export function findColourLiterals(line) {
  if (COMMENT_LINE.test(line) || line.includes(LITERAL_OK)) return []
  return [...new Set([...(line.match(COLOUR_LITERAL) ?? []), ...(line.match(ALPHA_CONCAT) ?? [])])]
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) {
      yield* sourceFiles(abs)
    } else if (abs.endsWith('.vue') || abs.endsWith('.ts') || abs.endsWith('.css')) {
      // `.css` too: a `<style>` block or an `@apply` line can name a utility class.
      yield abs
    }
  }
}

function main() {
  const offenders = []
  for (const file of SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)])) {
    const lines = readFileSync(file, 'utf8').split('\n')
    // A spec may hold a hex as a FIXTURE (the value a deployment-registered kind sends, a colour
    // the sanitiser must accept); the literal rule reads production code only.
    const isSpec = file.endsWith('.spec.ts')
    lines.forEach((line, i) => {
      const matches = [...findRawPalette(line), ...(isSpec ? [] : findColourLiterals(line))]
      if (matches.length) offenders.push({ file: relative(repoRoot, file), line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Colour utilities that opt out of the theme are banned in the SPA (issue #2239).')
    console.error(
      'Use a role token (bg-default, text-muted), a bare alias (text-primary, bg-warning/10) or the\n' +
        "app's mirrored numbered token (text-app-warning-300, bg-app-950) or category hue\n" +
        '(text-app-hue-pink); in CSS or SVG, var(--ui-*) / var(--app-*); a translucent fill goes\n' +
        'through tint(). See frontend/app/README.md, "Colour through theme tokens".\n',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a fixed-palette colour utility.`)
    process.exit(1)
  }

  console.log('check-frontend-palette: every colour utility in the SPA rides a theme token.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
