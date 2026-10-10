#!/usr/bin/env node
// Bans the two hand-built feedback states in the SPA layer (issue #2252).
//
//   1. `toast.add(` outside the two toast funnels. A failed call is reported by
//      `usePipelineErrorToast().present` (with its bespoke-conflict factory under
//      `composables/pipelineErrorToast/`); every other toast comes from `useActionToast()`, whose
//      tone fixes the colour, the icon and the duration. A direct `toast.add` picks those per
//      site, which is how one "saved" toast came to be green with a check and the next grey with
//      no icon.
//   2. `animate-spin` outside `components/common/Spinner.vue`. A Nuxt UI component with a
//      `loading` prop takes `:loading`; a bare icon that shows work in progress is a `<Spinner>`.
//      This also covers the `:ui="{ leadingIcon: 'animate-spin' }"` idiom, which spun a button's
//      own icon by hand where `:loading` was the prop.
//
// Comments are blanked (`lib/frontend-scan.mjs`), so a line ABOUT a rule is not read as an
// application of it. Spec files are not scanned: a test may build a toast to assert against.
//
// Policy: ZERO offenders, with no waiver comment. The only exception is `PENDING` below: files
// another open change is rewriting, named with the reason. A pending file that no longer offends
// FAILS the guard, so its entry is deleted the moment the file is converted.
//
// Usage:  node scripts/check-frontend-feedback.mjs
// Exit 0 = clean; exit 1 = an offender was found.

import { isCliEntry, readCodeLines, spaSourceFiles } from './lib/frontend-scan.mjs'

const APP = 'frontend/app/app/'

// The files allowed to call `toast.add(`. A trailing `/` admits a directory.
export const TOAST_FUNNELS = [
  `${APP}composables/usePipelineErrorToast.ts`,
  `${APP}composables/pipelineErrorToast/`,
  `${APP}composables/useActionToast.ts`,
]

// The one file allowed to write `animate-spin`.
export const SPINNER = `${APP}components/common/Spinner.vue`

// Files other open work is rewriting, so converting them here would only conflict. The task
// card family is restructured by #2251, #2312 and #2325; convert these after those land.
export const PENDING = {
  [`${APP}components/board/nodes/TaskCard.vue`]: 'task-card rework (#2251, #2312, #2325)',
  [`${APP}components/board/nodes/TaskPipelineMini.vue`]: 'task-card rework (#2251, #2312, #2325)',
  // `subtaskIconClass` keeps a hand-written spin for `TaskPipelineMini.vue` alone; every other
  // consumer reads `subtaskIconSpins` + `subtaskIconTone`. Delete with the entry above.
  [`${APP}utils/pipelineRender.ts`]: 'serves TaskPipelineMini.vue until the task-card rework',
}

// `(?<![\w.])` keeps `mytoast.add(` and a chained `x.toast.add(` apart from a bare `toast.add(`:
// the second is a store context handle (`ctx.toast`), which is the same defect, so it is claimed
// by the dotted branch. `useToast().add(` skips the variable altogether.
const TOAST_ADD = /(?:(?<![\w$])|\.)toast\.add\(|useToast\(\)\.add\(/g
const ANIMATE_SPIN = /(?<![\w-])animate-spin(?![\w-])/g

const admits = (rel, list) =>
  list.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry))

/** The rule names one `codeLines` line breaks for a file at `rel`, or [] for a clean line. Pure,
 * so the companion test can drive it with fixtures. */
export function findFeedbackOffences(rel, { code }) {
  const found = []
  if (!admits(rel, TOAST_FUNNELS) && code.match(TOAST_ADD)) found.push('toast.add(')
  if (rel !== SPINNER && code.match(ANIMATE_SPIN)) found.push('animate-spin')
  return found
}

function main() {
  const offenders = []
  const pendingStillOffends = new Set()
  for (const file of spaSourceFiles()) {
    if (file.rel.endsWith('.spec.ts')) continue
    readCodeLines(file).forEach((line, i) => {
      const matches = findFeedbackOffences(file.rel, line)
      if (!matches.length) return
      if (file.rel in PENDING) pendingStillOffends.add(file.rel)
      else offenders.push({ file: file.rel, line: i + 1, matches })
    })
  }
  const stalePending = Object.keys(PENDING).filter((rel) => !pendingStillOffends.has(rel))

  if (offenders.length || stalePending.length) {
    console.error('Hand-built feedback states are banned in the SPA (issue #2252).')
    console.error(
      'A failed call is a toast through `usePipelineErrorToast().present(error, titleKey)`.\n' +
        'Every other toast goes through `useActionToast()`: `success`, `info`, `warning` or\n' +
        '`error` with a title KEY. The tone decides colour, icon and duration.\n' +
        'A Nuxt UI component with a `loading` prop takes `:loading`, never a spun icon. A bare\n' +
        'loading glyph is `<Spinner>` (`components/common/Spinner.vue`), `:spinning` for a status\n' +
        'icon that only spins in one state.\n' +
        'See frontend/app/README.md, "Every failure toast goes through ONE funnel" and the\n' +
        'loading and empty-state rules after it.\n',
    )
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.matches.join(' ')}`)
    for (const rel of stalePending) {
      console.error(`  ${rel}  is listed as PENDING but is clean: delete its PENDING entry.`)
    }
    console.error(
      `\n${offenders.length} offending line(s), ${stalePending.length} stale entr(ies).`,
    )
    process.exit(1)
  }

  console.log(
    'check-frontend-feedback: every toast goes through a funnel and every spinner is <Spinner>' +
      ` (${Object.keys(PENDING).length} file(s) pending other work).`,
  )
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
