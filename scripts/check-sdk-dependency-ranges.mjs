#!/usr/bin/env node
// Guards how the published SDK packages under `sdk/` name each other. pnpm rewrites a `workspace:*`
// dependency to the EXACT version at publish, so a consumer one patch ahead on `@cat-factory/sdk`
// installs a second copy of it. A runtime dependency on a sibling is `workspace:^`.
//
// A peer on a sibling is the consumer's own copy, so it has to stay a fixed range written out by
// hand (`workspace:>=0.57.0 <1.0.0`). `workspace:^` would follow each release and turn the peer back
// into a one-minor pin.
//
// The backend libraries are out of scope: they publish as one lockstep set.
//
// Usage:  node scripts/check-sdk-dependency-ranges.mjs
// Exit 0 = clean; exit 1 = a published SDK package pins a sibling.

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/
const RELEASE_TRACKING = new Set(['*', '^', '~'])

/**
 * The sibling ranges in `manifests` that publish as a pin. Each manifest is a parsed package.json
 * plus its repo-relative `path`; private manifests never publish and are skipped.
 */
export function findPinnedSiblings(manifests) {
  const violations = []
  for (const manifest of manifests) {
    if (manifest.private) continue
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        const reason = pinReason(field, spec)
        if (reason) violations.push({ path: manifest.path, field, name, spec, reason })
      }
    }
  }
  return violations
}

function pinReason(field, spec) {
  if (!spec.startsWith('workspace:')) return null
  const range = spec.slice('workspace:'.length)
  if (range === '*' || EXACT_VERSION.test(range)) {
    return field === 'peerDependencies'
      ? 'a peer on a sibling is a hand-written range, e.g. "workspace:>=0.57.0 <1.0.0"'
      : 'publishes as an exact version; use "workspace:^"'
  }
  if (field === 'peerDependencies' && RELEASE_TRACKING.has(range)) {
    return 'follows each release, so the peer becomes a one-minor pin; write the range out'
  }
  return null
}

function main() {
  const manifests = globSync('sdk/*/package.json', { cwd: repoRoot })
    .sort()
    .map((match) => {
      const path = match.split('\\').join('/')
      return { ...JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')), path }
    })
  const violations = findPinnedSiblings(manifests)

  for (const { path, field, name, spec, reason } of violations) {
    console.error(`${path}: ${field}["${name}"] is "${spec}": ${reason}.`)
  }
  if (violations.length > 0) process.exit(1)
  console.log(`check-sdk-dependency-ranges: ${manifests.length} manifests, no sibling pinned.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
