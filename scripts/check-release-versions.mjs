#!/usr/bin/env node
// Fails a branch that re-versions a package onto a number the npm registry already holds. The
// failure this prevents, and why the check has to run BEFORE the publish rather than read
// changesets' output after it, are in `release-versions.mjs`.
//
// In practice this is a Release-PR gate: only `changeset version` moves a version field, so on a
// feature PR it finds nothing changed, makes no network call, and exits immediately.
//
// Usage:  node scripts/check-release-versions.mjs [--since <ref>]
// Without `--since` there is no base to diff against and the check is a no-op, matching
// check-runner-image-tag.mjs (BASE_REF is empty off pull requests).
// Exit 0 = every version this branch introduces is free; exit 1 otherwise.

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedVersions, collisions, formatCollisions } from './release-versions.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sinceFlag = process.argv.indexOf('--since')
const since = sinceFlag === -1 ? null : process.argv[sinceFlag + 1]
if (!since) process.exit(0)

const git = (args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

function parseOrNull(text) {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A file's content at a ref, or null where it does not exist there (an ADDED package). */
function readAt(ref, path) {
  try {
    return git(['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

// Compare against the MERGE BASE, not the base branch's tip, and read the file list and the file
// contents at the same commit. Those are two different questions once the base has moved on: a
// Release PR sitting behind a main that already published its versions reads as "nothing changed"
// against the tip, which is the guard silently answering about the wrong branch. The merge base is
// the last commit both sides agree on, so a difference from it is something THIS branch introduces.
let mergeBase
try {
  mergeBase = git(['merge-base', since, 'HEAD']).trim()
} catch {
  console.error(
    `release versions: no merge base between HEAD and ${since}. A shallow checkout cannot answer ` +
      'which versions this branch introduces; the job needs fetch-depth: 0.',
  )
  process.exit(1)
}

const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD', '--', '**/package.json'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.endsWith('package.json') && !line.includes('node_modules/'))

const entries = changedFiles.map((path) => ({
  path,
  head: parseOrNull(readAt('HEAD', path)),
  base: parseOrNull(readAt(mergeBase, path)),
}))

const changed = changedVersions(entries)
if (changed.length === 0) process.exit(0)

// The abbreviated packument: a fraction of the full document's size and it still carries every
// version key, which is the only thing being asked here.
const ABBREVIATED = 'application/vnd.npm.install-v1+json'

/**
 * Every version the registry lists for a name (empty for a name never published).
 *
 * A registry that cannot be reached FAILS the check. Treating an unreachable registry as "the
 * version is free" is the fail-open answer, and it answers a question about the registry with a
 * fact about our network: exactly the confusion this guard exists to end.
 */
async function publishedVersions(name) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: ABBREVIATED } })
      if (response.status === 404) return []
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return Object.keys((await response.json()).versions ?? {})
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `could not read ${name} from the npm registry: ${lastError?.message ?? lastError}`,
  )
}

const looked = await Promise.all(
  changed.map(async (entry) => [entry.name, await publishedVersions(entry.name)]),
)

const found = collisions(changed, new Map(looked))
if (found.length === 0) {
  console.log(`release versions: ${changed.length} changed, none already on the registry`)
  process.exit(0)
}

console.error(formatCollisions(found))
process.exit(1)
