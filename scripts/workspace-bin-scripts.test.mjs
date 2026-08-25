// Fixtures for the workspace-bin-in-a-script guard. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard exists because the bug it watches is invisible to everyone positioned to catch it:
// CI restores a node_modules cache populated after a build, so the shim is there and the script
// runs; only a fresh clone hits `<name>: not found`. The fixtures below are the two halves that
// have to stay right, deciding WHICH bins cannot link and deciding which tokens are spawns.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  collectUnlinkableBins,
  commandTokens,
  findWorkspaceBinCalls,
} from './workspace-bin-scripts.mjs'

const CLI = {
  name: '@cat-factory/cli',
  dir: 'backend/packages/cli',
  bin: { 'cat-factory': './dist/bin.js' },
}
const SMOKE = {
  name: '@cat-factory/smoketest-harness',
  dir: 'backend/internal/smoketest-harness',
  bin: { 'cat-smoke': './src/cli.ts' },
}
const trackedSources = (repoPath) => repoPath.includes('/src/')

test('a bin at a build output cannot link, so it is collected', () => {
  const bins = collectUnlinkableBins([CLI], trackedSources)
  assert.deepEqual([...bins], [['cat-factory', '@cat-factory/cli']])
})

test('a bin at a tracked source file links normally and is not collected', () => {
  assert.equal(collectUnlinkableBins([SMOKE], trackedSources).size, 0)
})

test('the string form of `bin` takes the package name with the scope stripped', () => {
  const bins = collectUnlinkableBins(
    [{ name: '@cat-factory/cli', dir: 'backend/packages/cli', bin: './dist/bin.js' }],
    trackedSources,
  )
  // npm's rule for the string form, and the reason the two shapes cannot share a branch: the
  // name comes from the PACKAGE, so `@cat-factory/cli` installs as `cli`, not `cat-factory`.
  assert.deepEqual([...bins.keys()], ['cli'])
})

test('tracked-ness is asked of the path relative to the REPO, not the package', () => {
  const seen = []
  collectUnlinkableBins([CLI], (repoPath) => {
    seen.push(repoPath)
    return true
  })
  assert.deepEqual(seen, ['backend/packages/cli/dist/bin.js'])
})

test('a package with no bin contributes nothing', () => {
  assert.equal(collectUnlinkableBins([{ name: 'x', dir: 'x' }], trackedSources).size, 0)
})

test('the first token of a script is a command', () => {
  assert.deepEqual(commandTokens('cat-factory supervise --compose-service postgres'), [
    'cat-factory',
  ])
})

test('a path invocation names `node`, which is what the fix looks like', () => {
  assert.deepEqual(commandTokens('node ../../backend/packages/cli/dist/bin.js supervise'), ['node'])
})

test('each side of a shell separator is its own command', () => {
  assert.deepEqual(commandTokens('pnpm run build && cat-factory env'), ['pnpm', 'cat-factory'])
  assert.deepEqual(commandTokens('a | b ; c || d & e'), ['a', 'b', 'c', 'd', 'e'])
})

test('the wrapper idiom puts a spawn right after `--`', () => {
  assert.deepEqual(commandTokens('supervisor --flag -- pnpm dev:raw'), ['supervisor', 'pnpm'])
})

test('an env assignment prefix is not the command', () => {
  assert.deepEqual(commandTokens('NODE_ENV=test CI=1 cat-factory env'), ['cat-factory'])
})

test('`pnpm exec` consumes both its tokens, so the name after it is the spawn', () => {
  assert.deepEqual(commandTokens('pnpm exec cat-factory env'), ['cat-factory'])
})

test('a bin name in argument position is not a spawn', () => {
  assert.deepEqual(commandTokens('vitest run --reporter cat-factory'), ['vitest'])
})

test('`npx` resolves from the registry, where dist/ ships, so its argument is not flagged', () => {
  assert.deepEqual(commandTokens('npx @cat-factory/cli env'), ['npx'])
})

test('reports the offending script with the package that owns the bin', () => {
  const bins = collectUnlinkableBins([CLI], trackedSources)
  const findings = findWorkspaceBinCalls(
    [
      {
        path: 'deploy/local/package.json',
        scripts: { dev: 'cat-factory supervise -- pnpm dev:raw' },
      },
    ],
    bins,
  )
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0], {
    path: 'deploy/local/package.json',
    script: 'dev',
    command: 'cat-factory supervise -- pnpm dev:raw',
    bin: 'cat-factory',
    owner: '@cat-factory/cli',
  })
})

test('the by-path form of the same script is clean', () => {
  const bins = collectUnlinkableBins([CLI], trackedSources)
  const findings = findWorkspaceBinCalls(
    [
      {
        path: 'deploy/local/package.json',
        scripts: { dev: 'node ../../backend/packages/cli/dist/bin.js supervise -- pnpm dev:raw' },
      },
    ],
    bins,
  )
  assert.deepEqual(findings, [])
})

test('a package with no scripts is clean', () => {
  assert.deepEqual(findWorkspaceBinCalls([{ path: 'p/package.json' }], new Map([['x', 'y']])), [])
})
