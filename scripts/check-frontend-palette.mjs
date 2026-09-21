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
// Three more shapes come from the #2242 review, each a class of comment the reviewer left more
// than once, turned into a deterministic check:
//   4. A FIXED white or black utility (`bg-white`, `text-black`, `border-white/5`,
//      `bg-white/[0.02]`, `ring-white/10`): welded to one end of the mode, so it is invisible or
//      wrong in light mode. The theme-aware replacements are role tokens: `border-inverted` for a
//      selection ring, `border-default` / `bg-muted` for faint chrome, `text-inverted` for text
//      over a filled surface, `text-highlighted` for the page's strongest text. A line that
//      genuinely needs a fixed white or black (a difference-composite canvas backing, where black
//      is the mathematically neutral backdrop in either mode) says why with `fixed-colour-ok:`.
//   5. TEXT over a PRIMARY or alias FILL must be `text-inverted`. `text-white` on `bg-primary` is
//      white-on-white under the shipped Mono theme (its `--ui-primary` is white in dark mode), and
//      `text-highlighted` follows the PAGE, not the fill. Only `text-inverted` is defined against
//      the inverted surface. Flagged when one class attribute pairs `bg-primary` (or an alias fill:
//      `bg-secondary`, `bg-success`, `bg-info`, `bg-warning`, `bg-error`, `bg-neutral`, with or
//      without `/N`) with `text-white` or `text-highlighted`.
//   6. A DEGENERATE hover: a `hover:<utility>` whose colour utility equals a resting one in the
//      same class list (`text-primary … hover:text-primary`). A mechanical-migration artefact (two
//      numbered shades collapsed onto one alias) that leaves no hover feedback. Colour utilities
//      only (a size / layout class like `text-sm` or `bg-cover` is not one); an alpha difference
//      (`bg-primary/90 … hover:bg-primary`) is a real change and is left alone.
// Rules 5-6 read one applied class list at a time (a bound `:class` ternary splits into its
// branches), so a `bg-primary` in one branch and a `text-white` in another never pair. Neither has
// a fixed value to opt out the way rule 4 does, so a genuine need says why with `theme-colour-ok:`.
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
const COLOUR_LITERAL =
  /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b|#[0-9a-f]{3,4}(?=["');,\s])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/gi
// Appending a hex alpha to a colour value: valid on a hex, garbage on a `var(--app-hue-*)`, and
// nothing in the type system tells the two apart. `tint()` (`utils/colorTint.ts`) is the seam.
const ALPHA_CONCAT =
  /\b(?:color|accent)\s*\+\s*['"][0-9a-f]{2}['"]|\$\{[^}]*(?:color|accent)[^}]*\}[0-9a-f]{2}/gi
const LITERAL_OK = 'colour-literal-ok:'

// An optional Tailwind opacity suffix: `/40` or an arbitrary `/[0.02]`.
const OPACITY = '(?:\\/(?:\\d{1,3}|\\[[^\\]]+\\]))?'
// A FIXED white/black utility (rule 4). Same colour-bearing prefixes as the palette rules, then
// `-white` / `-black`, then an optional opacity. `bg-white/[0.02]` and `ring-white/10` included.
const FIXED_BW = new RegExp(`(?<![\\w-])${PREFIX}-(?:white|black)(?![\\w-])${OPACITY}`, 'g')
const FIXED_BW_OK = 'fixed-colour-ok:'
// One shared escape for the pairing (rule 5) and degenerate-hover (rule 6) rules, whose refusals a
// site otherwise cannot waive (they have no fixed value to opt out, the way rule 4's white/black
// does). A line that genuinely wants the flagged combination says why.
const THEME_COLOUR_OK = 'theme-colour-ok:'
// The colour names a utility may carry: the Nuxt UI aliases and role tokens, plus the app's own
// `app-*` tokens (numbered ramps, hues, canvas). Deliberately NOT `[\\w-]+`: a bare suffix match
// swept up size / layout / position utilities (`text-sm`, `bg-cover`, `ring-2`, `text-center`) that
// share a prefix but are not colours, and rule 6 flagged their same-value hovers as colour bugs.
const COLOUR_NAME =
  '(?:primary|secondary|success|info|warning|error|neutral|default|muted|elevated|accented|toned|dimmed|highlighted|inverted|app-[\\w-]+)'
// A colour utility, opacity included so `bg-primary/90` and `bg-primary` stay DISTINCT.
const COLOUR_UTIL = `(?:text|bg|border|border-[xytrbles]|ring|decoration)-${COLOUR_NAME}${OPACITY}`
// A PRIMARY / alias fill and the two page-relative text tokens that must not sit on it (rule 5).
const FILL_FOR_TEXT = new RegExp(`(?<![\\w-])bg-(?:${ALIASES.join('|')})${OPACITY}(?![\\w-])`)
const PAGE_TEXT = /(?<![\w-])text-(?:white|highlighted)(?![\w-])/
// One class TOKEN split into its variant chain (`hover:`, `dark:`, `sm:`, `group-hover:`, `[&]:`)
// and the colour utility it decorates. A token is a hover state when `hover:` sits ANYWHERE in the
// chain, so a resting twin under a different variant (`sm:text-primary`) still counts (rule 6).
const CLASS_TOKEN = new RegExp(`^((?:[\\w[\\]&.-]+:)*)(${COLOUR_UTIL})$`)

/** The class strings on a line, scoped so rules 5 and 6 pair utilities only WITHIN one applied
 * class list. Each quoted run (double, single, backtick); a run that itself nests quoted strings (a
 * bound `:class="cond ? 'a' : 'b'"`) yields those inner strings, so two mutually-exclusive ternary
 * branches never pair. The whole line when it carries no quotes (a CSS `@apply`). */
function classSegments(line) {
  const runs = [...line.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3])
  if (!runs.length) return [line]
  return runs.flatMap((run) => {
    const inner = [...run.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    )
    return inner.length ? inner : [run]
  })
}
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

/** Every fixed white/black utility on a CODE line (rule 4), or [] for a clean or exempted line. */
export function findFixedBlackWhite(line) {
  if (COMMENT_LINE.test(line) || line.includes(FIXED_BW_OK)) return []
  return [...new Set(line.match(FIXED_BW) ?? [])]
}

/** Each `bg-<alias>` + `text-white`/`text-highlighted` pairing on a CODE line (rule 5), reported as
 * `<fill>+<text>`, scoped to one applied class list. [] for a clean, comment or waived line. */
export function findTextOnFill(line) {
  if (COMMENT_LINE.test(line) || line.includes(THEME_COLOUR_OK)) return []
  const hits = []
  for (const seg of classSegments(line)) {
    const fill = FILL_FOR_TEXT.exec(seg)
    const text = PAGE_TEXT.exec(seg)
    if (fill && text) hits.push(`${fill[0]}+${text[0]}`)
  }
  return [...new Set(hits)]
}

/** Each degenerate hover on a CODE line (rule 6): a `hover:<util>` whose colour utility (opacity
 * included) also appears as a resting utility in the same class list, compared by the utility below
 * its variant chain so a `sm:`-prefixed resting twin still counts. Reported as `hover:<util>=<util>`.
 * [] for a clean, comment or waived line. */
export function findDegenerateHover(line) {
  if (COMMENT_LINE.test(line) || line.includes(THEME_COLOUR_OK)) return []
  const hits = []
  for (const seg of classSegments(line)) {
    const resting = new Set()
    const hovers = []
    for (const token of seg.split(/\s+/)) {
      const m = CLASS_TOKEN.exec(token)
      if (!m) continue // not a colour utility (a size / layout / position class, or plain word)
      if (m[1].includes('hover:')) hovers.push(m[2])
      else resting.add(m[2])
    }
    for (const util of hovers) if (resting.has(util)) hits.push(`hover:${util}=${util}`)
  }
  return [...new Set(hits)]
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
    // The literal rule (rule 3) reads production code only; the utility rules (raw palette, and
    // rules 4-6) apply everywhere, a fixed class being wrong even in a fixture. #2245 widens this
    // gate to also exempt `presets.ts` (a verbatim Nuxt UI decode table of `oklch()` strings); the
    // utility spreads below are untouched by that.
    const literalExempt = file.endsWith('.spec.ts')
    lines.forEach((line, i) => {
      const matches = [
        ...findRawPalette(line),
        ...findFixedBlackWhite(line),
        ...findTextOnFill(line),
        ...findDegenerateHover(line),
        ...(literalExempt ? [] : findColourLiterals(line)),
      ]
      if (matches.length) offenders.push({ file: relative(repoRoot, file), line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Colour utilities that opt out of the theme are banned in the SPA (issue #2239).')
    console.error(
      'Use a role token (bg-default, text-muted), a bare alias (text-primary, bg-warning/10) or the\n' +
        "app's mirrored numbered token (text-app-warning-300, bg-app-950) or category hue\n" +
        '(text-app-hue-pink); in CSS or SVG, var(--ui-*) / var(--app-*); a translucent fill goes\n' +
        'through tint(). For a fixed white/black, use border-inverted / border-default / bg-muted /\n' +
        'text-inverted; text on a bg-primary/alias fill is text-inverted; a hover: utility must\n' +
        'differ from its resting value. See frontend/app/README.md, "Colour through theme tokens".\n',
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
