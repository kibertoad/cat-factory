#!/usr/bin/env node
// Guards the PUBLISHED ARTIFACT of every publishable package. `dist/` is gitignored, so a
// publish path that skips the build ships an "empty shell" — a package.json whose entry
// points resolve to nothing (exactly how @cat-factory/gitlab and @cat-factory/provider-s3
// once reached npm as shells; `prepublishOnly` now rebuilds on publish, this is the CI
// backstop). Three layers, run over every non-private workspace package after `pnpm build`:
//   1. Empty-shell guard: every file that `main`/`types`/`bin`/`exports` points at exists.
//   2. publint: the package.json publish contract (files/exports/type shape) is coherent.
//   3. attw --pack --profile esm-only: the *packed tarball*'s types resolve for node16-ESM
//      and bundler consumers (every package here is ESM-only, so the node10/CJS resolutions
//      of attw's default profile don't apply).
//
// Usage:  pnpm build && node scripts/check-publish-integrity.mjs
// Exit 0 = every publishable package ships a coherent artifact; exit 1 otherwise.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publint } from 'publint'
import { formatMessage } from 'publint/utils'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The workspace globs from pnpm-workspace.yaml, as a literal list (same convention as
// check-package-catalog.mjs). Private packages are skipped at read time, so listing the
// internal/deploy globs costs nothing and keeps the two scripts symmetric.
const WORKSPACE_GLOBS = [
  'backend/packages/*',
  'backend/runtimes/*',
  'backend/internal/*',
  'frontend/app',
  'deploy/backend',
  'deploy/frontend',
  'deploy/node',
  'deploy/local',
]

// @cat-factory/app is a source-published Nuxt layer (main: ./nuxt.config.ts, no dist, no
// .d.ts entry) — attw has no types entry to check, so only the shell guard + publint run.
const ATTW_SKIP = new Set(['@cat-factory/app'])

// Per-package extra attw flags. @cat-factory/worker is consumed exclusively through
// bundler resolution (wrangler / vitest-pool-workers — it cannot run outside workerd), and
// its d.ts files carry extensionless relative imports that are valid there but never
// resolve under node16-ESM; suppress that one rule for it rather than mass-adding .js
// extensions across the facade. Every other package stays on the full esm-only profile.
const ATTW_EXTRA_FLAGS = new Map([
  ['@cat-factory/worker', ['--ignore-rules', 'internal-resolution-error']],
])

// attw shells out to `npm pack` per package (~2-4s each); bound the parallelism.
const ATTW_CONCURRENCY = 4

function expandGlob(glob) {
  if (!glob.endsWith('/*')) return [glob]
  const base = glob.slice(0, -2)
  return readdirSync(join(repoRoot, base))
    .map((entry) => join(base, entry))
    .filter((rel) => {
      try {
        return statSync(join(repoRoot, rel)).isDirectory()
      } catch {
        return false
      }
    })
}

function readPackage(relDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, relDir, 'package.json'), 'utf8'))
    return { relDir, pkg }
  } catch {
    return null
  }
}

// Collect every relative file path an exports value tree points at, skipping
// './package.json' self-references and '*' subpath patterns (none in this repo today).
function collectEntryFiles(pkg) {
  const files = new Set()
  const addPath = (value) => {
    if (typeof value !== 'string' || !value.startsWith('.')) return
    if (value === './package.json' || value.includes('*')) return
    files.add(value)
  }
  addPath(pkg.main)
  addPath(pkg.types)
  if (typeof pkg.bin === 'string') addPath(pkg.bin)
  else if (pkg.bin) for (const value of Object.values(pkg.bin)) addPath(value)
  const walk = (node) => {
    if (typeof node === 'string') addPath(node)
    else if (node && typeof node === 'object') for (const value of Object.values(node)) walk(value)
  }
  if (pkg.exports) walk(pkg.exports)
  return [...files]
}

function runAttw({ relDir, pkg }) {
  const extraFlags = ATTW_EXTRA_FLAGS.get(pkg.name) ?? []
  return new Promise((resolvePromise) => {
    const child = spawn(
      'pnpm',
      ['exec', 'attw', '--pack', relDir, '--profile', 'esm-only', ...extraFlags],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => resolvePromise({ relDir, code, output }))
  })
}

async function mapWithConcurrency(items, limit, fn) {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const packages = WORKSPACE_GLOBS.flatMap(expandGlob)
  .map(readPackage)
  .filter((entry) => entry && entry.pkg.name && !entry.pkg.private)

const problems = []

// 1. Empty-shell guard + 2. publint (in-process API, one pass over all packages).
for (const { relDir, pkg } of packages) {
  for (const entryFile of collectEntryFiles(pkg)) {
    if (!existsSync(join(repoRoot, relDir, entryFile))) {
      problems.push(
        `${pkg.name}: entry point ${entryFile} does not exist — the package would publish as an empty shell. Run \`pnpm build\` first; if dist/ is built, the exports map is wrong.`,
      )
    }
  }

  const { messages } = await publint({ pkgDir: join(repoRoot, relDir) })
  for (const message of messages) {
    const formatted = `${pkg.name}: ${formatMessage(message, pkg)}`
    if (message.type === 'error') problems.push(formatted)
    else console.warn(`publint ${message.type}: ${formatted}`)
  }
}

// 3. attw over the packed tarball (skip when the shell guard already failed the package —
// attw would only re-report the missing files more verbosely).
if (problems.length === 0) {
  const attwTargets = packages.filter(({ pkg }) => !ATTW_SKIP.has(pkg.name))
  const results = await mapWithConcurrency(attwTargets, ATTW_CONCURRENCY, runAttw)
  for (const { relDir, code, output } of results) {
    if (code !== 0) {
      console.error(output)
      problems.push(
        `${relDir}: attw found type-resolution problems in the packed tarball (see output above).`,
      )
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  console.error(
    `\ncheck-publish-integrity: ${problems.length} problem(s) across ${packages.length} publishable packages.`,
  )
  process.exit(1)
}

console.log(
  `check-publish-integrity: all ${packages.length} publishable packages ship coherent artifacts (entries exist, publint clean, attw clean). ✅`,
)
