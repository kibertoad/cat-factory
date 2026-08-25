#!/usr/bin/env node
// Guards the Cloudflare runtime pins: exactly ONE wrangler / workerd / miniflare resolves, every
// workspace declaration of `wrangler` is that exact version, and `@cloudflare/workers-types` is
// pinned to the date the resolved workerd ships. The rules and the reasoning live in
// `cloudflare-runtime-pins.mjs` (the testable detection half); this is the CLI ci.yml's
// repo-guards job runs.
//
// It replaces a top-level `wrangler` override, which held the invariant only until the next
// @cloudflare/vitest-pool-workers bump and then silently held the wrong thing. Asserting the
// RESULT off the lockfile costs no install and no network, and it names the fix.
//
// Usage:  node scripts/check-cloudflare-runtime-pins.mjs
// Exit 0 = clean; exit 1 = the tested runtime and the shipped runtime can diverge.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectResolvedVersions, findPinViolations } from './cloudflare-runtime-pins.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Mirrors pnpm-workspace.yaml's `packages:`, same as check-package-catalog.mjs does and for the
// same reason: the set changes rarely, and reading every workspace manifest is what makes a NEW
// package declaring wrangler fall under the rule without anyone remembering to list it here.
const WORKSPACE_GLOBS = [
  'backend/packages/*',
  'backend/runtimes/*',
  'backend/internal/*',
  'frontend/app',
  'deploy/backend',
  'deploy/frontend',
  'deploy/node',
  'deploy/local',
  'deploy/gatekeeper',
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

const manifests = WORKSPACE_GLOBS.flatMap(expandGlob)
  .map((relDir) => {
    try {
      return {
        path: `${relDir}/package.json`,
        manifest: JSON.parse(readFileSync(join(repoRoot, relDir, 'package.json'), 'utf8')),
      }
    } catch {
      return null
    }
  })
  .filter(Boolean)

const resolved = collectResolvedVersions(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
const violations = findPinViolations({ resolved, manifests })

for (const { where, message } of violations) {
  console.error(`${where}: ${message}`)
}

if (violations.length > 0) {
  console.error(`\ncheck-cloudflare-runtime-pins: ${violations.length} problem(s).`)
  process.exit(1)
}

const summary = ['wrangler', 'workerd', 'miniflare']
  .map((name) => `${name}@${(resolved.get(name) ?? [])[0]}`)
  .join(', ')
console.log(`check-cloudflare-runtime-pins: one copy each of ${summary}, types in step.`)
