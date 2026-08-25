#!/usr/bin/env node
// Guards the one thing the `[WARN] Failed to create bin` lines every install prints actually
// costs: a package script that spawns a WORKSPACE CLI by its bin name resolves through a
// `node_modules/.bin` shim `pnpm install` could not create, because the bin points at a `dist/`
// file no fresh checkout has yet. The rule, the failure it produces and what is deliberately out
// of scope live in `workspace-bin-scripts.mjs` (the testable detection half); this is the CLI
// that ci.yml's repo-guards job runs.
//
// Usage:  node scripts/check-workspace-bin-scripts.mjs
// Exit 0 = clean; exit 1 = at least one script spawns an unlinkable workspace bin by name.

import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectUnlinkableBins, findWorkspaceBinCalls } from './workspace-bin-scripts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The workspace globs from pnpm-workspace.yaml, plus the root manifest (its scripts run through
// the same PATH). Listed literally rather than parsed out of the YAML: "every workspace member is
// accounted for" is check-package-catalog.mjs's invariant, not this one's.
const PACKAGE_GLOBS = [
  'package.json',
  'backend/packages/*/package.json',
  'backend/runtimes/*/package.json',
  'backend/internal/*/package.json',
  'frontend/app/package.json',
  'deploy/*/package.json',
  'sdk/*/package.json',
]

const manifests = PACKAGE_GLOBS.flatMap((pattern) =>
  globSync(pattern, { cwd: root })
    .sort()
    .map((match) => {
      const path = match.split('\\').join('/')
      return {
        ...JSON.parse(readFileSync(resolve(root, path), 'utf8')),
        path,
        dir: path.slice(0, Math.max(0, path.lastIndexOf('/'))),
      }
    }),
)

// One `git ls-files` over the whole tree rather than a spawn per bin: four spawns today, but the
// per-path form also reports an untracked path as a non-zero EXIT, which is indistinguishable
// from git itself failing.
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean),
)

const unlinkableBins = collectUnlinkableBins(manifests, (repoPath) => tracked.has(repoPath))
const findings = findWorkspaceBinCalls(manifests, unlinkableBins)

for (const { path, script, command, bin, owner } of findings) {
  console.error(
    `${path}: script "${script}" spawns "${bin}", a bin of the workspace package ${owner}:\n` +
      `    ${command}\n` +
      `  ${owner} declares that bin at a build output, so pnpm cannot link the shim on a fresh\n` +
      `  checkout and nothing re-links bins after a build: this fails with "${bin}: not found"\n` +
      `  for anyone who just cloned. Spawn the built entry by path instead, e.g.\n` +
      `  \`node <relative-path>/dist/bin.js\`, behind a pre-task that builds ${owner}.`,
  )
}

if (findings.length > 0) {
  process.exit(1)
}
console.log(
  `check-workspace-bin-scripts: ${manifests.length} manifests, ${unlinkableBins.size} bins that ` +
    `cannot link on a fresh checkout, none spawned by name.`,
)
