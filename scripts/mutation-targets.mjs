#!/usr/bin/env node
// The single source of truth for WHICH packages are mutation-tested: a package is a target when
// it has a `stryker.config.mjs` beside its package.json. Adding a package to the nightly is
// therefore ONE file, not a config plus a matching workflow edit (the second of which is silently
// a no-op when forgotten, and the mutation flow would keep reporting green over a package it never
// ran).
//
// Used by `.github/workflows/mutation.yml` to build its job matrix (`--json`), and printable for
// a human wondering what the nightly covers. Model: `docs/mutation-testing.md`.
//
// Usage:
//   node scripts/mutation-targets.mjs                 # one package name per line
//   node scripts/mutation-targets.mjs --json          # JSON array, for the CI matrix
//   node scripts/mutation-targets.mjs --json --only @cat-factory/kernel

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Workspace roots that may hold a mutation-tested package (mirrors `pnpm-workspace.yaml`). */
const PACKAGE_ROOTS = ['backend/packages', 'backend/runtimes', 'backend/internal']

const CONFIG_FILE = 'stryker.config.mjs'

/**
 * @returns {{ name: string, dir: string, slug: string }[]} every mutation-tested package,
 * name-sorted. `slug` is the directory basename: artifact names may not contain a `/`, so the
 * scoped package name cannot be used for one.
 */
export function findMutationTargets() {
  const targets = []
  for (const root of PACKAGE_ROOTS) {
    const absRoot = path.join(repoRoot, root)
    if (!fs.existsSync(absRoot)) continue
    for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      if (!fs.existsSync(path.join(repoRoot, dir, CONFIG_FILE))) continue
      const manifestPath = path.join(repoRoot, dir, 'package.json')
      const { name } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      targets.push({ name, dir: dir.replaceAll(path.sep, '/'), slug: entry.name })
    }
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name))
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const only = args[args.indexOf('--only') + 1]

let targets = findMutationTargets()

// A discovery that found nothing must FAIL rather than print an empty list: an empty CI matrix
// runs no jobs and reports the workflow green, which reads exactly like a nightly that mutated
// every package and found nothing wrong.
if (targets.length === 0) {
  console.error(
    `No mutation targets found: no ${CONFIG_FILE} under ${PACKAGE_ROOTS.join(', ')}.\n` +
      'Either a package config was deleted or this script is looking in the wrong place.',
  )
  process.exit(1)
}

if (args.includes('--only') && only) {
  const match = targets.filter((t) => t.name === only || t.dir === only)
  // Same rule for an explicit selection: a typo'd package name must name itself, not quietly
  // shrink the run to nothing.
  if (match.length === 0) {
    console.error(
      `"${only}" is not a mutation target. Known targets:\n` +
        targets.map((t) => `  ${t.name} (${t.dir})`).join('\n'),
    )
    process.exit(1)
  }
  targets = match
}

if (asJson) {
  console.log(JSON.stringify(targets))
} else {
  for (const { name, dir } of targets) console.log(`${name}\t${dir}`)
}
