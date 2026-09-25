#!/usr/bin/env node
// Bans corner radii that do not follow the theme in the SPA layer (issue #2251).
//
// Nuxt UI redefines Tailwind's WHOLE radius scale in terms of `--ui-radius` (`.nuxt/ui.css`):
//
//     --radius-sm: var(--ui-radius);
//     --radius-md: calc(var(--ui-radius) * 1.5);
//     --radius-lg: calc(var(--ui-radius) * 2);
//     --radius-xl: calc(var(--ui-radius) * 3);
//     --radius-2xl: calc(var(--ui-radius) * 4);
//
// So `rounded-sm|md|lg|xl|2xl|3xl` ALREADY move with a theme document's `radius`, and a hand-written
// box on one of those steps is on the same scale as the Nuxt UI component beside it. Those are not
// the problem and are not banned. Three shapes opt out, and the first is the one that bit:
//
//   1. BARE `rounded` and its bare side/corner aliases (`rounded-t`, `rounded-bl`). These are
//      Tailwind v3 compatibility aliases resolving through `--radius`, which v4 declares
//      `@theme default inline reference`: the value is INLINED as the literal 0.25rem and no custom
//      property survives for `--ui-radius` to override. The SPA carried 144 of them, so picking any
//      theme with a non-default radius (every preset the Nuxt UI editor ships, 0 through 0.75rem)
//      rounded the buttons and the cards and left those 144 boxes at 4px.
//   2. An ARBITRARY value (`rounded-[10px]`, `rounded-t-[0.6rem]`). Welded to one number the way a
//      px font size is, and unnameable besides. The migration found none; it is banned so the fix
//      cannot come back wearing a hat.
//   3. A raw `border-radius` declaration in an absolute unit, in a stylesheet or a `<style>` block,
//      where no utility class exists for rule 1 to catch. Unlike the font-size guard, `rem` is
//      claimed too: a rem radius tracks the ROOT FONT SIZE, which is a different theme knob, so it
//      no more follows `--ui-radius` than a px one does.
//
// NOT banned, because neither is a step that should scale: `rounded-full` (pills, avatars, the
// `9999px` / `50%` spellings of the same intent) and `rounded-none` / `border-radius: 0`.
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

// Every side and corner suffix Tailwind gives the bare alias. Logical (`s`/`e`, `ss`/`se`/`ee`/`es`)
// and physical (`t`/`r`/`b`/`l`, `tl`/`tr`/`br`/`bl`) both, because the SPA is RTL-aware and uses
// the logical forms; a guard that knew only the physical ones would pass `rounded-ss`.
const SIDES = 'tl|tr|br|bl|ss|se|ee|es|t|r|b|l|s|e'

// `(?<![\w-])` is a LEFT boundary: without it `group-rounded` and `not-last:rounded-none` match on a
// substring. The trailing `(?![\w-])` is what separates the BARE alias from a named step: for
// `rounded-lg` the optional suffix group matches `-l`, then `g` fails the lookahead, and the
// no-suffix branch fails on the `-`. So only a token that ENDS at `rounded` or at a side is claimed.
const BARE_ALIAS = new RegExp(String.raw`(?<![\w-])rounded(?:-(?:${SIDES}))?(?![\w-])`, 'g')
// The arbitrary-value form, with or without a side.
const ARBITRARY = new RegExp(String.raw`(?<![\w-])rounded(?:-(?:${SIDES}))?-\[[^\]]*\]`, 'g')
// A raw declaration in px, rem or em. `0`, `50%`, `9999px` and `var(--radius-lg)` are the pill and
// the square, which have no scale to follow, so the unit set is closed to the three a real radius
// literal is written in. A four-value shorthand is claimed by the first value it carries.
const RAW_DECLARATION = /border-radius:\s*[^;}]*?\d*\.?\d+(?:px|rem|em)/g
// `9999px` and friends are `rounded-full` spelled in CSS: a pill, not a step.
const PILL = /border-radius:\s*(?:9999px|999px|100vmax|50%|100%)/
const LITERAL_OK = 'radius-literal-ok:'
// A line that opens with a comment marker is prose about the rule, not an application of it. `#` is
// NOT a comment marker: in a `.css` file a leading `#` is an ID selector.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|<!--)/

/** Every non-scaling radius on a CODE line (deduplicated), or [] for a clean or exempted line. The
 * `radius-literal-ok:` waiver is honoured on the line itself OR on the line before it (the
 * `eslint-disable-next-line` shape), so a waiver never forces the class off its own line. Pure, so
 * the companion test can drive it with fixture strings. */
export function findFixedRadii(line, prevLine = '') {
  if (COMMENT_LINE.test(line)) return []
  if (line.includes(LITERAL_OK) || prevLine.includes(LITERAL_OK)) return []
  const raw = PILL.test(line) ? [] : (line.match(RAW_DECLARATION) ?? [])
  return [...new Set([...(line.match(BARE_ALIAS) ?? []), ...(line.match(ARBITRARY) ?? []), ...raw])]
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
    // The one exemption, for the same reason `check-frontend-palette.mjs` grants it: a verbatim copy
    // of the Nuxt UI editor's preset table, stored only so a share link rebuilds and never rendered
    // by the SPA. Its prose describes radii it does not apply.
    if (rel.endsWith('frontend/app/app/utils/theme/presets.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const matches = findFixedRadii(line, lines[i - 1] ?? '')
      if (matches.length) offenders.push({ file: rel, line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Corner radii that do not follow the theme are banned in the SPA (issue #2251).')
    console.error(
      'Use a NAMED step: `rounded-sm` through `rounded-3xl` all derive from `--ui-radius`, so a\n' +
        "theme document's `radius` reaches them. Bare `rounded` (and `rounded-t`, `rounded-bl`, ...)\n" +
        'is a Tailwind v3 alias inlined as a literal 0.25rem, which is why a theme used to round the\n' +
        'buttons and leave the boxes behind; `rounded-sm` is that same 0.25rem at the default theme.\n' +
        'In CSS, `border-radius: var(--radius-sm|md|lg)`. `rounded-full` and `rounded-none` are fine.\n' +
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
