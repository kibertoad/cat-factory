#!/usr/bin/env node
// Bans a button or badge prop that restates the app's default (issue #2250).
//
// `frontend/app/app/app.config.ts` states the app's default `color`, `variant` and `size` for
// `UButton` and `UBadge` (`ui.<component>.defaultVariants`, Nuxt UI's own `primary solid md`). A
// call site states only what DIFFERS from that default, so a primary action carries no props and a
// quiet one says `color="neutral" variant="ghost"`. A literal equal to the default is not just
// noise: it pins the value against a theme document's `style.defaults`, so a theme that changes the
// button size or variant would change every primary action except the ones that restated the old
// default.
//
// SCOPE: the opening tag of `UButton`, `IconButton` (which forwards every prop to its `UButton`)
// and `UBadge` in the TEMPLATE half of a `.vue` file, with the prop written as a literal
// (`size="xs"`) or a bound string literal (`:size="'xs'"`). A computed binding is not read: its
// value is decided at runtime and may differ per render.
//
// The defaults are READ from `app.config.ts`, not restated here, so the guard and the app cannot
// disagree. A config the parser cannot read fails the guard loudly rather than passing everything.
//
// Policy: ZERO offenders. A site that must keep the literal (for example, to hold its size when a
// theme changes the default) says why with a `variant-default-ok:` comment, on the tag's first
// line or the line before it.
//
// Usage:  node scripts/check-frontend-variants.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isCliEntry,
  openingTag,
  repoRoot,
  spaSourceFiles,
  templateHalf,
} from './lib/frontend-scan.mjs'

const APP_CONFIG = join(repoRoot, 'frontend', 'app', 'app', 'app.config.ts')
const DEFAULT_OK = 'variant-default-ok:'
const PROPS = ['color', 'variant', 'size']

/** The tags this guard reads, each with the `ui.<key>` whose `defaultVariants` govern it. */
export const TAG_CONFIG_KEYS = { UButton: 'button', IconButton: 'button', UBadge: 'badge' }

/**
 * The `defaultVariants` of each config key in an `app.config.ts` source, as
 * `{ button: { color, variant, size }, ... }`. Throws when a key or one of the three props is
 * missing, so a refactor of the config cannot silently turn the guard into a no-op.
 */
export function readDefaults(source) {
  const defaults = {}
  for (const key of new Set(Object.values(TAG_CONFIG_KEYS))) {
    const block = new RegExp(`\\b${key}:\\s*\\{\\s*defaultVariants:\\s*\\{([^}]*)\\}`).exec(source)
    if (!block) throw new Error(`app.config.ts has no ui.${key}.defaultVariants block`)
    const values = Object.fromEntries(
      [...block[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]),
    )
    for (const prop of PROPS) {
      if (!values[prop]) throw new Error(`ui.${key}.defaultVariants does not set '${prop}'`)
    }
    defaults[key] = values
  }
  return defaults
}

/**
 * The props on one opening tag that equal its component's default, as `['size="xs"', ...]`.
 * `tag` is the whole opening tag, from `<Name` to its closing `>`.
 */
export function findDefaultProps(tag, name, defaults) {
  const own = defaults[TAG_CONFIG_KEYS[name]]
  const found = []
  for (const prop of PROPS) {
    const literal = new RegExp(`\\s${prop}="([^"]*)"`).exec(tag)
    const bound = new RegExp(`\\s(?::|v-bind:)${prop}="'([^']*)'"`).exec(tag)
    const value = literal?.[1] ?? bound?.[1]
    if (value === own[prop]) found.push(`${prop}="${value}"`)
  }
  return found
}

/** Every offender in the template half of one `.vue` source, as `{ line, matches }`. */
export function findInTemplate(source, defaults) {
  const lines = templateHalf(source).split('\n')
  const raw = source.split('\n')
  const out = []
  const tagStart = new RegExp(`<(${Object.keys(TAG_CONFIG_KEYS).join('|')})(?![\\w-])`, 'g')
  lines.forEach((line, i) => {
    if (raw[i].includes(DEFAULT_OK) || (raw[i - 1] ?? '').includes(DEFAULT_OK)) return
    for (const match of line.matchAll(tagStart)) {
      const matches = findDefaultProps(openingTag(lines, i, match.index), match[1], defaults)
      if (matches.length) out.push({ line: i + 1, matches: [`<${match[1]}>`, ...matches] })
    }
  })
  return out
}

function main() {
  const defaults = readDefaults(readFileSync(APP_CONFIG, 'utf8'))
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (!file.rel.endsWith('.vue')) continue
    for (const hit of findInTemplate(readFileSync(file.abs, 'utf8'), defaults)) {
      offenders.push({ file: file.rel, ...hit })
    }
  }

  if (offenders.length) {
    const describe = (key) => PROPS.map((prop) => `${prop}="${defaults[key][prop]}"`).join(' ')
    console.error('A button or badge prop restates the app default (issue #2250).')
    console.error(
      'The defaults live in frontend/app/app/app.config.ts, and a call site states only what\n' +
        'differs. A restated default also pins the value against a theme that changes it.\n' +
        `  UButton / IconButton: ${describe('button')}\n` +
        `  UBadge:               ${describe('badge')}\n` +
        'Delete the prop. See frontend/app/README.md, "Buttons and badges follow one variant policy".\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    console.error(`\n${offenders.length} tag(s) restating a default.`)
    process.exit(1)
  }

  console.log('check-frontend-variants: no button or badge restates the app default.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
