#!/usr/bin/env node
// Bans raw HTML CONTROLS in the SPA layer (issue #2249).
//
// The SPA renders a control as its Nuxt UI component and nothing else. A raw `<button>` beside a
// `UButton` is the same control in two styles, and only one of them follows the theme, the focus
// ring, the disabled state and the size scale. The migration converted all of them, so this guard
// keeps the count at zero:
//
//   <button>    -> UButton (an icon-only one is `common/IconButton.vue`)
//   <input>     -> UInput / UInputNumber / UCheckbox / URadioGroup / USlider / UFileUpload
//   <select>    -> USelect (searchable: USelectMenu; free text: UInputMenu)
//   <textarea>  -> UTextarea
//   <table>     -> UTable with column definitions
//   <details>   -> UCollapsible
//   <form>      -> UForm
//   <a href>    -> ULink
//   <datalist>  -> UInputMenu with `mode="autocomplete"`, which is what a datalist is
//
// SCOPE: the control elements above, in the TEMPLATE half of a `.vue` file. Their structural
// children (`<option>`, `<summary>`, `<thead>`, `<td>`) are not listed separately: each can only
// exist under a parent this guard already claims, so naming them would report one conversion as
// six offences. Prose and layout markup (`<p>`, `<h1>`-`<h6>`, `<ul>`, `<li>`, `<dl>`, `<pre>`,
// `<code>`, `<img>`, `<nav>`, `<svg>`, `<div>`, `<span>`) is NOT in scope: it is not a control,
// Nuxt UI has no component for it, and heading typography belongs to #2248.
//
// `<a>` is claimed only when it carries an `href`. A bare `<a>` is an anchor target, not a link.
//
// ALSO BANNED: `title=` on `IconButton` and `CopyButton`. Both now wrap their button in a
// `UTooltip` and pass `aria-label` themselves, so a `title` beside that renders a second, uglier
// hint over the first. A `title` on a plain `UButton` is still allowed: on a control that already
// shows its label, a `title` is a hover HINT rather than the control's name, and converting those
// is a per-site layout call rather than a rule.
//
// Policy: ZERO offenders, no ratchet, and NO allow-list. The migration expected to need one (a
// Vue Flow gesture handle, a full-bleed media tile) and both converted cleanly, so an exception
// table would have been a mechanism with more surface than the thing it governs. A line that
// genuinely cannot convert says why with a `raw-control-ok:` comment, on that line or the one
// before it; nothing in the tree needs one today, and a second one appearing is the signal that
// the rule, not the site, is what needs revisiting.
//
// Usage:  node scripts/check-frontend-primitives.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The layer AND the deployment template, the same two roots the palette and type-scale guards
// scan: `deploy/frontend` is what a consumer copies, so a raw control there ships as the pattern
// to copy.
const SCAN_ROOTS = [
  join(repoRoot, 'frontend', 'app', 'app'),
  join(repoRoot, 'deploy', 'frontend', 'app'),
]

/** The banned elements, each with the component that replaces it (shown in the failure). */
export const REPLACEMENTS = {
  button: 'UButton (icon-only: common/IconButton.vue)',
  input: 'UInput / UInputNumber / UCheckbox / URadioGroup / USlider / UFileUpload',
  select: 'USelect (searchable: USelectMenu)',
  textarea: 'UTextarea',
  table: 'UTable with column definitions',
  details: 'UCollapsible',
  form: 'UForm',
  a: 'ULink',
  datalist:
    'UInputMenu with `mode="autocomplete"` (the DEFAULT mode writes the model only\n              on select, so a typed value is lost)',
}

const RAW_OK = 'raw-control-ok:'
// How far an opening tag is followed for its attributes. The longest in the tree is well under
// this; the cap is only so a file with an unbalanced `<` cannot make the scan quadratic.
const MAX_TAG_LINES = 40
// A line that opens with a comment marker is prose about the rule, not an application of it.
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|<!--)/

/**
 * Every banned control opened on a CODE line, or [] for a clean or exempted line.
 *
 * The negative lookahead is what keeps `<a>` from matching `<article>` and `<input>` from matching
 * a component whose name merely starts the same way: an element name ends at a character that
 * cannot continue it.
 *
 * Pure, so the companion test can drive it with fixture strings.
 */
export function findRawControls(line, prevLine = '', tagOf = () => line) {
  if (COMMENT_LINE.test(line)) return []
  if (line.includes(RAW_OK) || prevLine.includes(RAW_OK)) return []
  const found = []
  for (const element of Object.keys(REPLACEMENTS)) {
    const re = new RegExp(`<${element}(?![a-zA-Z0-9-])`, 'g')
    // EVERY match on the line, not the first: `<a id="top"></a> <a :href="url">` put a bare
    // anchor in front of a real link, and stopping at the first one let the link through.
    let match
    while ((match = re.exec(line))) {
      // An anchor is only a link when it has a destination; a bare `<a>` is an anchor target.
      // Read the WHOLE opening tag: the formatter wraps a multi-attribute tag, so every
      // `<a href>` in this tree carries its `href` on a later line than its `<a`.
      if (element === 'a' && !/\s:?href[=\s>]/.test(tagOf(match.index))) continue
      found.push(element)
      break
    }
  }
  return found
}

/** `title=` on a primitive that already owns its tooltip. */
export function findRedundantTitle(line, prevLine = '', tagOf = () => line) {
  if (COMMENT_LINE.test(line)) return []
  if (line.includes(RAW_OK) || prevLine.includes(RAW_OK)) return []
  const match = /<(?:IconButton|CopyButton)(?![a-zA-Z0-9-])/.exec(line)
  if (!match) return []
  // Same reason as the anchor above: an IconButton with a `title` is never one line long.
  return /\s:?title[=\s>]/.test(tagOf(match.index)) ? ['title'] : []
}

/**
 * The opening tag that starts at `from` on `lines[index]`, up to its first `>`.
 *
 * The two ATTRIBUTE rules above read attributes, and the formatter breaks any tag carrying more
 * than a couple of them across lines. Reading one line saw only the tags short enough to fit on
 * one, which is not the shape this repo writes: every `<a href>` and every `IconButton` in the
 * SPA is wrapped, so both rules matched nothing at all.
 *
 * A `>` inside a QUOTED attribute value does not end the tag, because that `>` is how this tree
 * writes a condition: `v-if="total > 1"`, `v-if="s.depth >= 2"`, `v-if="x.length > 0"`. Ending
 * there truncated the tag before its `href` or `title` and the two attribute rules matched
 * nothing at exactly the sites they exist for. The quote state carries ACROSS lines: the
 * formatter breaks a long binding expression mid-value.
 */
export function openingTag(lines, index, from = 0) {
  let text = ''
  let quote = null
  for (let i = index; i < lines.length && i - index < MAX_TAG_LINES; i++) {
    const slice = i === index ? lines[i].slice(from) : lines[i]
    for (let c = 0; c < slice.length; c++) {
      const char = slice[c]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        return text + slice.slice(0, c + 1)
      }
    }
    text += `${slice}\n`
  }
  return text
}

/**
 * The template half of a `.vue` file, with the script and style blocks and the HTML comments
 * blanked out so offsets (and therefore line numbers) are preserved.
 *
 * Blanking rather than slicing is what makes `<template #slot>` safe: a `.vue` file nests template
 * tags for named slots, so matching the outer pair non-greedily stops at the first inner close and
 * silently skips everything after it.
 */
export function templateHalf(source) {
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  return source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === 'dist') continue
    const abs = join(dirAbs, entry)
    if (statSync(abs).isDirectory()) yield* sourceFiles(abs)
    else if (abs.endsWith('.vue')) yield abs
  }
}

function main() {
  const offenders = []
  for (const file of SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)])) {
    const lines = templateHalf(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const prev = lines[i - 1] ?? ''
      const tagOf = (from) => openingTag(lines, i, from)
      const controls = findRawControls(line, prev, tagOf)
      const titles = findRedundantTitle(line, prev, tagOf)
      if (controls.length || titles.length) {
        offenders.push({
          file: relative(repoRoot, file),
          line: i + 1,
          matches: [...controls.map((c) => `<${c}>`), ...titles.map(() => 'title=')],
        })
      }
    })
  }

  if (offenders.length) {
    console.error('Raw HTML controls are banned in the SPA (issue #2249).')
    console.error(
      'A control is its Nuxt UI component, so it follows the theme, the focus ring, the disabled\n' +
        'state and the size scale rather than a per-file recipe:\n' +
        Object.entries(REPLACEMENTS)
          .map(([el, to]) => `  <${el}> -> ${to}`)
          .join('\n') +
        '\nIconButton and CopyButton own their tooltip, so a `title=` on either is a second hint\n' +
        'over the first.\n' +
        'See frontend/app/README.md, "A control is its Nuxt UI component".\n',
    )
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    }
    console.error(`\n${offenders.length} line(s) with a raw control.`)
    process.exit(1)
  }

  console.log('check-frontend-primitives: every control in the SPA is a Nuxt UI component.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
// `argv[1]` is undefined under `node -e` / the REPL, where `pathToFileURL` throws: an import
// must never be the thing that fails.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
