#!/usr/bin/env node
// Bans a tracked `CLAUDE.md` / `CLAUDE.local.md` / `.claude/CLAUDE.md` anywhere in the repo.
//
// `AGENTS.md` is this repo's one agent instruction file, at the root and in every package. Claude
// Code reads those directly, but only while no `CLAUDE.md` exists in the working directory or
// above it: the default `claude-md-or-agents-md` setting reads `CLAUDE.md` INSTEAD of `AGENTS.md`
// whenever one is present, and it is an either/or, not a merge. So a single committed `CLAUDE.md`
// anywhere on the path silently switches off every `AGENTS.md` at and below it, and the loss is
// invisible: the session starts, reports no error, and runs without the per-package guidance
// (#2257). The read-both setting (`claude-md-and-agents-md`) is honoured in user or managed
// settings only, never project or local, so the repo cannot re-enable the files for a contributor.
//
// `CLAUDE.local.md` counts for that check too, so it is banned here as well. It is gitignored in
// practice, but a contributor who adds one at the root turns off `AGENTS.md` for themselves alone,
// which is the hardest version of this to diagnose. This guard sees it only when tracked.
//
// It is a script rather than a lint rule for the same reason as its neighbours (oxlint ships no
// `no-restricted-syntax`): pure node, no install, runs in the always-on `repo-guards` CI job. What
// counts as a banned path lives in `isBannedInstructionFile`, with fixtures in
// `no-claude-md.test.mjs` (`node --test 'scripts/*.test.mjs'`).
//
// Usage:  node scripts/check-no-claude-md.mjs
// Exit 0 = no tracked CLAUDE.md; exit 1 = at least one.

import { execFileSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The file names that make Claude Code skip a directory's `AGENTS.md`. */
export const BANNED_NAMES = ['CLAUDE.md', 'CLAUDE.local.md']

/**
 * Whether a repo-relative path is an instruction file that would switch `AGENTS.md` off. Matches
 * the three names Claude Code counts, at any depth, including under a `.claude/` directory. A
 * path merely CONTAINING the word (`backend/docs/figma-claude-design-context.md`, a skill's
 * `SKILL.md`, a source file named `claude-cli.ts`) is not one of them.
 */
export function isBannedInstructionFile(path) {
  return BANNED_NAMES.includes(basename(path))
}

/**
 * Every tracked path the guard judges. Tracked files only, so an untracked checkout inside the
 * tree (a `.claude/worktrees/*` worktree, a scratch clone) and a developer's own gitignored
 * `CLAUDE.local.md` never fail the run.
 */
function trackedPaths() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path.length > 0)
}

function main() {
  const offenders = trackedPaths().filter(isBannedInstructionFile)

  if (offenders.length > 0) {
    console.error('Tracked instruction files that switch off every AGENTS.md at and below them:\n')
    for (const path of offenders) console.error(`  - ${path}`)
    console.error('\nMove the content into the sibling AGENTS.md and delete the file. This repo')
    console.error('keeps ONE agent instruction file per directory, and it is AGENTS.md.')
    console.error('Background: the header of scripts/check-no-claude-md.mjs, and #2257.')
    process.exit(1)
  }

  console.log('No tracked CLAUDE.md: every AGENTS.md loads.')
}

// Only when run as a script: the fixtures import `isBannedInstructionFile`, and an import must not
// scan the tree or exit the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
