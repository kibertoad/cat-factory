#!/usr/bin/env node
// Requires every NESTED `AGENTS.md` to have a sibling `CLAUDE.md` whose first line is `@AGENTS.md`.
//
// Claude Code does not load a nested `AGENTS.md` as instructions when the repo has a root
// `CLAUDE.md` (the default `claude-md-or-agents-md` setting reads `AGENTS.md` only where no
// `CLAUDE.md` exists in the directory or above it, and the read-both setting is honoured in user
// or managed settings only, never project or local). So the per-package guidance (#2257) is
// invisible to Claude Code unless something loads it. That covers contributors and the platform's
// own coder agents, which also run Claude Code inside consumer repos of the same shape. The fix the docs recommend is a sibling `CLAUDE.md` that imports the
// AGENTS.md with a single `@AGENTS.md` line: Claude reads the import, other tools keep reading
// `AGENTS.md`, and one file stays the source. An import beats a committed symlink because a symlink
// checks out as plain text on Windows without `core.symlinks`, and this repo has Windows
// contributors.
//
// This guard keeps the pairing from drifting: a new package `AGENTS.md` added without its sibling
// is silently invisible to Claude Code again, and nothing else would notice. The ROOT `AGENTS.md` is
// excluded: `CLAUDE.md` is canonical there and already points the other way, so a `@AGENTS.md`
// import beside it would be a cycle.
//
// It is a script rather than a lint rule for the same reason as its neighbours (oxlint ships no
// `no-restricted-syntax`): pure node, no install, runs in the always-on `repo-guards` CI job. What
// counts as a valid sibling lives in `describeSiblingProblem`, with fixtures in
// `agents-md-pairing.test.mjs` (`node --test 'scripts/*.test.mjs'`).
//
// Usage:  node scripts/check-agents-md-pairing.mjs
// Exit 0 = every nested AGENTS.md is paired; exit 1 = at least one is not.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The one line a sibling CLAUDE.md must open with, so Claude Code loads the AGENTS.md as memory. */
export const REQUIRED_IMPORT = '@AGENTS.md'

/**
 * The reason a sibling CLAUDE.md fails the pairing, or `null` when it is valid. `content` is the
 * file text, or `null` when the file is absent. Valid means the first non-empty line is exactly
 * `@AGENTS.md`; extra lines below are allowed so a package may add Claude-only notes after the
 * import.
 */
export function describeSiblingProblem(content) {
  if (content === null) {
    return `no sibling CLAUDE.md (add one whose first line is \`${REQUIRED_IMPORT}\`)`
  }
  const firstLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine !== REQUIRED_IMPORT) {
    return `sibling CLAUDE.md must open with \`${REQUIRED_IMPORT}\` (found ${
      firstLine === undefined ? 'an empty file' : `\`${firstLine}\``
    })`
  }
  return null
}

function readSibling(dirAbs) {
  try {
    return readFileSync(join(dirAbs, 'CLAUDE.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Every tracked nested `AGENTS.md`, as a repo-relative path. Tracked files only, so an untracked
 * checkout inside the tree (a `.claude/worktrees/*` worktree, a scratch clone) never reads as an
 * unpaired package.
 */
function trackedNestedAgentsFiles() {
  return execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/AGENTS.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path.length > 0 && path !== 'AGENTS.md')
}

function main() {
  const failures = []
  for (const path of trackedNestedAgentsFiles()) {
    const problem = describeSiblingProblem(readSibling(join(repoRoot, dirname(path))))
    if (problem) failures.push(`${path}: ${problem}`)
  }

  if (failures.length > 0) {
    console.error('Nested AGENTS.md files Claude Code will not load as instructions:\n')
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      `\nAdd a sibling CLAUDE.md next to each, containing a single \`${REQUIRED_IMPORT}\` line, so`,
    )
    console.error('Claude Code loads the guidance while other tools keep reading AGENTS.md.')
    console.error('Background: the header of scripts/check-agents-md-pairing.mjs, and #2257.')
    process.exit(1)
  }

  console.log('Every nested AGENTS.md has its CLAUDE.md sibling.')
}

// Only when run as a script: the fixtures import `describeSiblingProblem`, and an import must not
// scan the tree or exit the test process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
