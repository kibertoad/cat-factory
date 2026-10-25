#!/usr/bin/env node
// Bans a select item whose value is the empty string in the SPA layer (issue #2393).
//
// Reka's `SelectItem` and `ComboboxItem`, which `USelect` and `USelectMenu` render, THROW in
// `setup` when an item's value is `''`: Reka reserves the empty string on the root to mean
// "cleared, show the placeholder". The throw is silent to every check but a browser: typecheck
// accepts the literal, the unit tests do not mount the select, and the page logs the error and
// renders the panel broken or not at all. Seven selects had shipped this way, each using `''` for
// its "no value" row (inherit, not set, the default).
//
// The "no value" row is `selectNoneItem(label)` from `frontend/app/app/utils/selectNone.ts`, and
// the component maps its stored value through `toSelectValue` / `fromSelectValue` at the select's
// boundary, so what it stores and sends does not change.
//
// WHAT IS MATCHED: an object literal with a `label` key and a `value` key that is an empty string
// literal (`''`, `""` or an empty template), on one line or across several. That is the item shape
// both components take. An object with `value: ''` and no `label` is a form row, not an item, and
// is left alone. The guard reads the source and cannot follow a value computed at runtime, so a
// list built from data is outside it.
//
// Comments are blanked (`lib/frontend-scan.mjs`), so a line ABOUT the rule is not read as an
// application of it. Spec files are not scanned: a test may build the bad item to assert against.
//
// Policy: ZERO offenders. An item list that never reaches a Reka select says why with a
// `select-empty-value-ok:` comment, on the `value` line or the one before it.
//
// Usage:  node scripts/check-frontend-select-values.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { codeLines, isCliEntry, isWaived, spaSourceFiles } from './lib/frontend-scan.mjs'
import { readFileSync } from 'node:fs'

const WAIVER = 'select-empty-value-ok:'

// An object literal with no nested braces: an item is a flat `{ label, value }`. A `t('…')` call
// or an `as const` inside it has no braces, so it does not break the match.
const FLAT_OBJECT = /\{[^{}]*\}/g
// `label: …`, or the shorthand `label,` / `label }`. `(?<![\w$.])` keeps `subLabel` and `x.label` out.
const LABEL_KEY = /(?<![\w$.])label\s*(?::|,|$)/m
const EMPTY_VALUE = /(?<![\w$.])value\s*:\s*(?:''|""|``)/g

/**
 * Every item literal in `source` whose value is the empty string, as `{ line, text }` with a
 * 1-based line. Pure, so the companion test can drive it with fixtures.
 */
export function findEmptySelectValues(source, file = '<input>') {
  const lines = codeLines(source, file)
  const code = lines.map((l) => l.code).join('\n')
  const lineAt = (offset) => code.slice(0, offset).split('\n').length
  const found = []
  for (const object of code.matchAll(FLAT_OBJECT)) {
    const body = object[0].slice(1, -1)
    if (!LABEL_KEY.test(body)) continue
    for (const value of body.matchAll(EMPTY_VALUE)) {
      const line = lineAt(object.index + 1 + value.index)
      const { raw, prev } = lines[line - 1]
      if (isWaived(raw, prev, WAIVER)) continue
      found.push({ line, text: raw.trim() })
    }
  }
  return found
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (file.rel.endsWith('.spec.ts')) continue
    for (const hit of findEmptySelectValues(readFileSync(file.abs, 'utf8'), file.rel)) {
      offenders.push({ file: file.rel, ...hit })
    }
  }

  if (offenders.length) {
    console.error('A select item with an empty value is banned in the SPA (issue #2393).')
    console.error(
      "Reka's SelectItem and ComboboxItem throw on `value: ''`, so USelect and USelectMenu break\n" +
        'when the item renders. Build the "no value" row with `selectNoneItem(label)` from\n' +
        '`~/utils/selectNone`, and map the model through `toSelectValue` / `fromSelectValue`.\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`)
    console.error(`\n${offenders.length} select item(s) with an empty value.`)
    process.exit(1)
  }

  console.log('check-frontend-select-values: no select item in the SPA has an empty value.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
