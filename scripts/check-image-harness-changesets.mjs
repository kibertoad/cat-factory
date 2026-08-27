#!/usr/bin/env node
// Guards against versioning a container-image harness that did not change: a changeset naming
// `@cat-factory/executor-harness` or `@cat-factory/deploy-harness` must be accompanied by a change
// to that image's sources, because those versions ARE the published image tags. The rule and the
// incident behind it live in `image-harness-changesets.mjs` (the testable detection half); this is
// the CLI ci.yml's repo-guards job runs.
//
// It is the CONVERSE of check-runner-image-tag.mjs, which asks whether a source change bumped the
// tag. This asks whether a tag bump had a source change. Both directions are silent when violated,
// and each needs its own check.
//
// Usage:
//   node scripts/check-image-harness-changesets.mjs --since <ref>
//
// Without `--since` there is no base to diff against, so the check is skipped rather than guessed
// at: that is the correct behaviour on a push or a manual dispatch, matching the tag guard.
// Exit 0 = clean; exit 1 = a changeset would republish an unchanged image.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  findUnjustifiedBumps,
  parseChangesetPackages,
  selectAuthoredBumps,
} from './image-harness-changesets.mjs'
import { IMAGES, readRepoFile, repoRoot } from './runner-images.mjs'

const sinceIdx = process.argv.indexOf('--since')
const since = sinceIdx === -1 ? null : (process.argv[sinceIdx + 1] ?? '').trim()

if (!since) {
  console.log('check-image-harness-changesets: no --since ref, skipping (consistency-only mode).')
  process.exit(0)
}

// One entry per DISTINCT harness package. The executor and executor-ui images share
// `@cat-factory/executor-harness`, so collapsing them here is what keeps a violation from being
// reported twice; the merged source list is the union, which is also the correct question to ask
// (a change to either image's sources justifies the shared version moving).
const byHarness = new Map()
for (const descriptor of IMAGES) {
  const existing = byHarness.get(descriptor.harnessPkg)
  if (existing) {
    existing.sourceFiles = new Set([...existing.sourceFiles, ...descriptor.sourceFiles])
    existing.sourcePrefixes = [
      ...new Set([...existing.sourcePrefixes, ...descriptor.sourcePrefixes]),
    ]
    continue
  }
  byHarness.set(descriptor.harnessPkg, {
    label: descriptor.label,
    image: descriptor.image,
    harnessName: JSON.parse(readRepoFile(descriptor.harnessPkg)).name,
    sourceFiles: new Set(descriptor.sourceFiles),
    sourcePrefixes: [...descriptor.sourcePrefixes],
  })
}

const images = [...byHarness.values()].map((entry) => ({
  label: entry.label,
  image: entry.image,
  harnessName: entry.harnessName,
  isSource: (path) =>
    entry.sourceFiles.has(path) || entry.sourcePrefixes.some((prefix) => path.startsWith(prefix)),
}))

const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
const lines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

// The one base both halves are judged against: the point this branch was cut from, not the base
// ref's tip. `git diff <since>...HEAD` already meant this, and reading the pending changesets off
// the tip instead would call the branch the author of every changeset a release consumed on the
// base after the fork, which is the same bystander accusation from the other side.
const base = git(['merge-base', since, 'HEAD']).trim()

// Three reads, unioned, because the guard runs in two places that see different trees. CI runs it
// on `pull/N/merge`, where the working tree is clean and the committed diff IS the branch's work.
// A contributor runs it before committing, as the repo asks, and there the committed diff is empty
// or stale: judging on it alone reports a clean tree while the change sitting in front of them is
// the violation.
const changedPaths = [
  ...new Set([
    ...lines(git(['diff', '--name-only', base, 'HEAD'])),
    ...lines(git(['diff', '--name-only', 'HEAD'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
  ]),
]

// What the branch inherited rather than wrote. A changeset stays in `.changeset/` from the PR that
// writes it until a release consumes it, so every package named here was already going to be
// released without this branch; see `selectAuthoredBumps` for why authorship is read off these
// package names and not off the diff.
const inheritedPackages = new Set()
for (const path of lines(git(['ls-tree', '-r', '--name-only', base, '--', '.changeset']))) {
  if (!path.endsWith('.md') || path.endsWith('/README.md')) continue
  for (const name of parseChangesetPackages(git(['show', `${base}:${path}`]))) {
    inheritedPackages.add(name)
  }
}

const changesetDir = resolve(repoRoot, '.changeset')
const pending = readdirSync(changesetDir)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .map((name) => ({
    path: `.changeset/${name}`,
    packages: parseChangesetPackages(readFileSync(join(changesetDir, name), 'utf8')),
  }))
const changesets = selectAuthoredBumps({
  changesets: pending,
  inheritedPackages: [...inheritedPackages],
})

const violations = findUnjustifiedBumps({ changesets, images, changedPaths })

for (const { message } of violations) {
  console.error(`::error::${message}`)
}

if (violations.length > 0) {
  process.exit(1)
}

console.log(
  `check-image-harness-changesets: ${changesets.length} changeset(s) with a bump authored on ` +
    `this branch (${pending.length} pending in .changeset/) checked against ${images.length} ` +
    `image harness package(s); none versions an unchanged image.`,
)
