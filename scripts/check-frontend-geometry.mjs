#!/usr/bin/env node
// Holds every SPA modal to a NAMED width (issue #2251).
//
// A dialog states what kind of content it holds (`<AppModal size="prompt|form|wide">`,
// `components/common/AppModal.vue`) and the width follows from that in one place
// (`utils/overlaySize.ts`). Before this, the modals picked their own `max-w-*`, five widths for
// three kinds of dialog. Three shapes opt out of the names:
//
//   1. A raw `<UModal>` (also written `<LazyUModal>`). It opens at Nuxt UI's default width, or at
//      whatever its `:ui` content slot says. `AppModal.vue` itself wraps one and is the only file
//      that may. A `USlideover` is a side panel, not a centered dialog, and has no named width, so
//      this guard does not read it.
//   2. An `<AppModal>` that ALSO carries a width utility (`max-w-*`, `min-w-*` or `w-*`) in `class`
//      or in the `content` entry of `:ui`, the two places that reach the modal's width. Nuxt UI
//      merges `class` BEFORE `ui.content`, so a plain `max-w-sm` in `class` loses to the size, and
//      only a modifier-prefixed one (`sm:max-w-3xl`) wins; `class` is dropped altogether when the
//      modal has a trigger slot. The guard does not model that, it refuses every width. Another
//      `ui` slot (`footer`, `body`) is not read: it cannot set the modal's width.
//   3. An `<AppModal>` whose width-bearing value the guard cannot read: `:ui` that is not an object
//      literal, a `...spread` or a bare `content` shorthand in it, a `:class` or `content:` that
//      names a variable, or `v-bind="…"`. A width cannot be read out of a variable, so it refuses
//      the variable. Write the classes as string literals.
//
// Exempt:
//
//   - A modal that is ALWAYS `fullscreen` (the bare attribute, or `:fullscreen="true"`), which has
//     no width to name. A BOUND `:fullscreen="isPhone"` is a centered modal at every other size,
//     so it is not exempt: it is an `<AppModal>`, which drops the width while it is fullscreen.
//   - A workbench surface: the sandbox, the agent prompt editor, the libraries and settings
//     panels. They are wider than `wide` on purpose, and their shell is the open decision in
//     #2359, so a named width for them now would be dead work. Each says so with a
//     `<!-- workbench-width-ok: <reason> -->` comment that ends directly above the tag. The reason
//     is required. A waiver that no raw modal uses is reported as stale, so it cannot outlive the
//     surface it names.
//
// Usage:  node scripts/check-frontend-geometry.mjs
// Exit 0 = clean; exit 1 = an offender or a stale waiver was found.

import { readFileSync } from 'node:fs'
import {
  commentAbove,
  isCliEntry,
  spaSourceFiles,
  templateHalf,
  walkTemplate,
} from './lib/frontend-scan.mjs'

/** The one file that may hold a raw `UModal`: the wrapper that names its width. */
export const WRAPPER = 'frontend/app/app/components/common/AppModal.vue'
export const MARKER = 'workbench-width-ok:'

const RAW_OVERLAYS = new Set(['UModal'])
// The marker, then at least one word before the comment closes.
const REASONED = new RegExp(`${MARKER}\\s*[^\\s-]`)
const WIDTH = /(?<![\w-])(?:max-|min-)?w-[\w[\]().%/-]+/
const STRING_LITERAL = /'[^']*'|"[^"]*"|`[^`]*`/g

/** `<Lazy…>` is Nuxt's lazy-loaded twin of a component and renders the same one. */
const overlayName = (name) => name.replace(/^Lazy(?=[A-Z])/, '')

/**
 * The attributes of an opening tag as `{ name, value }`, `value` unquoted or undefined for a bare
 * attribute. Each quoted value is consumed with its attribute, so a word inside a `title` is never
 * read as an attribute of its own.
 */
function attributes(tag) {
  const attrs = []
  const re = /\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
  re.lastIndex = tag.search(/\s/)
  let m
  while ((m = re.exec(tag))) attrs.push({ name: m[1], value: m[2] ?? m[3] })
  return attrs
}

/** Whether an overlay is ALWAYS fullscreen: the bare attribute or a bound literal `true`. */
function alwaysFullscreen(tag) {
  return attributes(tag).some(
    ({ name, value }) =>
      (name === 'fullscreen' && value === undefined) ||
      (name === ':fullscreen' && value?.trim() === 'true'),
  )
}

/** The top-level entries of an object literal, split on commas outside quotes and brackets. */
function literalEntries(literal) {
  const body = literal.trim().replace(/^\{/, '').replace(/\}$/, '')
  const entries = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (quote) {
      if (char === quote) quote = null
    } else if ('\'"`'.includes(char)) quote = char
    else if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (char === ',' && depth === 0) {
      entries.push(body.slice(start, i))
      start = i + 1
    }
  }
  entries.push(body.slice(start))
  return entries.filter((entry) => entry.trim())
}

/** Whether an expression names anything but string literals, which a width cannot be read from. */
const readsVariable = (expression) => /[A-Za-z_$]/.test(expression.replace(STRING_LITERAL, "''"))

/** The expression that reaches the modal content's classes from a `:ui` literal, or a refusal. */
function uiContent(literal) {
  const entries = literalEntries(literal)
  if (entries.some((entry) => entry.trim().startsWith('...'))) {
    return { refusal: 'spreads into :ui: write its slots out so the guard can read them' }
  }
  for (const entry of entries) {
    const key = entry.match(/^\s*(['"]?)content\1\s*(:|$)/)
    if (!key) continue
    if (!entry.includes(':'))
      return { refusal: 'names content as a variable: write it as a string' }
    return { expression: entry.slice(entry.indexOf(':') + 1) }
  }
  return { expression: '' }
}

/** Why an `<AppModal>` opening tag picks its own width, or null when it does not. */
function appModalWidth(tag) {
  const attrs = attributes(tag)
  if (attrs.some(({ name }) => name === 'v-bind')) {
    return 'spreads v-bind: list its props so the guard can read them'
  }
  for (const { name, value = '' } of attrs) {
    const bound = name.startsWith(':') || name.startsWith('v-bind:')
    const attr = name.replace(/^(:|v-bind:)/, '')
    let expression = value
    if (attr === 'ui') {
      if (!bound) continue
      if (!value.trim().startsWith('{')) {
        return 'binds :ui to a variable: write it as an object literal so the guard can read it'
      }
      const content = uiContent(value)
      if (content.refusal) return content.refusal
      expression = content.expression
    } else if (attr !== 'class') {
      continue
    }
    const width = expression.match(WIDTH)
    if (width) return `with ${width[0]}: the size prop sets the width`
    if (bound && readsVariable(expression)) {
      return `reads its ${attr === 'ui' ? 'content' : 'class'} from a variable: write it as a string so the guard can read it`
    }
  }
  return null
}

/**
 * The overlay offenders in one `.vue` source, as `{ line, message }`. Pure, so the companion test
 * can drive it with fixtures. `rel` is the repo-relative path.
 */
export function findOverlayOffenders(source, rel) {
  const lines = source.split('\n')
  const offenders = []
  // Every marker line in the template; a waiver that a raw overlay uses is removed from this.
  const unused = new Set()
  templateHalf(source.replaceAll('<!--', '    ').replaceAll('-->', '   '))
    .split('\n')
    .forEach((line, i) => {
      if (line.includes(MARKER)) unused.add(i + 1)
    })

  walkTemplate(source, {
    open(node) {
      if (RAW_OVERLAYS.has(overlayName(node.name))) {
        if (rel === WRAPPER) return
        const comment = commentAbove(lines, node.line)
        const text = comment.map((n) => lines[n - 1]).join(' ')
        const waived = text.includes(MARKER)
        if (waived) for (const n of comment) unused.delete(n)
        if (alwaysFullscreen(node.tag)) {
          if (waived) {
            offenders.push({
              line: node.line,
              message: `${MARKER} waiver on a fullscreen overlay: it has no width to waive`,
            })
          }
          return
        }
        if (waived) {
          if (REASONED.test(text)) return
          offenders.push({ line: node.line, message: `${MARKER} waiver without a reason` })
          return
        }
        offenders.push({
          line: node.line,
          message: `raw <${overlayName(node.name)}>: use <AppModal size="prompt|form|wide">`,
        })
      } else if (node.name === 'AppModal') {
        const reason = appModalWidth(node.tag)
        if (reason) offenders.push({ line: node.line, message: `<AppModal> ${reason}` })
      }
    },
  })
  for (const line of unused) {
    offenders.push({ line, message: `stale ${MARKER} waiver: no raw overlay directly below it` })
  }
  return offenders.sort((a, b) => a.line - b.line)
}

function main() {
  const offenders = []
  for (const file of spaSourceFiles()) {
    if (!file.abs.endsWith('.vue')) continue
    for (const o of findOverlayOffenders(readFileSync(file.abs, 'utf8'), file.rel)) {
      offenders.push({ file: file.rel, ...o })
    }
  }

  if (offenders.length) {
    console.error('Every SPA modal opens at a NAMED width (issue #2251).')
    console.error(
      'Use <AppModal size="prompt"> for a confirmation, a decision or a one- or two-field dialog,\n' +
        '<AppModal size="form"> for a form, a list or a hub, and <AppModal size="wide"> for cards\n' +
        'with an action beside each paragraph, tabs over a form, or three pickers in a row.\n' +
        'The widths live in utils/overlaySize.ts;\n' +
        'a call site never names a max-w-*. A fullscreen modal is exempt. A workbench surface\n' +
        'that waits on #2359 says why in a <!-- workbench-width-ok: … --> comment directly above\n' +
        'its tag. See frontend/app/README.md, "Modals open at a named width".\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.message}`)
    console.error(`\n${offenders.length} offender(s).`)
    process.exit(1)
  }

  console.log('check-frontend-geometry: every SPA modal opens at a named width.')
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
