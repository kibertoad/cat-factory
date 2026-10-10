#!/usr/bin/env node
// Bans a button or badge prop that restates the app's default, and two solid buttons side by side
// (issue #2250).
//
// `frontend/app/app/app.config.ts` states the app's default `color`, `variant` and `size` for
// `UButton` and `UBadge` (`ui.<component>.defaultVariants`, Nuxt UI's own `primary solid md`). A
// call site states only what DIFFERS from that default, so a primary action carries no props and a
// quiet one says `color="neutral" variant="ghost"`. A literal equal to the default is not just
// noise: it pins the value against a theme document's `style.defaults`, so a theme that changes the
// button size or variant would change every primary action except the ones that restated the old
// default.
//
// SCOPE: the opening tag of `UButton` and `UBadge`, PascalCase or kebab-case, and of every SPA
// component that spreads its attributes into one (`IconButton` today; the list is DERIVED, so a
// new pass-through wrapper is covered the day it lands), in the TEMPLATE half of a `.vue` file.
// The prop may be a literal in either quote style (`size="xs"`, `size='xs'`), a bound string
// literal (`:size="'xs'"`), or a key of a `v-bind="{ … }"` object literal. A computed binding is
// not read: its value is decided at runtime and may differ per render. `size` is not checked
// inside a `UFieldGroup` / `UButtonGroup`: there the group sets the size, so an explicit `size`
// overrides the group rather than restating the default.
//
// The defaults are READ from `app.config.ts`, not restated here, so the guard and the app cannot
// disagree. A config the parser cannot read fails the guard loudly rather than passing everything.
//
// SECOND RULE: no element holds two solid buttons as direct children (`findSolidSiblings` says how
// `<template>` wrappers, `v-if` chains and `v-for` count). It is the checkable half of "one solid
// primary per view": a file holding several forms that each end in a Save is several views, and a
// guard that counted per file would need a waiver on most of them.
//
// Policy: ZERO offenders. A site that must keep the literal (for example, to hold its size when a
// theme changes the default) says why with a `variant-default-ok:` comment on its own line,
// directly above the tag, and a second solid button with a `solid-ok:` comment the same way. Each
// waives that tag only.
//
// Usage:  node scripts/check-frontend-variants.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  isCliEntry,
  isWaivedAbove,
  repoRoot,
  spaSourceFiles,
  walkTemplate,
} from './lib/frontend-scan.mjs'

const APP_CONFIG = join(repoRoot, 'frontend', 'app', 'app', 'app.config.ts')
const DEFAULT_OK = 'variant-default-ok:'
const SOLID_OK = 'solid-ok:'
const PROPS = ['color', 'variant', 'size']

/** The Nuxt UI components this guard reads, each with the `ui.<key>` whose defaults govern it. */
export const BASE_CONFIG_KEYS = { UButton: 'button', UBadge: 'badge' }
// The groups that hand their own `size` down to the buttons and badges inside them.
const SIZE_GROUPS = new Set(['UFieldGroup', 'UButtonGroup'])

// One table of patterns, compiled once. A prop is read from a literal in either quote style, a
// bound string literal, or a key of a `v-bind="{ … }"` object literal.
const PROP_PATTERNS = Object.fromEntries(
  PROPS.map((prop) => [
    prop,
    {
      literal: new RegExp(`\\s${prop}=(?:"([^"]*)"|'([^']*)')`),
      bound: new RegExp(`\\s(?::|v-bind:)${prop}=(?:"'([^']*)'"|'"([^"]*)"')`),
      objectKey: new RegExp(`(?:^|[{,\\s])${prop}\\s*:\\s*(?:'([^']*)'|"([^"]*)")`),
    },
  ]),
)
const OBJECT_SPREAD = /\sv-bind=(?:"\s*(\{[^"]*\})\s*"|'\s*(\{[^']*\})\s*')/
const ATTRS_SPREAD = /\sv-bind="[^"]*attrs[^"]*"/i

/** Comments blanked, so a commented-out key or a note between braces cannot fool the parse. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** The text inside the `{ … }` that opens right after `from`, braces matched. */
function braceBody(source, from) {
  const open = source.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
  }
  return null
}

/**
 * The `defaultVariants` of each config key in an `app.config.ts` source, as
 * `{ button: { color, variant, size }, ... }`. Tolerant of what an ordinary edit does to the file:
 * other keys before `defaultVariants` (a `slots` block), comments, and either quote style. Throws
 * when a key or one of the three props is missing, so a refactor of the config cannot silently
 * turn the guard into a no-op.
 *
 * It parses rather than imports: the repo-guards CI job runs on the runner's stock Node with no
 * install, which is not guaranteed to load a `.ts` file.
 */
export function readDefaults(source) {
  const code = stripComments(source)
  const defaults = {}
  for (const key of new Set(Object.values(BASE_CONFIG_KEYS))) {
    const at = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(code)
    const component = at ? braceBody(code, at.index) : null
    const dv = component ? /\bdefaultVariants\s*:\s*\{/.exec(component) : null
    const block = dv ? braceBody(component, dv.index) : null
    if (block === null) throw new Error(`app.config.ts has no ui.${key}.defaultVariants block`)
    const values = Object.fromEntries(
      [...block.matchAll(/(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)")/g)].map((m) => [m[1], m[2] ?? m[3]]),
    )
    for (const prop of PROPS) {
      if (!values[prop]) throw new Error(`ui.${key}.defaultVariants does not set '${prop}'`)
    }
    defaults[key] = values
  }
  return defaults
}

/**
 * The SPA components that spread their attributes into a `UButton` or `UBadge` (the pattern
 * `common/IconButton.vue` uses), mapped to the config key of the component they forward to. A
 * call site's props on such a wrapper reach the Nuxt UI component unchanged, so they are held to
 * the same defaults. `sources` is `[{ name, source }]`, `name` the component's file basename.
 */
export function deriveWrappers(sources) {
  const wrappers = {}
  for (const { name, source } of sources) {
    walkTemplate(source, {
      open(node) {
        const key = BASE_CONFIG_KEYS[node.name]
        if (key && ATTRS_SPREAD.test(node.tag)) wrappers[name] = key
      },
    })
  }
  return wrappers
}

/** The value one opening tag gives `prop`, or undefined when it does not state it as a constant. */
function statedValue(tag, prop) {
  const { literal, bound, objectKey } = PROP_PATTERNS[prop]
  const lit = literal.exec(tag)
  if (lit) return lit[1] ?? lit[2]
  const bnd = bound.exec(tag)
  if (bnd) return bnd[1] ?? bnd[2]
  const spread = OBJECT_SPREAD.exec(tag)
  const key = spread ? objectKey.exec(spread[1] ?? spread[2]) : null
  return key ? (key[1] ?? key[2]) : undefined
}

/**
 * The props on one opening tag that equal its component's default, as `['size="xs"', ...]`.
 * `tag` is the whole opening tag; `own` is the component's `{ color, variant, size }` defaults;
 * `inSizeGroup` skips `size`, which a surrounding group sets.
 */
export function findDefaultProps(tag, own, inSizeGroup = false) {
  const found = []
  for (const prop of PROPS) {
    if (prop === 'size' && inSizeGroup) continue
    const value = statedValue(tag, prop)
    if (value === own[prop]) found.push(`${prop}="${value}"`)
  }
  return found
}

/**
 * Every offender in the template half of one `.vue` source, as `{ line, matches }`. `tagKeys`
 * maps each component name this guard reads (the Nuxt UI pair plus the derived wrappers) to its
 * config key.
 */
export function findInTemplate(source, defaults, tagKeys = BASE_CONFIG_KEYS) {
  const raw = source.split('\n')
  const out = []
  walkTemplate(source, {
    open(node, ancestors) {
      const key = tagKeys[node.name]
      if (!key || isWaivedAbove(raw[node.line - 2] ?? '', DEFAULT_OK)) return
      const inSizeGroup = ancestors.some((a) => SIZE_GROUPS.has(a.name))
      const matches = findDefaultProps(node.tag, defaults[key], inSizeGroup)
      if (matches.length) out.push({ line: node.line, matches: [`<${node.name}>`, ...matches] })
    },
  })
  return out
}

const CONDITIONAL_ELSE = /\sv-else(?:-if)?(?=[\s=/>])/

/** Whether an opening tag renders a solid button, given the button default. */
function isSolidButton(tag, defaults) {
  if (/\s(?::|v-bind:)variant=/.test(tag)) return false // decided at runtime
  const value = statedValue(tag, 'variant')
  return (value ?? defaults.button.variant) === 'solid'
}

/**
 * Every element in the template half of one `.vue` source that holds TWO OR MORE solid buttons as
 * direct children, as `{ line, matches }` naming the solid buttons' lines. This is the checkable
 * half of "one solid primary per view": two solid buttons side by side compete for the same
 * attention, while two forms in one file that each end in a Save are two views.
 *
 * What counts as a sibling follows the DOM, not the markup:
 * - a plain `<template>` (`v-if` / `v-for` wrapper) adds no element, so what it renders joins the
 *   place it took in the enclosing element; a slot `<template #name>` is its own region;
 * - a `v-if` / `v-else-if` / `v-else` chain renders one branch, so it counts as its largest branch;
 * - a `v-for` button counts once: it renders a list of equal alternatives, not a competing action.
 * A button with a bound `:variant` is not counted. `tagKeys` is the same component map
 * {@link findInTemplate} takes, so a derived wrapper of `UButton` counts as a button.
 */
export function findSolidSiblings(source, defaults, tagKeys = BASE_CONFIG_KEYS) {
  const raw = source.split('\n')
  const out = []
  const root = { name: '#root', tag: '', line: 0, data: { groups: [] } }
  // The solid buttons a frame renders side by side: per group of siblings, its largest branch.
  const rendered = (node) =>
    node.data.groups.flatMap((group) =>
      group.alternatives.reduce((best, alt) => (alt.length > best.length ? alt : best), []),
    )
  const report = (lines) => {
    if (lines.length >= 2) out.push({ line: lines[0], matches: lines.map((l) => `solid@${l}`) })
  }
  walkTemplate(source, {
    open(node, ancestors) {
      const parent = ancestors[ancestors.length - 1] ?? root
      const groups = parent.data.groups
      if (CONDITIONAL_ELSE.test(node.tag) && groups.length) {
        groups[groups.length - 1].alternatives.push([])
      } else {
        groups.push({ alternatives: [[]] })
      }
      const group = groups[groups.length - 1]
      node.data.place = group.alternatives[group.alternatives.length - 1]
      node.data.groups = []
      node.data.wrapper = node.name === 'template' && !/\s(?:#|v-slot)/.test(node.tag)
      const isButton = tagKeys[node.name] === 'button'
      if (isButton && isSolidButton(node.tag, defaults)) {
        if (!isWaivedAbove(raw[node.line - 2] ?? '', SOLID_OK)) node.data.place.push(node.line)
      }
    },
    close(node) {
      const lines = rendered(node)
      if (node.data.wrapper) node.data.place.push(...lines)
      else report(lines)
    },
  })
  report(rendered(root))
  return out.sort((a, b) => a.line - b.line)
}

function main() {
  const defaults = readDefaults(readFileSync(APP_CONFIG, 'utf8'))
  const files = [...spaSourceFiles()]
    .filter((file) => file.rel.endsWith('.vue'))
    .map((file) => ({ ...file, source: readFileSync(file.abs, 'utf8') }))
  const tagKeys = {
    ...BASE_CONFIG_KEYS,
    ...deriveWrappers(files.map((f) => ({ name: basename(f.rel, '.vue'), source: f.source }))),
  }
  const offenders = files.flatMap((file) =>
    findInTemplate(file.source, defaults, tagKeys).map((hit) => ({ file: file.rel, ...hit })),
  )
  const solids = files.flatMap((file) =>
    findSolidSiblings(file.source, defaults, tagKeys).map((hit) => ({ file: file.rel, ...hit })),
  )

  if (offenders.length) {
    const describe = (key) => PROPS.map((prop) => `${prop}="${defaults[key][prop]}"`).join(' ')
    const wrappers = Object.keys(tagKeys).filter((name) => !(name in BASE_CONFIG_KEYS))
    console.error('A button or badge prop restates the app default (issue #2250).')
    console.error(
      'The defaults live in frontend/app/app/app.config.ts, and a call site states only what\n' +
        'differs. A restated default also pins the value against a theme that changes it.\n' +
        `  UButton (and ${wrappers.join(', ') || 'no wrappers'}): ${describe('button')}\n` +
        `  UBadge: ${describe('badge')}\n` +
        'Delete the prop. See frontend/app/README.md, "Buttons and badges follow one variant policy".\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    console.error(`\n${offenders.length} tag(s) restating a default.\n`)
  }
  if (solids.length) {
    console.error('Two solid buttons share one parent element (issue #2250).')
    console.error(
      'A view has ONE solid primary action; a second action beside it takes a lighter variant\n' +
        '(`soft` for a send-back or destructive action, `outline` for a real secondary action, `ghost`\n' +
        'for a dismissal). See frontend/app/README.md, "Buttons and badges follow one variant policy".\n',
    )
    for (const o of solids) console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    console.error(`\n${solids.length} element(s) with competing solid buttons.`)
  }
  if (offenders.length || solids.length) process.exit(1)

  console.log(
    'check-frontend-variants: no button or badge restates the app default, and no two solid buttons are siblings.',
  )
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
