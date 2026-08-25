// Fixtures for the workspace-bin-in-a-script guard. Run by `node --test 'scripts/*.test.mjs'`.
//
// The guard exists because the bug it watches is invisible to everyone positioned to catch it:
// CI restores a node_modules cache populated after a build, so the shim is there and the script
// runs; only a fresh clone hits `<name>: not found`. The fixtures below are the three halves
// that have to stay right: deciding WHICH bins cannot link, deciding which tokens are spawns,
// and deciding whether the by-path spawn that replaces a bin name still addresses that bin.
//
// The tokenisation fixtures are mostly NEGATIVE space. Each spelling a spawn can take and the
// guard cannot see is a way for the exact bug it was written for to come back with CI green, so
// the launcher and operator variants below are pinned one by one rather than by one happy path.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  collectBinTargets,
  collectUnlinkableBins,
  commandSegments,
  commandTokens,
  findBinPathDrift,
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

test('a launcher option and its value do not hide the `exec` that follows them', () => {
  // The filtered form is this repo's dominant pnpm idiom, so a guard that only saw the bare
  // two-token spelling would let the original bug back in wearing the more common clothes.
  assert.deepEqual(commandTokens('pnpm --filter @cat-factory/cli exec cat-factory env'), [
    'cat-factory',
  ])
  assert.deepEqual(commandTokens('pnpm -r exec cat-factory env'), ['cat-factory'])
  assert.deepEqual(commandTokens('pnpm -C deploy/local exec cat-factory env'), ['cat-factory'])
})

test("`exec`'s own options are skipped to reach the spawn", () => {
  assert.deepEqual(commandTokens('pnpm exec --silent cat-factory env'), ['cat-factory'])
})

test('a nested launcher unwinds through the same branch', () => {
  assert.deepEqual(commandTokens('pnpm exec pnpm exec cat-factory env'), ['cat-factory'])
})

test('a subcommand that closes command position stops the scan for `exec`', () => {
  // What follows `run` is a SCRIPT name, and what follows `dlx` resolves from the registry
  // where the tarball carries dist/. Neither reaches a bin shim, so the launcher is the spawn.
  assert.deepEqual(commandTokens('pnpm run build'), ['pnpm'])
  assert.deepEqual(commandTokens('pnpm dlx cat-factory env'), ['pnpm'])
  assert.deepEqual(commandTokens('pnpm --filter @cat-factory/cli run build'), ['pnpm'])
})

test('an operator needs no surrounding whitespace to end a command', () => {
  assert.deepEqual(commandTokens('pnpm run build&&cat-factory env'), ['pnpm', 'cat-factory'])
  assert.deepEqual(commandTokens('a|b;c||d&e'), ['a', 'b', 'c', 'd', 'e'])
})

test("a redirection's `>&` is not a background `&`", () => {
  // Splitting it would put the redirection's target in command position, where a bin name could
  // then be claimed as a spawn that never happens.
  assert.deepEqual(commandTokens('tsc -b 2>&1'), ['tsc'])
})

test('a newline ends a command like any other separator', () => {
  assert.deepEqual(commandTokens('pnpm run build\ncat-factory env'), ['pnpm', 'cat-factory'])
})

test('a segment carries the arguments up to its separator', () => {
  assert.deepEqual(commandSegments('node --watch src/main.ts && echo done'), [
    { command: 'node', args: ['--watch', 'src/main.ts'] },
    { command: 'echo', args: ['done'] },
  ])
})

test('bin targets are collected per package directory as repo-relative paths', () => {
  assert.deepEqual(
    [...collectBinTargets([CLI, SMOKE])],
    [
      [
        'backend/packages/cli',
        { name: CLI.name, targets: new Set(['backend/packages/cli/dist/bin.js']) },
      ],
      [
        'backend/internal/smoketest-harness',
        {
          name: SMOKE.name,
          targets: new Set(['backend/internal/smoketest-harness/src/cli.ts']),
        },
      ],
    ],
  )
})

const DEPLOY = (dev) => [
  { path: 'deploy/local/package.json', dir: 'deploy/local', scripts: { dev } },
]

test('the by-path spawn is clean while it addresses the declared bin', () => {
  const drift = findBinPathDrift(
    DEPLOY('node ../../backend/packages/cli/dist/bin.js supervise -- pnpm dev:raw'),
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(drift, [])
})

test('moving the build output the path was copied from is a finding', () => {
  // The failure this prevents: the CLI changes outDir, its own manifest and build stay
  // consistent, the consumer's predev still succeeds, and `pnpm dev` dies on `Cannot find
  // module` with nothing in between having gone red.
  const drift = findBinPathDrift(
    DEPLOY('node ../../backend/packages/cli/dist/bin.js supervise'),
    collectBinTargets([{ ...CLI, bin: { 'cat-factory': './build/bin.js' } }]),
    trackedSources,
  )
  assert.deepEqual(drift, [
    {
      path: 'deploy/local/package.json',
      script: 'dev',
      command: 'node ../../backend/packages/cli/dist/bin.js supervise',
      spawned: 'backend/packages/cli/dist/bin.js',
      owner: '@cat-factory/cli',
      targets: ['backend/packages/cli/build/bin.js'],
    },
  ])
})

test("node's own options do not stand in for the script argument", () => {
  const drift = findBinPathDrift(
    DEPLOY('node --watch --env-file-if-exists=.env ../../backend/packages/cli/dist/other.js'),
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(
    drift.map((finding) => finding.spawned),
    ['backend/packages/cli/dist/other.js'],
  )
})

test('a path standing alone as the command is spawned just as `node <path>` is', () => {
  // The executable-entry-point spelling of the same call. Watching only the `node` form would
  // make the guard a matter of spelling rather than of what the script actually runs.
  const drift = findBinPathDrift(
    DEPLOY('../../backend/packages/cli/dist/other.js supervise'),
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(
    drift.map((finding) => finding.spawned),
    ['backend/packages/cli/dist/other.js'],
  )
})

test('a package spawning its OWN build output has no declaration to drift from', () => {
  const drift = findBinPathDrift(
    [
      {
        path: 'backend/packages/cli/package.json',
        dir: 'backend/packages/cli',
        scripts: { start: 'node dist/tool.js' },
      },
    ],
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(drift, [])
})

test('a tracked source file carries none of the fragility, so it is not checked', () => {
  const drift = findBinPathDrift(
    DEPLOY('node ../../backend/packages/cli/src/bin.ts supervise'),
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(drift, [])
})

test('a path into a package that declares no bin has nothing to be checked against', () => {
  const drift = findBinPathDrift(
    DEPLOY('node ../../backend/packages/kernel/dist/x.js'),
    collectBinTargets([CLI]),
    trackedSources,
  )
  assert.deepEqual(drift, [])
})
