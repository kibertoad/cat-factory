#!/usr/bin/env node
// Holds every SPA modal to a NAMED width (issue #2251).
//
// A dialog states what kind of content it holds (`<AppModal size="prompt|form|wide">`,
// `components/common/AppModal.vue`) and the width follows from that in one place
// (`utils/overlaySize.ts`). Before this, the modals picked their own `max-w-*`, five widths for
// three kinds of dialog. Three shapes opt out of the names:
//
//   1. A raw `<UModal>` or `<USlideover>`. It opens at Nuxt UI's default width, or at whatever its
//      `:ui` content slot says. `AppModal.vue` itself wraps one and is the only file that may.
//   2. An `<AppModal>` that ALSO carries a width utility (`max-w-*`, `min-w-*` or `w-*`, in `:ui`
//      or `class`). tailwind-merge keeps the caller's class, so it overrides the `size`.
//   3. An `<AppModal>` whose `:ui` is not an object literal, or that spreads `v-bind="…"`. The
//      guard cannot read a width out of a variable, so it refuses the variable.
//
// Exempt:
//
//   - A modal that is ALWAYS `fullscreen` (the bare attribute, or `:fullscreen="true"`), which has
//     no width to name. A BOUND `:fullscreen="isPhone"` is a centered modal at every other size,
//     so it is not exempt.
//   - A workbench surface: the sandbox, the agent prompt editor, the pipeline builder, the
//     libraries and settings panels. They are wider than `wide` on purpose, and their shell is the
//     open decision in #2359, so a named width for them now would be dead work. Each says so with
//     a `<!-- workbench-width-ok: <reason> -->` comment that ends directly above the tag. The
//     reason is required. A waiver that no raw overlay uses is reported as stale, so it cannot
//     outlive the surface it names.
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

const RAW_OVERLAYS = new Set(['UModal', 'USlideover'])
// `fullscreen` as a bare attribute or bound to `true`, never inside another word or a value.
const FULLSCREEN = /\s(?::?fullscreen="true"|fullscreen(?=[\s/>]))/
// The attributes that can carry a class onto the modal content, and the width utilities in them.
const CLASS_ATTRS = /(?<=\s)(:|v-bind:)?(class|ui)\s*=\s*(["'])([\s\S]*?)\3/g
const WIDTH = /(?<![\w-])(?:max-|min-)?w-[\w[\]().%/-]+/
const SPREAD = /(?<=\s)v-bind\s*=/
// The marker, then at least one word before the comment closes.
const REASONED = new RegExp(`${MARKER}\\s*[^\\s-]`)

/** Why an `<AppModal>` opening tag picks its own width, or null when it does not. */
function appModalWidth(tag) {
  if (SPREAD.test(tag)) return 'spreads v-bind: list its props so the guard can read them'
  for (const [, bound, name, , value] of tag.matchAll(CLASS_ATTRS)) {
    if (bound && name === 'ui' && !value.trim().startsWith('{')) {
      return 'binds :ui to a variable: write it as an object literal so the guard can read it'
    }
    const width = value.match(WIDTH)
    if (width) return `with ${width[0]}: the size prop sets the width`
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
      if (RAW_OVERLAYS.has(node.name)) {
        if (rel === WRAPPER) return
        const comment = commentAbove(lines, node.line)
        const text = comment.map((n) => lines[n - 1]).join(' ')
        const waived = text.includes(MARKER)
        if (waived) for (const n of comment) unused.delete(n)
        if (FULLSCREEN.test(node.tag)) {
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
          message: `raw <${node.name}>: use <AppModal size="prompt|form|wide">`,
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
