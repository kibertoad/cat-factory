// Fixtures for the runner-image path guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard's whole output is a set difference, so an extractor that stopped matching would yield
// an EMPTY expected set and report green on any drift — the failure mode this file exists to pin.
// Both extractors therefore throw on a missing anchor, and both directions of the diff are checked.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { diffGlobs, expectedGlobs, filterGlobs, triggerPaths } from './runner-image-paths.mjs'

const PUBLISH = `name: Docker publish
on:
  push:
    branches: [main]
jobs:
  changes:
    steps:
      - id: filter
        uses: dorny/paths-filter@abc
        with:
          filters: |
            executor:
              - 'backend/internal/executor-harness/src/**'
              - 'backend/internal/executor-harness/Dockerfile'
            # A comment between filters, plus a blank line.

            executorUi:
              - 'backend/internal/executor-harness/src/**'
              - 'backend/internal/executor-harness/Dockerfile'
              - 'backend/internal/executor-harness/Dockerfile.ui'
            deploy:
              - 'backend/internal/deploy-harness/Dockerfile'
  publish:
    steps:
      - run: echo not a filter
`

const SMOKETEST = `name: UI image smoketest
on:
  pull_request:
    paths:
      - 'backend/internal/executor-harness/src/**'
      - 'backend/internal/executor-harness/Dockerfile.ui'
  workflow_dispatch:

jobs:
  smoketest:
    steps:
      - run: echo hi
`

test('filterGlobs reads each filter, ignoring comments and later job blocks', () => {
  const filters = filterGlobs(PUBLISH)
  assert.deepEqual(Object.keys(filters), ['executor', 'executorUi', 'deploy'])
  assert.deepEqual(filters.executorUi, [
    'backend/internal/executor-harness/src/**',
    'backend/internal/executor-harness/Dockerfile',
    'backend/internal/executor-harness/Dockerfile.ui',
  ])
  assert.deepEqual(filters.deploy, ['backend/internal/deploy-harness/Dockerfile'])
})

test('filterGlobs throws when the anchor moved, rather than reporting no filters', () => {
  assert.throws(() => filterGlobs('name: x\njobs:\n  a:\n    steps: []\n'), /filters/)
})

test('triggerPaths reads the pull_request paths and stops at the next key', () => {
  assert.deepEqual(triggerPaths(SMOKETEST), [
    'backend/internal/executor-harness/src/**',
    'backend/internal/executor-harness/Dockerfile.ui',
  ])
})

test('triggerPaths throws for a workflow with no path gate', () => {
  assert.throws(() => triggerPaths('on:\n  pull_request:\njobs: {}\n'), /paths/)
})

test('expectedGlobs turns source prefixes into recursive globs and keeps files verbatim', () => {
  assert.deepEqual(
    expectedGlobs({
      sourcePrefixes: ['backend/internal/executor-harness/src/'],
      sourceFiles: ['backend/internal/executor-harness/Dockerfile.ui'],
    }),
    ['backend/internal/executor-harness/src/**', 'backend/internal/executor-harness/Dockerfile.ui'],
  )
})

test('diffGlobs reports both directions, and allows declared extras', () => {
  const diff = diffGlobs(['a', 'extra'], ['a', 'b'], ['extra'])
  assert.deepEqual(diff.missing, ['b'])
  assert.deepEqual(diff.unexpected, [])
})

test('diffGlobs flags a glob that is neither a source nor a declared extra', () => {
  const diff = diffGlobs(['a', 'stray'], ['a'], [])
  assert.deepEqual(diff.missing, [])
  assert.deepEqual(diff.unexpected, ['stray'])
})
