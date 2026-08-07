#!/usr/bin/env node
// CI drift guard for the four generated SDK clients and the MCP facade's tool table (twin of
// `scripts/generate-sdks.mjs`).
//
// Two independent checks, because they catch different mistakes:
//
//   1. **Generated-code drift.** Regenerates every SDK in memory and diffs it against what is
//      committed. A public-API contract change that is not followed by `pnpm gen:sdk` would
//      otherwise ship four clients that cannot call the endpoint they were built for — and,
//      worse, would do so silently: everything still compiles.
//   2. **Unreachable resource groups.** Only the Go client's accessor list is hand-written (the
//      other three generate theirs), so a new resource group generates a service type there that
//      nothing constructs. It compiles, it passes the drift check, and the endpoint is simply
//      uncallable from that one language: the exact hole `surface.mjs` exists to prevent, just
//      moved one file along. `me`, `evidence` and `keys` had been in that state.
//   3. **Version skew.** Each SDK stamps its own version into its `User-Agent` and exposes it as
//      a constant, and each has a package manifest that also carries one. Those are separate
//      files in separate languages, so nothing but a check keeps them equal — and the symptom of
//      them diverging is a deployment's logs attributing calls to a release that was never cut.
//
// Mirrors `scripts/check-openapi.mjs` / `check-runner-image-tag.mjs`.
//
// Usage:  node scripts/check-sdks.mjs

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSdkFiles, findStaleGeneratedFiles } from './generate-sdks.mjs'
// The manifest/constant table is shared with `scripts/sync-sdk-versions.mjs`, which WRITES the
// invariant this file VERIFIES. A second copy here would be a second thing to keep in step.
import { readDeclaredVersion, VERSION_SOURCES } from './sdk/versions.mjs'
import { GROUPS } from './sdk/surface.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readVersion(source) {
  return readDeclaredVersion(await readFile(resolve(repoRoot, source.path), 'utf8'), source)
}

async function checkVersions() {
  const problems = []
  for (const { sdk, manifest, constant } of VERSION_SOURCES) {
    const [declared, stamped] = await Promise.all([readVersion(manifest), readVersion(constant)])
    if (declared !== stamped) {
      problems.push(
        `${sdk}: ${constant.path} stamps ${stamped} but ${manifest.path} declares ${declared} ` +
          '— run `node scripts/sync-sdk-versions.mjs`',
      )
    }
  }
  return problems
}

/**
 * Every resource group must be REACHABLE from Go's hand-written `client.go`, which is the one
 * accessor list no emitter writes. Matched on the constructor line rather than the field
 * declaration, because a declared-but-unassigned field is a nil pointer: reachable to the
 * compiler and a panic to the caller.
 */
async function checkGoReachability() {
  const rel = 'sdk/go/client.go'
  const source = await readFile(resolve(repoRoot, rel), 'utf8')
  return GROUPS.filter((group) => {
    const service = `${group.charAt(0).toUpperCase()}${group.slice(1)}Service`
    return !source.includes(`&${service}{client: client}`)
  }).map(
    (group) =>
      `${rel}: resource group '${group}' generates a service the client never constructs, so ` +
      'its endpoints are uncallable from Go. Add the field and its assignment.',
  )
}

async function checkGenerated() {
  const files = await buildSdkFiles()
  const drifted = []
  for (const [rel, expected] of files) {
    let actual = null
    try {
      actual = await readFile(resolve(repoRoot, rel), 'utf8')
    } catch {
      actual = null
    }
    if (actual !== expected) drifted.push(rel)
  }
  // A file the emitters no longer produce but that is still committed: a type the spec dropped.
  // It compiles and it ships, so it has to be reported rather than merely being absent from the
  // diff above (which only looks at what the generator DOES emit).
  return { drifted, stale: await findStaleGeneratedFiles(files) }
}

async function main() {
  const [{ drifted, stale }, versionProblems, reachability] = await Promise.all([
    checkGenerated(),
    checkVersions(),
    checkGoReachability(),
  ])

  for (const rel of stale) {
    console.error(
      `::error file=${rel}::${rel} is a GENERATED file the generator no longer produces. ` +
        'Run `pnpm gen:sdk` (which removes it) and commit the result.',
    )
  }
  for (const rel of drifted) {
    console.error(
      `::error file=${rel}::${rel} is out of date with docs/openapi.json. ` +
        'Run `pnpm gen:sdk` and commit the result.',
    )
  }
  for (const problem of versionProblems) {
    console.error(`::error::check-sdks: version skew — ${problem}`)
  }
  for (const problem of reachability) {
    console.error(`::error::check-sdks: unreachable resource: ${problem}`)
  }

  if (
    drifted.length > 0 ||
    stale.length > 0 ||
    versionProblems.length > 0 ||
    reachability.length > 0
  ) {
    console.error(
      `\n${drifted.length} generated file(s) drifted, ${stale.length} stale, ` +
        `${versionProblems.length} version mismatch(es), ` +
        `${reachability.length} unreachable resource group(s).`,
    )
    process.exit(1)
  }
  console.log(
    'The four SDK clients and the MCP facade are up to date with docs/openapi.json, and their ' +
      'versions agree.',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
