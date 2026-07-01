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
// matches). The image descriptors + pin locations are the shared source of truth in
// scripts/runner-images.mjs, so this and the guard can't drift.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEPLOY_PKG, IMAGES, readRepoFile, repoRoot, WRANGLER } from './runner-images.mjs'

let changed = 0
for (const { label, image, harnessPkg, extraPins } of IMAGES) {
  const version = JSON.parse(readRepoFile(harnessPkg)).version
  if (!version) {
    console.error(`::error::[${label}] could not read "version" from ${harnessPkg}.`)
    process.exitCode = 1
    continue
  }
  // `<image>:<digit...>` — semver tags only, so example tags like `:local` are left alone.
  const tagRe = new RegExp(`(${image}:)\\d[^"'\\s]*`, 'g')
  const replacement = `$1${version}`
  for (const target of [DEPLOY_PKG, WRANGLER, ...extraPins]) {
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
