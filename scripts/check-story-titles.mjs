#!/usr/bin/env node
// Audits the mechanical half of the story conventions in `docs/internal/storybook.md`.
//
// The sidebar is UI for a human; the filesystem is for the code. Left alone, a Storybook sidebar
// grows into a mirror of the component tree, and the reader has to know where a thing lives before
// they can find it. So a title names the SURFACE a user recognises, in three segments:
//
//   <Domain>/<Kind>/<Component>        Board/Components/DecisionBadge
//
// WHAT IS CHECKED, and so what a reviewer never has to:
//   - three segments, no more and no less, with the domain and the kind from CLOSED vocabularies;
//   - the last segment is the file's own stem, which is also what makes "one stories file per
//     component" mechanical: two files cannot claim one title without colliding here;
//   - no title collides with another file's;
//   - a stories file sits beside the component it documents;
//   - `Default`, where a file has one, is the FIRST export, so the sidebar opens on the real thing
//     rather than on an edge case;
//   - story exports are PascalCase, and no title carries a dash, which is the shape a variant takes
//     when it wants to be a story inside its stem rather than a sibling of it.
//
// What is NOT checked, and stays review's: whether the domain is the right one, whether a story
// earns its place, and whether the names after `Default` / `Empty` / `Loading` / `Error` describe
// states a reader cares about. A guard can keep the shelf tidy; it cannot tell you what to shelve.
//
// Adding a domain is deliberate: add it below, and expect to justify it, because every new one is
// a new top-level node in a sidebar that is supposed to stay readable.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isCliEntry, readCodeLines, spaSourceFiles } from './lib/frontend-scan.mjs'

/** Top-level sidebar nodes. Product language, not folder names. */
export const DOMAINS = [
  'Board',
  'Documents',
  'Inspector',
  'Pipeline',
  'Primitives',
  'Review',
  'Run telemetry',
  'Settings',
  'Setup',
  'Shell',
]

/** The second segment. A closed vocabulary so the sidebar's shape is the same under every domain. */
export const KINDS = ['Components', 'Pages', 'Scenes', 'Docs']

/** The states every surface is expected to be able to show, named the same way everywhere. */
export const STATE_VOCABULARY = ['Default', 'Empty', 'Loading', 'Error']

// `title:` is read LINE-ANCHORED and only AFTER the meta opens.
//
// Line-anchored is how the formatter writes a meta, and it keeps a component's own `title` ARG
// out (`InspectorSection`'s meta carries one). The meta anchor is the second half, and it was
// learned the hard way: `ServiceConnections.stories.ts` declares its board fixtures ABOVE the
// meta, one of them titled "Auth Service", and a first-match-wins read claimed that as the story
// title. Order is not a rule anyone would think to follow, so the parser stops relying on it.
//
// A meta collapsed onto a single line reports as "no title", which is loud and fixable, rather
// than silently matching the wrong string.
const META = /^\s*(?:const|let|var)\s+meta\b|^\s*export\s+default\s*\{/
const TITLE = /^\s*title:\s*'([^']*)'/
const STORY_EXPORT = /^\s*export const (\w+)\s*:/

/** The title and the ordered story exports of one stories file. */
export function parseStoryFile(lines) {
  let title = null
  let inMeta = false
  const exports = []
  for (const { code } of lines) {
    if (META.test(code)) inMeta = true
    if (inMeta && title === null) {
      const t = code.match(TITLE)
      if (t) title = t[1]
    }
    const e = code.match(STORY_EXPORT)
    if (e) exports.push(e[1])
  }
  return { title, exports }
}

/** Everything wrong with one stories file, as sentences a reader can act on. */
export function checkStoryFile({ stem, title, exports }) {
  const problems = []
  if (title === null) {
    problems.push('no `title:` in the meta; a story without one is filed by its path')
    return problems
  }
  if (title.includes('-') || title.includes('—')) {
    problems.push(
      `title "${title}" carries a dash; a variant is a STORY inside its stem, not a dashed sibling`,
    )
  }
  const segments = title.split('/')
  if (segments.length !== 3) {
    problems.push(
      `title "${title}" has ${segments.length} segment(s); the shape is <Domain>/<Kind>/<Component>`,
    )
    return problems
  }
  const [domain, kind, name] = segments
  if (!DOMAINS.includes(domain)) {
    problems.push(`domain "${domain}" is not one of: ${DOMAINS.join(', ')}`)
  }
  if (!KINDS.includes(kind)) {
    problems.push(`kind "${kind}" is not one of: ${KINDS.join(', ')}`)
  }
  if (name !== stem) {
    problems.push(`title names "${name}" but the file is "${stem}.stories.ts"`)
  }
  for (const e of exports) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(e)) problems.push(`story export "${e}" is not PascalCase`)
  }
  if (exports.includes('Default') && exports[0] !== 'Default') {
    problems.push(`"Default" is exported after "${exports[0]}"; it leads the file`)
  }
  return problems
}

function main() {
  const offenders = []
  const byTitle = new Map()

  for (const file of spaSourceFiles()) {
    if (!file.rel.endsWith('.stories.ts')) continue
    const stem = file.rel.split('/').at(-1).replace('.stories.ts', '')
    const { title, exports } = parseStoryFile(readCodeLines(file))
    const problems = checkStoryFile({ stem, title, exports })

    const componentPath = join(file.abs, '..', `${stem}.vue`)
    if (!existsSync(componentPath)) {
      problems.push(`no ${stem}.vue beside it; a stories file lives with what it documents`)
    }
    if (title) {
      const seen = byTitle.get(title)
      if (seen) problems.push(`title "${title}" is already claimed by ${seen}`)
      else byTitle.set(title, file.rel)
    }
    if (problems.length) offenders.push({ file: file.rel, problems })
  }

  if (offenders.length) {
    console.error('Story titles break the conventions in docs/internal/storybook.md.\n')
    for (const o of offenders) {
      console.error(`  ${o.file}`)
      for (const p of o.problems) console.error(`    - ${p}`)
    }
    console.error(`\n${offenders.length} stories file(s) to fix.`)
    process.exit(1)
  }

  console.log(`check-story-titles: ${byTitle.size} stories file(s), every title in shape.`)
}

// Run the filesystem scan only as a CLI; importing for tests must have no side effects.
if (isCliEntry(import.meta.url)) main()
