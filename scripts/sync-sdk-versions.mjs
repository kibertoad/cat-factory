#!/usr/bin/env node
// Restamps each SDK's `User-Agent` version constant from its package manifest. It is the WRITE
// side of the invariant that `scripts/check-sdks.mjs` only VERIFIES, and the twin of
// `scripts/sync-runner-image-tags.mjs`.
//
// Why this exists: `@cat-factory/sdk` (the TypeScript client) is an ordinary workspace package, so
// changesets bumps `sdk/typescript/package.json` when it builds the "Release Packages" PR. It has
// no idea two hand-written constants are derived from that number — `SDK_VERSION` in the
// TypeScript transport, and `Version` in the Go one, which tracks the TypeScript manifest because
// a Go module carries no version of its own. Both stay behind, and the release PR is born red on
// the version-skew half of `check:sdk`, which is exactly the sort of red the repo's own guidance
// says not to hand-fix. Wiring this into the root `version` script
// (`changeset version && … && node scripts/sync-sdk-versions.mjs`) makes the release PR
// self-consistent by construction instead.
//
// Safe to run by hand at any time: it is a no-op when everything already agrees. The manifest is
// always the authority and the constant is always derived — the table lives in
// `scripts/sdk/versions.mjs` so this and the guard cannot drift.
//
// Usage:  node scripts/sync-sdk-versions.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readDeclaredVersion, replaceDeclaredVersion, VERSION_SOURCES } from './sdk/versions.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  let changed = 0
  for (const { sdk, manifest, constant } of VERSION_SOURCES) {
    const declared = readDeclaredVersion(
      await readFile(resolve(repoRoot, manifest.path), 'utf8'),
      manifest,
    )
    const before = await readFile(resolve(repoRoot, constant.path), 'utf8')
    if (readDeclaredVersion(before, constant) === declared) continue

    const after = replaceDeclaredVersion(before, constant, declared)
    await writeFile(resolve(repoRoot, constant.path), after)
    console.log(`[${sdk}] synced ${constant.path} -> ${declared} (from ${manifest.path})`)
    changed += 1
  }
  console.log(
    changed === 0
      ? 'SDK version constants already match their manifests.'
      : `Synced ${changed} SDK version constant(s).`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
