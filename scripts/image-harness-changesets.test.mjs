// Fixtures for the image-harness changeset guard. Run by `node --test 'scripts/*.test.mjs'`.
//
// The case this guard exists for actually shipped (#2076's changeset versioned
// @cat-factory/deploy-harness with nothing in that image changed, and #2077 released it), so the
// first fixture below is that incident replayed. The rest are the ways a guard like this goes
// wrong: refusing a legitimate bump, passing one because the front matter was parsed loosely, or
// reporting on a bump the branch under test inherited rather than wrote.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  findUnjustifiedBumps,
  parseChangesetPackages,
  selectAuthoredBumps,
} from './image-harness-changesets.mjs'

const DEPLOY = {
  label: 'deploy',
  image: 'cat-factory-deploy',
  harnessName: '@cat-factory/deploy-harness',
  isSource: (p) => p.startsWith('backend/internal/deploy-harness/'),
}
const EXECUTOR = {
  label: 'executor',
  image: 'cat-factory-executor',
  harnessName: '@cat-factory/executor-harness',
  isSource: (p) => p.startsWith('backend/internal/executor-harness/'),
}
const IMAGES = [DEPLOY, EXECUTOR]

test('replays #2076: versions the deploy harness with no deploy-image change', () => {
  const violations = findUnjustifiedBumps({
    changesets: [
      {
        path: '.changeset/refresh.md',
        packages: ['@cat-factory/kernel', '@cat-factory/deploy-harness', '@cat-factory/worker'],
      },
    ],
    images: IMAGES,
    changedPaths: ['pnpm-workspace.yaml', 'backend/packages/kernel/src/domain/gate-logic.ts'],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].harnessName, '@cat-factory/deploy-harness')
  assert.match(violations[0].message, /byte-identical/)
})

test('allows the bump when that image actually changed', () => {
  assert.deepEqual(
    findUnjustifiedBumps({
      changesets: [{ path: '.changeset/fix.md', packages: ['@cat-factory/deploy-harness'] }],
      images: IMAGES,
      changedPaths: ['backend/internal/deploy-harness/src/server.ts'],
    }),
    [],
  )
})

test('judges each image independently rather than lumping the harnesses together', () => {
  // A branch that legitimately changes the executor image must not thereby license a
  // deploy-harness bump. Lumping them is the obvious implementation slip here.
  const violations = findUnjustifiedBumps({
    changesets: [
      {
        path: '.changeset/both.md',
        packages: ['@cat-factory/executor-harness', '@cat-factory/deploy-harness'],
      },
    ],
    images: IMAGES,
    changedPaths: ['backend/internal/executor-harness/Dockerfile'],
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].harnessName, '@cat-factory/deploy-harness')
})

test("a changeset naming no harness package is not this guard's business", () => {
  assert.deepEqual(
    findUnjustifiedBumps({
      changesets: [
        { path: '.changeset/a.md', packages: ['@cat-factory/kernel', '@cat-factory/worker'] },
      ],
      images: IMAGES,
      changedPaths: ['backend/packages/kernel/src/domain/seed.ts'],
    }),
    [],
  )
})

test('reports every offending changeset, not just the first', () => {
  const violations = findUnjustifiedBumps({
    changesets: [
      { path: '.changeset/a.md', packages: ['@cat-factory/deploy-harness'] },
      { path: '.changeset/b.md', packages: ['@cat-factory/deploy-harness'] },
    ],
    images: [DEPLOY],
    changedPaths: ['README.md'],
  })
  assert.deepEqual(
    violations.map((v) => v.changeset),
    ['.changeset/a.md', '.changeset/b.md'],
  )
})

test('parses quoted and unquoted front-matter entries alike', () => {
  // Both forms appear in this repo's history. A parser that took only the quoted form would pass
  // the guard on an unquoted entry, which is the failure that reads as "the guard is fine".
  const packages = parseChangesetPackages(
    `---\n'@cat-factory/deploy-harness': patch\n"@cat-factory/worker": minor\n@cat-factory/kernel: patch\n---\n\nBody text.\n`,
  )
  assert.deepEqual(packages, [
    '@cat-factory/deploy-harness',
    '@cat-factory/worker',
    '@cat-factory/kernel',
  ])
})

test('reads no packages from a file with no front matter, and does not throw', () => {
  assert.deepEqual(parseChangesetPackages('# Changesets\n\nJust prose.\n'), [])
  assert.deepEqual(parseChangesetPackages(''), [])
})

test('does not mistake body prose for a front-matter entry', () => {
  // The body regularly contains `name: value` shaped lines (bullet lists of version bumps).
  // Reading past the closing `---` would invent package names from them.
  const packages = parseChangesetPackages(
    `---\n'@cat-factory/kernel': patch\n---\n\n- '@cat-factory/deploy-harness': untouched here\nhono: 4.13.3\n`,
  )
  assert.deepEqual(packages, ['@cat-factory/kernel'])
})

test("replays #2113's fallout: a bump pending on the base is not this branch's", () => {
  // #2113 landed a justified executor-harness changeset with its Dockerfile change. Until the
  // release consumed it, it sat in `.changeset/` on main, so every branch cut afterwards carried
  // it on disk while touching nothing in the image. Judging the directory instead of what the
  // branch added failed all of them, #2111 among them, on a bump none of them wrote.
  assert.deepEqual(
    selectAuthoredBumps({
      changesets: [
        {
          path: '.changeset/agent-cli-pins-refresh.md',
          packages: ['@cat-factory/executor-harness'],
        },
        { path: '.changeset/unrouted-environment-url.md', packages: ['@cat-factory/kernel'] },
      ],
      inheritedPackages: ['@cat-factory/executor-harness'],
    }),
    [{ path: '.changeset/unrouted-environment-url.md', packages: ['@cat-factory/kernel'] }],
  )
})

test('a branch level with its base authors nothing, so it can never be unjustified', () => {
  // The shape of the bug at its clearest: such a branch changed no image and wrote no changeset,
  // and a guard that accuses it is reporting on the base, not on the branch.
  assert.deepEqual(
    selectAuthoredBumps({
      changesets: [
        {
          path: '.changeset/agent-cli-pins-refresh.md',
          packages: ['@cat-factory/executor-harness'],
        },
      ],
      inheritedPackages: ['@cat-factory/executor-harness'],
    }),
    [],
  )
})

test('adding a harness package to an inherited changeset authors that bump', () => {
  // Naming a harness package a changeset did not name before is the same statement as writing a
  // fresh changeset for it, whoever created the file. Only the added name is this branch's: the
  // one it inherited is still the authoring PR's to justify.
  assert.deepEqual(
    selectAuthoredBumps({
      changesets: [
        {
          path: '.changeset/refresh.md',
          packages: ['@cat-factory/kernel', '@cat-factory/deploy-harness'],
        },
      ],
      inheritedPackages: ['@cat-factory/kernel'],
    }),
    [{ path: '.changeset/refresh.md', packages: ['@cat-factory/deploy-harness'] }],
  )
})

test('rewording or renaming an inherited changeset does not re-author its bump', () => {
  // The case a path rule gets wrong. Fixing a typo in a pending changeset, or `git mv`-ing it,
  // puts its path in the branch's diff while naming nothing the base was not already going to
  // release, so keying on the path would tell this branch to remove an entry another PR wrote and
  // justified. Authorship of a bump lives in the front matter, which did not move.
  assert.deepEqual(
    selectAuthoredBumps({
      changesets: [
        { path: '.changeset/renamed-and-reworded.md', packages: ['@cat-factory/executor-harness'] },
      ],
      inheritedPackages: ['@cat-factory/executor-harness'],
    }),
    [],
  )
})

test('a fresh changeset on a branch that inherited nothing is wholly authored', () => {
  // The local pre-commit case, and why enumeration reads the working tree rather than the diff:
  // an uncommitted changeset is on disk and named by nothing git has recorded yet, so a rule that
  // asked the committed diff would pass the guard on the very file being checked.
  assert.deepEqual(
    selectAuthoredBumps({
      changesets: [{ path: '.changeset/new.md', packages: ['@cat-factory/deploy-harness'] }],
      inheritedPackages: [],
    }),
    [{ path: '.changeset/new.md', packages: ['@cat-factory/deploy-harness'] }],
  )
})
