#!/usr/bin/env node
// Moves the old half of every generated CHANGELOG.md into a sibling CHANGELOG-ARCHIVE.md,
// leaving the newest entries where a reader (and `create-github-releases`) looks for them.
//
// Why this exists: a release rewrites the CHANGELOG of every bumped package, and with 37 of them
// past 1.5 MiB apiece the version commit carried ~13 MiB of file bytes to add ~50 lines of prose.
// That is the payload that broke six release runs in two weeks while the commit was pushed
// through GitHub's `createCommitOnBranch` mutation, which uploads whole files rather than a diff
// (`.github/workflows/release.yml` now pushes with the git CLI, which is the durable half of the
// fix). It is also a plain reading cost: nobody scrolls 26,000 lines, and every clone pays for
// them.
//
// The split is safe against the tool that owns these files. `changeset version` PREPENDS a new
// entry by replacing the first newline in the file, so it only ever touches the top: the kept
// entries stay newest-first, the pointer footer stays at the bottom, and the archive is never
// opened again until this script runs. Re-running is idempotent in the sense that matters: the
// footer is recognised and stripped before parsing, so it is never mistaken for changelog prose,
// and newly aged-out entries are prepended INSIDE the existing archive rather than appended after
// its oldest release.
//
// Usage:  node scripts/archive-changelogs.mjs [--keep N]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** How many release entries stay in CHANGELOG.md. Roughly two months of this repo's cadence. */
export const DEFAULT_KEEP = 20

/** The sibling that holds everything older. Named so `isFrozenHistory` in `doc-links.mjs` skips it. */
export const ARCHIVE_BASENAME = 'CHANGELOG-ARCHIVE.md'

/**
 * Sentinel opening the pointer footer this script writes at the BOTTOM of a trimmed CHANGELOG.
 * Parsing strips everything from here down, so a re-run neither duplicates the footer nor files
 * it away as part of the oldest kept release.
 */
export const FOOTER_MARKER = '<!-- archived-releases -->'

/**
 * A changelog split into its title block and its release entries, newest first.
 *
 * Fenced blocks are tracked because a changeset body in this repo routinely quotes markdown, and
 * a `## ` line inside a fence is an illustration rather than a release boundary.
 */
export function parseChangelog(text) {
  const body = text.split(FOOTER_MARKER)[0].replace(/\s+$/, '')
  const lines = body.split('\n')
  const head = []
  const entries = []
  let fence = null
  let current = null
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      const ticks = fenceMatch[1]
      if (fence === null) fence = ticks[0].repeat(ticks.length)
      else if (ticks.startsWith(fence)) fence = null
    }
    if (fence === null && line.startsWith('## ')) {
      current = [line]
      entries.push(current)
      continue
    }
    if (current) current.push(line)
    else head.push(line)
  }
  return {
    head: head.join('\n').replace(/\s+$/, ''),
    entries: entries.map((entry) => entry.join('\n').replace(/\s+$/, '')),
  }
}

/** The archive's own title block, derived from the changelog it was cut out of. */
function archiveHead(head) {
  const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? 'Release archive'
  return [
    `# ${title}: archived releases`,
    '',
    `The older releases of this package, moved out of [\`CHANGELOG.md\`](./CHANGELOG.md) so a`,
    'release commit rewrites kilobytes instead of megabytes. Frozen history: nothing writes here',
    'except `scripts/archive-changelogs.mjs`.',
  ].join('\n')
}

/**
 * The two files a package should hold, or `null` when it has too little history to bother.
 *
 * Pure, so the fixtures need no tmpdir: the caller supplies the current text of both files and
 * writes back whatever comes out.
 */
export function archiveOne({ changelog, archive, keep = DEFAULT_KEEP }) {
  const { head, entries } = parseChangelog(changelog)
  if (entries.length <= keep) return null
  const kept = entries.slice(0, keep)
  const moved = entries.slice(keep)
  const existing = archive ? parseChangelog(archive) : null
  return {
    movedCount: moved.length,
    changelog: `${head}\n\n${kept.join('\n\n')}\n\n${FOOTER_MARKER}\n\nOlder releases: [\`${ARCHIVE_BASENAME}\`](./${ARCHIVE_BASENAME}).\n`,
    archive: `${existing?.head || archiveHead(head)}\n\n${[...moved, ...(existing?.entries ?? [])].join('\n\n')}\n`,
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Build output and dependency trees hold changelogs that are not ours to rewrite. */
const SKIP_DIRS = new Set([
  '.git',
  '.nuxt',
  '.output',
  '.stryker-tmp',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
])

function* findChangelogs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* findChangelogs(join(dir, entry.name))
    } else if (entry.name === 'CHANGELOG.md') {
      yield join(dir, entry.name)
    }
  }
}

function readKeep(argv) {
  const flag = argv.indexOf('--keep')
  if (flag === -1) return DEFAULT_KEEP
  const keep = Number(argv[flag + 1])
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep needs a positive integer, got: ${argv[flag + 1]}`)
  }
  return keep
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function main(argv) {
  const keep = readKeep(argv)
  let touched = 0
  let before = 0
  let after = 0
  for (const path of findChangelogs(repoRoot)) {
    const changelog = readFileSync(path, 'utf8')
    const archivePath = join(dirname(path), ARCHIVE_BASENAME)
    const result = archiveOne({ changelog, archive: readIfPresent(archivePath), keep })
    before += statSync(path).size
    if (!result) {
      after += statSync(path).size
      continue
    }
    writeFileSync(path, result.changelog)
    writeFileSync(archivePath, result.archive)
    after += Buffer.byteLength(result.changelog)
    touched += 1
    console.log(
      `${relative(repoRoot, path)}: archived ${result.movedCount} release(s), ` +
        `${Math.round(Buffer.byteLength(result.changelog) / 1024)} KiB left`,
    )
  }
  console.log(
    touched === 0
      ? `Every CHANGELOG.md is already at or under ${keep} releases.`
      : `Archived ${touched} changelog(s): ${Math.round(before / 1024)} KiB of release-commit ` +
          `payload down to ${Math.round(after / 1024)} KiB.`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
