// Fixtures for the test-lane-parity guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the drift it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. This one is unusually exposed to that: it
// compares two lists, and the failure mode of a broken extractor is an EMPTY list, which compares
// equal to anything else empty. Every extractor therefore throws on a missing anchor, and the tests
// below pin that behaviour rather than only the happy path.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  diffExclusions,
  excludedPackages,
  packageScript,
  workflowJob,
} from './test-lane-parity.mjs'

test('reads only NEGATIVE filters, in either quoting style', () => {
  const names = excludedPackages(
    'turbo run test:run --filter=\'!@scope/a\' --filter="!@scope/b" --filter=!@scope/c',
  )
  assert.deepEqual(names, ['@scope/a', '@scope/b', '@scope/c'])
})

test('ignores positive filters, which select scope rather than infra', () => {
  // `...[origin/main]` and a bare package name narrow WHAT runs; only a `!` says "this one needs
  // infra we do not have", which is the fact the two lanes have to agree about.
  const names = excludedPackages(
    "turbo run test:run --filter='...[origin/main]' --filter=@scope/keep --filter='!@scope/drop'",
  )
  assert.deepEqual(names, ['@scope/drop'])
})

test('deduplicates, so a repeated exclusion is not read as two', () => {
  assert.deepEqual(excludedPackages("--filter='!@scope/a' --filter='!@scope/a'"), ['@scope/a'])
})

const WORKFLOW = `name: CI

jobs:
  test-worker:
    name: Test worker
    steps:
      - run: pnpm --filter @cat-factory/worker exec vitest run

  test-units:
    name: Test units (no DB)
    steps:
      - name: Run unit packages
        run: >-
          pnpm
          --filter='!@cat-factory/worker'
          --filter='!@cat-factory/node-server'
          -r run test:run

      - name: CLI supervise integration test
        run: pnpm --filter @cat-factory/cli run test:supervise

  test-db:
    name: Test DB
    steps:
      - run: pnpm --filter='!@cat-factory/app' -r run test:run
`

test('scopes to the named job, not the whole workflow', () => {
  // `test-db` excludes a package too. Reading the file as one blob would fold its exclusion into
  // the lane's and the guard would demand `test:quick` exclude the frontend.
  const names = excludedPackages(workflowJob(WORKFLOW, 'test-units'))
  assert.deepEqual(names, ['@cat-factory/node-server', '@cat-factory/worker'])
})

test('spans every step in the job, including a multi-line folded `run:`', () => {
  const job = workflowJob(WORKFLOW, 'test-units')
  assert.ok(job.includes('CLI supervise'))
  assert.ok(job.includes("--filter='!@cat-factory/node-server'"))
})

test('throws when the job id is gone, rather than reading no exclusions', () => {
  // The empty-list trap: two empty lists agree. A renamed job has to fail loudly here.
  assert.throws(() => workflowJob(WORKFLOW, 'test-units-renamed'), /could not find/)
})

test('reads a named script, and throws when it has been renamed', () => {
  const pkg = { scripts: { 'test:quick': "turbo run test:run --filter='!@scope/a'" } }
  assert.equal(packageScript(pkg, 'test:quick'), "turbo run test:run --filter='!@scope/a'")
  assert.throws(() => packageScript(pkg, 'test:fast'), /no `test:fast` script/)
  assert.throws(() => packageScript({}, 'test:quick'), /no `test:quick` script/)
})

test('reports drift in BOTH directions, because neither is the safe one', () => {
  // Excluded locally but not in CI = false confidence (the script covers less than it claims).
  // Excluded in CI but not locally = the script demands the infra the lane exists to avoid.
  const diff = diffExclusions(['@scope/a', '@scope/b'], ['@scope/b', '@scope/c'])
  assert.deepEqual(diff.onlyInScript, ['@scope/a'])
  assert.deepEqual(diff.onlyInLane, ['@scope/c'])
})

test('agreeing lists produce no difference in either direction', () => {
  const diff = diffExclusions(['@scope/a', '@scope/b'], ['@scope/a', '@scope/b'])
  assert.deepEqual(diff.onlyInScript, [])
  assert.deepEqual(diff.onlyInLane, [])
})
