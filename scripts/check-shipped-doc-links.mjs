#!/usr/bin/env node
// Fails on a markdown document that SHIPS in a published tarball and carries a relative link
// escaping its own package root.
//
// Why this needs a guard rather than care: the link resolves perfectly from a checkout, so it is
// invisible to everyone who works in this repo, and broken for exactly the reader it was written
// for. `@cat-factory/app`'s `app/docs/consumer-extensions.md` pointed at the reusable-operations
// reference with `../../../../backend/docs/reusable-operations.md`, four levels above the tarball,
// and an org building a proprietary operation against the published packages could not read the
// one document that answered most of what they then filed as gaps.
//
// The fix is an ABSOLUTE URL, never a shorter relative path: the material lives in a public repo,
// and a link that works from both a checkout and an install is one that names the canonical
// location rather than a position relative to the reader.
//
// Usage:  node scripts/check-shipped-doc-links.mjs
// Exit 0 = clean; exit 1 = at least one shipped doc links outside its package.

import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findViolations } from './shipped-doc-links.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The same workspace globs the publish-integrity guard walks, for the same reason: private
// packages drop out at read time, so listing every glob costs nothing and keeps the two symmetric.
const WORKSPACE_GLOBS = [
  'backend/packages/*',
  'backend/runtimes/*',
  'backend/internal/*',
  'frontend/app',
  'deploy/backend',
  'deploy/frontend',
  'deploy/node',
  'deploy/local',
  'sdk/*',
]

function expandGlob(glob) {
  if (!glob.endsWith('/*')) return [glob]
  const base = glob.slice(0, -2)
  return readdirSync(join(repoRoot, base))
    .map((entry) => join(base, entry))
    .filter((rel) => {
      try {
        return statSync(join(repoRoot, rel)).isDirectory()
      } catch {
        return false
      }
    })
}

const packageDirs = WORKSPACE_GLOBS.flatMap(expandGlob).map((rel) => join(repoRoot, rel))
const violations = findViolations(packageDirs)

if (violations.length === 0) {
  console.log(
    `check-shipped-doc-links: every markdown file shipped by ${packageDirs.length} workspace ` +
      `packages links inside its own tarball.`,
  )
  process.exit(0)
}

console.error('Shipped documentation links outside its own package tarball:\n')
for (const violation of violations) {
  console.error(`  ${violation.package}: ${relative(repoRoot, violation.doc)}`)
  for (const target of violation.targets) console.error(`      ${target}`)
}
console.error(
  '\nA relative link that leaves the package root resolves only from a checkout, so it is dead ' +
    'for the consumer who installed the package. Replace it with an absolute ' +
    'https://github.com/kibertoad/cat-factory/blob/main/... URL, or move the material into the ' +
    'package.',
)
process.exit(1)
