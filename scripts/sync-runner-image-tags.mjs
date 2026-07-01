#!/usr/bin/env node
// Keeps the per-run container image pins in lockstep with the harness package
// versions that changesets owns. It is the WRITE side of the invariant that
// scripts/check-runner-image-tag.mjs only VERIFIES.
//
// Why this exists: the harness `version` is the container image tag, but it is
// declared in TWO worlds that move at different times. A feature PR hand-pins the
// tag (so the image can be published + deployed at dev time) AND ships a changeset
// for the harness. When the changesets action later builds the "Release Packages"
// PR it consumes that changeset and bumps the harness `version` AGAIN — but it has
// no idea the deploy pins exist, so they stay behind and the release PR is born
// with tag drift (red CI on the consistency guard). This script re-derives every
// pin from the (already-bumped) harness `version`, so wiring it into the root
// `version` script (`changeset version && node scripts/sync-runner-image-tags.mjs`)
// makes the release PR self-consistent by construction.
//
// It is also safe to run by hand at any time (it is a no-op when everything already
// matches) and mirrors the image descriptors in scripts/check-runner-image-tag.mjs
// — keep the two in sync when adding an image or a pin location.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// One descriptor per per-run container image. `image` is the bare image name; a
// pin is `<image>:<semver>` anywhere in a target file (bare, `-t`-prefixed, or
// registry-prefixed). The `\d`-anchored tag match deliberately skips non-semver
// example tags like `cat-factory-executor:local` mentioned in prose/comments.
const IMAGES = [
  {
    label: 'executor',
    image: 'cat-factory-executor',
    harnessPkg: 'backend/internal/executor-harness/package.json',
    targets: [
      'deploy/backend/package.json',
      'deploy/backend/wrangler.toml',
      // RECOMMENDED_HARNESS_IMAGE — the tag local mode pins + pulls at boot; must
      // stay a matched set with the backend (see CLAUDE.md → Releases & changesets).
      'backend/runtimes/local/src/harnessImage.ts',
    ],
  },
  {
    label: 'deploy',
    image: 'cat-factory-deploy',
    harnessPkg: 'backend/internal/deploy-harness/package.json',
    targets: ['deploy/backend/package.json', 'deploy/backend/wrangler.toml'],
  },
]

function readRepoFile(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8')
}

let changed = 0
for (const { label, image, harnessPkg, targets } of IMAGES) {
  const version = JSON.parse(readRepoFile(harnessPkg)).version
  if (!version) {
    console.error(`::error::[${label}] could not read "version" from ${harnessPkg}.`)
    process.exitCode = 1
    continue
  }
  // `<image>:<digit...>` — semver tags only, so example tags like `:local` are left alone.
  const tagRe = new RegExp(`(${image}:)\\d[^"'\\s]*`, 'g')
  const replacement = `$1${version}`
  for (const target of targets) {
    const before = readRepoFile(target)
    const after = before.replace(tagRe, replacement)
    if (after !== before) {
      writeFileSync(resolve(repoRoot, target), after)
      console.log(`[${label}] synced ${target} -> ${image}:${version}`)
      changed += 1
    }
  }
}

console.log(
  changed === 0
    ? 'Runner image pins already in sync with the harness versions.'
    : `Synced ${changed} runner image pin(s) to the harness versions.`,
)
