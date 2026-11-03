#!/usr/bin/env node
// Bans a select item whose value is the empty string in the SPA layer (issue #2393).
//
// Reka's `SelectItem` and `ComboboxItem`, which `USelect` and `USelectMenu` render, THROW in
// `setup` when an item's value is `''`: Reka reserves the empty string on the root to mean
// "cleared, show the placeholder". The throw is silent to every check but a browser: typecheck
// accepts the literal, the unit tests do not mount the select, and the page logs the error and
// renders the panel broken or not at all.
//
// The "no value" row is `selectNoneItem(label)` from `frontend/app/app/utils/selectNone.ts`, and
// the component binds the select through `selectNoneModel`, so what it stores and sends does not
// change.
//
// WHAT IS MATCHED: a `value` KEY whose value is an empty string literal (`''`, `""` or an empty
// template), in an object literal that also has a `label` KEY, however the object is laid out:
// over several lines, with a parameterised `t('x', { n })` or a template literal as its label, or
// with nested objects beside them (`ui: { … }`). That is the item shape both components take. A
// key is a key only at the object's own top level, after `{` or `,`, so `{ text: label, value: '' }`
// (label as a VALUE) is not an item, and neither is a type literal (`value: '' | 'a'`, or keys
// separated by `;`). An object with `value: ''` and no `label` is a form row and is left alone.
// The guard reads source, so a list whose values are built at runtime from data is outside it.
//
// Comments are blanked (`lib/frontend-scan.mjs`), so a line ABOUT the rule is not read as an
// application of it. Spec files are not scanned: a test may build the bad item to assert against.
// In a `.vue` template a double quote delimits an attribute, so there only single-quoted and
// template strings are strings, and an item inline in a binding is still read.
//
// Policy: ZERO offenders. An item list that never reaches a Reka select says why with a
// `select-empty-value-ok:` comment, on the `value` line or the one before it.
//
// Usage:  node scripts/check-frontend-select-values.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readFileSync } from 'node:fs'
import {
  codeLines,
  isCliEntry,
  isWaived,
  spaSourceFiles,
  templateHalf,
} from './lib/frontend-scan.mjs'

const WAIVER = 'select-empty-value-ok:'

// Both read an object's TOP-LEVEL text (see `topLevelText`), so a key is at the start or after a
// comma. A `|` after the value is a type union, never an item.
const LABEL_KEY = /(?:^|,)\s*label\s*(?::|,|$)/
const EMPTY_VALUE = /(?:^|,)(\s*)value\s*:\s*(?:''|""|``)(?!\s*\|)/g

const OPENERS = { '{': '}', '[': ']', '(': ')' }

/**
 * The bracket depth of every character of `code`, and where each `{` closes. Strings are walked
 * over so a brace inside one does not count; a template literal's `${…}` is code again. A quoted
 * string ends at a newline, so prose with an apostrophe costs one line, not the rest of the file.
 */
function bracketDepths(code, { doubleQuoteIsString }) {
  const depth = Array.from({ length: code.length }, () => 0)
  const objects = []
  const stack = [] // { char, index } for each open bracket; char '${' for a template expression.
  let i = 0
  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].char === '`'
  while (i < code.length) {
    const char = code[i]
    depth[i] = stack.filter((s) => s.char !== '`').length
    if (inTemplate()) {
      if (char === '\\') {
        i += 2
        continue
      }
      if (char === '`') stack.pop()
      else if (char === '$' && code[i + 1] === '{') {
        stack.push({ char: '${', index: i })
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (char === "'" || (char === '"' && doubleQuoteIsString)) {
      let j = i + 1
      while (j < code.length && code[j] !== char && code[j] !== '\n') {
        if (code[j] === '\\') j += 1
        j += 1
      }
      for (let k = i; k <= j && k < code.length; k++) depth[k] = depth[i]
      i = j + 1
      continue
    }
    if (char === '`') stack.push({ char: '`', index: i })
    else if (OPENERS[char]) stack.push({ char, index: i })
    else if (char === '}' || char === ']' || char === ')') {
      const open = stack.pop()
      if (open?.char === '{') objects.push({ start: open.index, end: i })
      depth[i] = stack.filter((s) => s.char !== '`').length
    }
    i += 1
  }
  return { depth, objects }
}

/** An object's body with everything nested deeper than its own keys blanked, offsets kept. */
function topLevelText(code, depth, { start, end }) {
  const level = depth[start] + 1
  let text = ''
  for (let i = start + 1; i < end; i++) {
    const char = code[i]
    text += depth[i] === level || char === '\n' ? char : ' '
  }
  return text
}

/** `source` with everything outside its `<script>` blocks blanked, offsets kept. */
function scriptHalf(source) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  let out = ''
  let last = 0
  for (const m of source.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g)) {
    out += blank(source.slice(last, m.index + m[1].length)) + m[2]
    last = m.index + m[1].length + m[2].length
  }
  return out + blank(source.slice(last))
}

/**
 * Every item literal in `source` whose value is the empty string, as `{ line, text }` with a
 * 1-based line. `file` decides how a `.vue` file is read. Pure, so the companion test can drive it
 * with fixtures.
 */
export function findEmptySelectValues(source, file = '<input>.ts') {
  const lines = codeLines(source, file)
  const code = lines.map((l) => l.code).join('\n')
  const parts = file.endsWith('.vue')
    ? [
        { text: scriptHalf(code), doubleQuoteIsString: true },
        { text: templateHalf(code), doubleQuoteIsString: false },
      ]
    : [{ text: code, doubleQuoteIsString: true }]
  const found = new Map()
  for (const { text, doubleQuoteIsString } of parts) {
    const { depth, objects } = bracketDepths(text, { doubleQuoteIsString })
    for (const object of objects) {
      const body = topLevelText(text, depth, object)
      if (!LABEL_KEY.test(body)) continue
      for (const hit of body.matchAll(EMPTY_VALUE)) {
        const offset = object.start + 1 + hit.index + hit[0].indexOf('value')
        const line = text.slice(0, offset).split('\n').length
        const { raw, prev } = lines[line - 1]
        if (!isWaived(raw, prev, WAIVER)) found.set(line, { line, text: raw.trim() })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line)
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
        '`~/utils/selectNone`, and bind the select through `selectNoneModel`.\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`)
    console.error(`\n${offenders.length} select item(s) with an empty value.`)
    process.exit(1)
  }

  console.log('check-frontend-select-values: no select item in the SPA has an empty value.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
