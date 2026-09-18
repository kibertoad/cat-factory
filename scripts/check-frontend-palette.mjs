#!/usr/bin/env node
// Bans raw Tailwind palette utilities (`bg-slate-900`, `text-indigo-400`, `border-slate-800`)
// in the SPA layer. The theme migration (issue #2239) moved every one of these onto the
// `app.config.ts` aliases (`bg-neutral-*`, `text-primary-*`), so that changing `neutral` /
// `primary` there actually recolors the app. `neutral` maps to slate and `primary` to indigo,
// so the alias utilities resolve to the SAME shade the raw class did (the e2e
// `palette-token-parity` spec pins that equality); a reintroduced `slate-`/`indigo-` class
// looks identical today but is welded to a fixed palette and silently opts out of the theme.
//
// Policy: ZERO raw palette utilities. The migration left none, so there is no ratchet of
// legacy allowances to carry: the moment a diff adds one, this fails. Use `neutral-{n}` for a
// grey and `primary-{n}` for the brand color instead. A shade with no exact role token
// (slate-950/100/600) still goes through `neutral-{n}`, not the raw class.
//
// Scope: the two other Tailwind palette colours the app already uses semantically (`red`/
// `rose` for danger, `amber`/`green` for status) are NOT covered; only slate/indigo, which
// ARE the aliased neutral/primary, are bannable without a semantic-token gap.
//
// Usage:  node scripts/check-frontend-palette.mjs
// Exit 0 = clean; exit 1 = a raw slate/indigo utility was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOT = join(repoRoot, 'frontend', 'app', 'app')

// A Tailwind color-bearing utility prefix, then `-slate-`/`-indigo-`, then a valid shade and an
// optional `/opacity`. Variants (`hover:`, `dark:`, `[&_x]:`) precede the prefix and do not
// affect the match. Kept in sync with the migrator's own recognizer. Anchoring on a real
// utility prefix is what keeps the word "tran-slate-d", the `neutral: 'slate'` alias value, and
// a comment mention of `slate-950` from reading as offenders.
//
// `(?<![\w-])` is a LEFT boundary: without it `myaccent-indigo-400` matches on the `accent-…`
// substring and `xbg-slate-900` on `bg-…`, so an unrelated identifier would fail CI. The prefix
// must start at a non-word, non-dash char (line start, whitespace, quote, `:` variant sep, `[`).
const RAW_PALETTE =
  /(?<![\w-])(?:bg|text|border|border-[xytrbles]|ring|ring-offset|inset-ring|divide|from|via|to|outline|outline-offset|decoration|caret|accent|fill|stroke|shadow|placeholder)-(?:slate|indigo)-(?:50|100|200|300|400|500|600|700|800|900|950)(?!\d)(?:\/\d{1,3})?/g

/** Every raw slate/indigo utility on a line (deduplicated), or [] for a clean line. Pure, so the
 * companion test can drive it with fixture strings. */
export function findRawPalette(line) {
  return [...new Set(line.match(RAW_PALETTE) ?? [])]
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) {
      yield* sourceFiles(abs)
    } else if (abs.endsWith('.vue') || abs.endsWith('.ts') || abs.endsWith('.css')) {
      // `.css` too: a `<style>` block or an `@apply` line can name a utility class, which would
      // otherwise slip past a `.vue`/`.ts`-only scan. This bans raw palette UTILITY CLASSES; a
      // hardcoded hex/rgb value (`#6366f1`, `rgb(30 41 59)`) is a separate concern this guard does
      // NOT cover, because the app also carries a deliberate multi-colour hex palette (catalog.ts).
      yield abs
    }
  }
}

function main() {
  const offenders = []
  for (const file of sourceFiles(SCAN_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const matches = findRawPalette(line)
      if (matches.length) offenders.push({ file: relative(repoRoot, file), line: i + 1, matches })
    })
  }

  if (offenders.length) {
    console.error('Raw Tailwind palette utilities are banned in the SPA (issue #2239).')
    console.error('Use the theme aliases: slate-{n} -> neutral-{n}, indigo-{n} -> primary-{n}.\n')
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a raw slate/indigo utility.`)
    process.exit(1)
  }

  console.log('check-frontend-palette: no raw slate/indigo utilities in the SPA.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (import.meta.url === `file://${process.argv[1]}`) main()
