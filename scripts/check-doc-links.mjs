#!/usr/bin/env node
// Fails on a documentation link this repository publishes that does not resolve.
//
// Two halves, both explained at length in `doc-links.mjs` (the detection module):
//
//   1. A `https://www.catfactory.ai/...` URL, in markdown OR in source, must name a page recorded
//      in `docs/website-pages.txt`. The website page lands first; the inventory line is how a
//      reviewer sees that it did, without holding another repository's deploy state in their head.
//   2. An IN-REPO doc URL built in code (`DOCS.*`, `VCS_DOC_URLS`) must name a markdown file that
//      exists, and any section anchor it deep-links must exist as a heading in that file. These
//      URLs sit in operator-facing error messages, so whoever follows one is already stuck.
//
// Usage:  node scripts/check-doc-links.mjs
// Exit 0 = clean; exit 1 = at least one link cannot be followed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokenDocAnchors,
  docsReferences,
  parseBlobTemplatePaths,
  parseDocsMap,
  parseEnvVarAnchors,
  parseWebsitePages,
  unknownWebsiteLinks,
  websiteTemplatePaths,
} from './doc-links.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.nuxt',
  '.output',
  'coverage',
  'target',
])

// CHANGELOGs are generated from merged changesets: a link inside one is a historical record of what
// a past release said, not a claim this checkout is making, and rewriting one to satisfy a guard
// would falsify the history it exists to keep.
//
// The guards' own fixtures are exempt for the reason every detector's fixtures are: they must be
// free to spell the thing being banned. `doc-links.test.mjs` asserts that an unrecorded page IS
// caught, which it can only do by containing one.
const SKIP_FILES = /(^|\/)CHANGELOG\.md$|(^|\/)scripts\/[\w-]+\.test\.mjs$/

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const read = (path) => readFileSync(join(repoRoot, path), 'utf8')
const readDoc = (path) => {
  try {
    const full = join(repoRoot, path)
    return statSync(full).isFile() ? readFileSync(full, 'utf8') : null
  } catch {
    return null
  }
}

const failures = []

// ---------------------------------------------------------------------------
// 1. Website URLs name a recorded page, in prose and in code alike.
// ---------------------------------------------------------------------------
// `.txt` is in the list only so the inventory cannot quietly list a page under a typo'd path that
// nothing else references; it is checked against itself and passes trivially.
const LINKING_FILE = /\.(md|mts|mjs|ts|tsx|js|vue|txt)$/
const pages = parseWebsitePages(read('docs/website-pages.txt'))
for (const file of walk(repoRoot)) {
  const rel = relative(repoRoot, file).split('\\').join('/')
  if (!LINKING_FILE.test(rel) || SKIP_FILES.test(rel)) continue
  const text = readFileSync(file, 'utf8')
  for (const target of unknownWebsiteLinks(text, pages)) {
    failures.push({ where: rel, detail: `${target} is not a page in docs/website-pages.txt` })
  }
  for (const path of websiteTemplatePaths(text)) {
    if (pages.has(path.split('#')[0].split('?')[0])) continue
    failures.push({
      where: rel,
      detail: `a URL composed onto the site base names ${path}, which is not in docs/website-pages.txt`,
    })
  }
}

// ---------------------------------------------------------------------------
// 2. Code-built doc URLs resolve to a file and a heading.
// ---------------------------------------------------------------------------
const DOCS_MODULE = 'backend/packages/server/src/config/docs.ts'
const VCS_ERRORS_MODULE = 'backend/packages/kernel/src/domain/vcs-errors.ts'
const docsSource = read(DOCS_MODULE)
const docsMap = parseDocsMap(docsSource)
const envAnchors = parseEnvVarAnchors(docsSource)

if (docsMap.size === 0 || envAnchors.size === 0) {
  // A guard that silently stops matching reports green forever, which is worse than a false alarm.
  console.error(
    `check-doc-links: read no DOCS entries (${docsMap.size}) or no ENV_VARS_ANCHORS ` +
      `(${envAnchors.size}) from ${DOCS_MODULE}. The declarations moved or changed shape; ` +
      'update `parseDocsMap` / `parseEnvVarAnchors` in scripts/doc-links.mjs to follow them.',
  )
  process.exit(1)
}

// Every DOCS entry's own target, whether or not anything calls it yet.
const references = [...docsMap.entries()].map(([key, path]) => ({
  key,
  path,
  anchor: null,
  call: `DOCS.${key}`,
  where: DOCS_MODULE,
}))
// The paths kernel spells out itself, since it sits below the server layer and keeps its own copy.
for (const path of parseBlobTemplatePaths(read(VCS_ERRORS_MODULE))) {
  references.push({ key: path, path, anchor: null, call: path, where: VCS_ERRORS_MODULE })
}
// Every anchored call site.
for (const file of walk(join(repoRoot, 'backend'))) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue
  const rel = relative(repoRoot, file).split('\\').join('/')
  if (rel === DOCS_MODULE) continue
  const source = readFileSync(file, 'utf8')
  if (!source.includes('DOCS.')) continue
  for (const ref of docsReferences(source, docsMap, envAnchors)) {
    references.push({ ...ref, where: rel })
  }
}

for (const broken of brokenDocAnchors(references, readDoc)) {
  failures.push({
    where: broken.where,
    detail: `${broken.call} → ${broken.path}: ${broken.reason}`,
  })
}

if (failures.length === 0) {
  console.log(
    `check-doc-links: every catfactory.ai link names one of ${pages.size} recorded pages, and ` +
      `all ${references.length} code-built doc URLs resolve to a file and a heading.`,
  )
  process.exit(0)
}

console.error('Documentation links that a reader cannot follow:\n')
for (const { where, detail } of failures) console.error(`  ${where}\n      ${detail}`)
console.error(
  '\nA website link must name a page in docs/website-pages.txt: publish the page first, then add ' +
    'its path there in the same PR that links it. A code-built doc URL names a file and a heading ' +
    'that must both exist: those URLs go into operator-facing error messages, so restore the ' +
    'heading rather than repointing the link at the top of the page.',
)
process.exit(1)
