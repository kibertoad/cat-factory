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
// SCOPE: the control elements above, in the TEMPLATE half of a `.vue` file, however the element
// is named: a literal tag, a component told to render one (`<SectionLabel as="button">`), a
// `<component :is="… 'button' …">` binding, and a render function in a `.ts` file
// (`h('button')`). The last three render the same raw element and a literal-tag scan cannot see
// them. Their structural
// children (`<option>`, `<summary>`, `<thead>`, `<td>`) are not listed separately: each can only
// exist under a parent this guard already claims, so naming them would report one conversion as
// six offences. Prose and layout markup (`<p>`, `<h1>`-`<h6>`, `<ul>`, `<li>`, `<dl>`, `<pre>`,
// `<code>`, `<img>`, `<nav>`, `<svg>`, `<div>`, `<span>`) is NOT in scope: it is not a control,
// Nuxt UI has no component for it, and heading typography belongs to #2248.
//
// `<a>` is claimed only when it carries an `href`. A bare `<a>` is an anchor target, not a link.
//
// ALSO BANNED: an icon-only `UButton` with a `title=` and no `aria-label`. Its only name is the
// `title`, which never shows on touch and is not the app's tooltip. That is `IconButton`, which
// names the button and shows the hint. Icon-only means an `icon` prop and no `label`, or a body
// that is a single `<UIcon />`.
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

import { readFileSync } from 'node:fs'
import {
  isCliEntry,
  isWaived,
  MAX_TAG_LINES,
  openingTag,
  readCodeLines,
  spaSourceFiles,
  templateHalf,
} from './lib/frontend-scan.mjs'

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
  if (isWaived(line, prevLine, RAW_OK)) return []
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

const ELEMENTS = Object.keys(REPLACEMENTS).join('|')
// `as="button"` on any component, and a quoted element name inside an `:is` binding
// (`:is="url ? 'a' : 'span'"`). Both render the raw element at runtime.
const AS_ELEMENT = new RegExp(`\\sas="(${ELEMENTS})"`, 'g')
const IS_ELEMENT = new RegExp(`:is="[^"]*'(${ELEMENTS})'`, 'g')
// A render function: `h('button', …)`.
const RENDER_ELEMENT = new RegExp(`(?<![\\w$.])h\\(\\s*['"\`](${ELEMENTS})['"\`]`, 'g')

/** Every banned control a component or `:is` binding is told to render on a template line. */
export function findDynamicControls(line, prevLine = '') {
  if (COMMENT_LINE.test(line)) return []
  if (isWaived(line, prevLine, RAW_OK)) return []
  const found = [...line.matchAll(AS_ELEMENT), ...line.matchAll(IS_ELEMENT)].map((m) => m[1])
  return [...new Set(found)]
}

/** Every banned control a render function creates, on one line from `codeLines` (a `.ts` file). */
export function findRenderedControls({ raw, code, prev }) {
  if (isWaived(raw, prev, RAW_OK)) return []
  return [...new Set([...code.matchAll(RENDER_ELEMENT)].map((m) => m[1]))]
}

/** An icon-only `UButton` whose only name is a `title`: it should be `IconButton`. `bodyOf`
 * returns the markup between the opening tag and `</UButton>` ('' for a self-closing tag). */
export function findTitleOnlyIconButton(
  line,
  prevLine = '',
  tagOf = () => line,
  bodyOf = () => '',
) {
  if (COMMENT_LINE.test(line)) return []
  if (isWaived(line, prevLine, RAW_OK)) return []
  const match = /<UButton(?![a-zA-Z0-9-])/.exec(line)
  if (!match) return []
  const tag = tagOf(match.index)
  if (!/\s:?title[=\s>]/.test(tag) || /\s:?aria-label[=\s>]/.test(tag)) return []
  const body = tag.trimEnd().endsWith('/>') ? '' : bodyOf(match.index).trim()
  const iconProp = /\s:?icon=/.test(tag) && !/\s:?label=/.test(tag) && body === ''
  const iconBody = /^<UIcon\b[^>]*\/>$/.test(body)
  return iconProp || iconBody ? ['title-only icon button'] : []
}

/** The markup between the opening tag starting at `from` on `lines[index]` and its `</UButton>`. */
export function buttonBody(lines, index, from = 0) {
  const rest = lines
    .slice(index, index + MAX_TAG_LINES)
    .join('\n')
    .slice(from)
  const open = openingTag([rest], 0).length
  const close = rest.indexOf('</UButton>', open)
  return close === -1 ? '' : rest.slice(open, close)
}

/** `title=` on a primitive that already owns its tooltip. */
export function findRedundantTitle(line, prevLine = '', tagOf = () => line) {
  if (COMMENT_LINE.test(line)) return []
  if (isWaived(line, prevLine, RAW_OK)) return []
  const match = /<(?:IconButton|CopyButton)(?![a-zA-Z0-9-])/.exec(line)
  if (!match) return []
  // Same reason as the anchor above: an IconButton with a `title` is never one line long.
  return /\s:?title[=\s>]/.test(tagOf(match.index)) ? ['title'] : []
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (file.rel.endsWith('.ts')) {
      readCodeLines(file).forEach((line, i) => {
        const controls = findRenderedControls(line)
        if (controls.length) {
          offenders.push({ file: file.rel, line: i + 1, matches: controls.map((c) => `h('${c}')`) })
        }
      })
      continue
    }
    if (!file.rel.endsWith('.vue')) continue
    const lines = templateHalf(readFileSync(file.abs, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const prev = lines[i - 1] ?? ''
      const tagOf = (from) => openingTag(lines, i, from)
      const controls = [...findRawControls(line, prev, tagOf), ...findDynamicControls(line, prev)]
      const titles = findRedundantTitle(line, prev, tagOf)
      const iconOnly = findTitleOnlyIconButton(line, prev, tagOf, (from) =>
        buttonBody(lines, i, from),
      )
      if (controls.length || titles.length || iconOnly.length) {
        offenders.push({
          file: file.rel,
          line: i + 1,
          matches: [...controls.map((c) => `<${c}>`), ...titles.map(() => 'title='), ...iconOnly],
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
        '\nA component told to render one (`as="button"`, `:is="\'a\'"`, `h(\'button\')`) is the same raw\n' +
        'element. A collapsing section header is a `UButton` around `<SectionLabel as="span">`.\n' +
        'An icon-only UButton named only by `title=` is `common/IconButton.vue`, which names it and\n' +
        'shows the hint on hover, focus and touch.\n' +
        'IconButton and CopyButton own their tooltip, so a `title=` on either is a second hint\n' +
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
if (isCliEntry(import.meta.url)) main()
