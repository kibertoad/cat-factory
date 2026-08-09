#!/usr/bin/env node
// Fails when a relative link in a repo markdown file names a path or a heading that is not there.
//
// The class it closes, and why the two guards that sound like they cover it do not, is in
// `doc-links.mjs`. The short version: nothing else opens an ordinary markdown link, so `git rm`ing
// a doc (which CLAUDE.md requires when an initiative tracker converts to an ADR), renaming one, or
// getting the `../` depth wrong was green.
//
// Usage:  node scripts/check-doc-links.mjs
// Exit 0 = clean; exit 1 = at least one link cannot be followed.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brokenLinks, isFrozenHistory, repoLinks } from './doc-links.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.nuxt',
  '.output',
  'coverage',
  '.turbo',
  // The Cloudflare OS checkout the nightly Gatekeeper leg boots (`GATEKEEPER_OS_DIR`). It lands
  // inside this root because wrangler's test harness boots both Workers under one, and it is
  // somebody else's tree: its links are theirs to keep working.
  '.cloudflare-os',
])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

const toRepoRel = (file) => relative(repoRoot, file).split('\\').join('/')

const lookup = (path) => {
  try {
    return statSync(join(repoRoot, path)).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}
const readDoc = (path) => readFileSync(join(repoRoot, path), 'utf8')

let documents = 0
let checked = 0
const failures = []

for (const file of walk(repoRoot)) {
  if (!file.endsWith('.md')) continue
  const docRelPath = toRepoRel(file)
  if (isFrozenHistory(docRelPath)) continue
  documents++
  const links = repoLinks(readFileSync(file, 'utf8'), docRelPath)
  checked += links.length
  for (const broken of brokenLinks(links, lookup, readDoc)) {
    failures.push(`${docRelPath}: ${broken.target} (${broken.reason})`)
  }
}

// A guard that silently stops matching reports green forever, which is worse than a false alarm.
// This repo has over a thousand in-repo markdown links; a count near zero means the extractor
// stopped recognising them, not that somebody cleaned up.
if (checked < 100) {
  console.error(
    `check-doc-links: found only ${checked} in-repo link(s) across ${documents} document(s). ` +
      'The extractor has stopped matching; fix `repoLinks` in scripts/doc-links.mjs.',
  )
  process.exit(1)
}

if (failures.length > 0) {
  console.error('Repo-relative documentation links that cannot be followed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    `\n${failures.length} broken link(s) across ${documents} document(s).\n` +
      'Point each at where the content actually went. When a doc was deleted on purpose (an\n' +
      'initiative tracker converting to an ADR is the usual case), the link belongs on the ADR that\n' +
      'replaced it, not on the deleted file.',
  )
  process.exit(1)
}

console.log(
  `check-doc-links: ${checked} in-repo link(s) across ${documents} document(s) all resolve.`,
)
