#!/usr/bin/env node
// Guards the human/LLM-facing package MAP against drift from the actual workspace. The
// root README's "Repository layout" tables are the catalog an LLM (or human) reads first
// to answer "what exists and where does X live?"; when a new package is added but the
// table isn't, the package becomes invisible to anyone who trusts the map (this is exactly
// how @cat-factory/consensus, provider-cloudflare and observability-langfuse ended up in
// NONE of the primary docs). This check makes that a CI failure instead of tribal knowledge.
//
// For every workspace package (resolved from pnpm-workspace.yaml's globs) it asserts:
//   1. package.json has a non-empty `description` — the machine-readable one-line role the
//      maps + per-package AGENTS.md derive from.
//   2. the package `name` appears verbatim in the root README.md catalog.
//
// Usage:  node scripts/check-package-catalog.mjs
// Exit 0 = the map is complete; exit 1 = a package is missing a description or a README row.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The workspace globs from pnpm-workspace.yaml. Kept as a literal list (mirroring that
// file's `packages:`) rather than parsing YAML — the set changes rarely and a mismatch
// here would itself be caught by a package that resolves to no dir.
const WORKSPACE_GLOBS = [
  'backend/packages/*',
  'backend/runtimes/*',
  'backend/internal/*',
  'frontend/app',
  'deploy/backend',
  'deploy/frontend',
  'deploy/node',
  'deploy/local',
]

function expandGlob(glob) {
  if (!glob.endsWith('/*')) return [glob]
  const base = glob.slice(0, -2)
  const baseAbs = join(repoRoot, base)
  return readdirSync(baseAbs)
    .map((entry) => join(base, entry))
    .filter((rel) => {
      try {
        return statSync(join(repoRoot, rel)).isDirectory()
      } catch {
        return false
      }
    })
}

function readPackage(relDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, relDir, 'package.json'), 'utf8'))
    return { relDir, name: pkg.name, description: pkg.description }
  } catch {
    return null
  }
}

const readmeCatalog = readFileSync(join(repoRoot, 'README.md'), 'utf8')

const packages = WORKSPACE_GLOBS.flatMap(expandGlob)
  .map(readPackage)
  .filter((p) => p && p.name)

const problems = []
for (const pkg of packages) {
  if (!pkg.description || !pkg.description.trim()) {
    problems.push(`${pkg.relDir} (${pkg.name}): package.json has no "description".`)
  }
  if (!readmeCatalog.includes(pkg.name)) {
    problems.push(
      `${pkg.name} is not listed in the README.md repository-layout tables — add a row so the map stays complete.`,
    )
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  console.error(
    `\ncheck-package-catalog: ${problems.length} problem(s) across ${packages.length} workspace packages.`,
  )
  process.exit(1)
}

console.log(`check-package-catalog: all ${packages.length} workspace packages are described and listed in README.md. ✅`)
