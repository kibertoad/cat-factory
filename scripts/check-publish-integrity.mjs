#!/usr/bin/env node
// Guards the PUBLISHED ARTIFACT of every publishable package. `dist/` is gitignored, so a
// publish path that skips the build ships an "empty shell" — a package.json whose entry
// points resolve to nothing (exactly how @cat-factory/gitlab and @cat-factory/provider-s3
// once reached npm as shells; `prepublishOnly` now rebuilds on publish, this is the CI
// backstop). Three layers, run over every non-private workspace package after `pnpm build`:
//   1. Empty-shell guard: every file that `main`/`types`/`bin`/`exports` points at exists
//      and is non-empty.
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

// Run via a shell so the `pnpm` shim resolves cross-platform: bare `spawn('pnpm', …)` without
// a shell throws ENOENT on win32 (this repo's dev platform, where the binary is `pnpm.cmd`),
// and naming the `.cmd` shim explicitly instead throws EINVAL under Node's CVE-2024-27980
// mitigation. `shell: true` sidesteps both (cmd.exe resolves it via PATHEXT; /bin/sh on posix).
// The args below are all repo-controlled literals/paths with no spaces, so no quoting is needed.
const USE_SHELL = true

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
        shell: USE_SHELL,
      },
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    // A spawn failure (binary missing, shim unresolved) emits 'error' and NEVER 'close';
    // with no handler Node would throw it uncaught and leave the Promise pending (hanging
    // Promise.all). Resolve it as a non-zero code so it surfaces as a normal problem.
    child.on('error', (err) => resolvePromise({ relDir, code: 1, output: `${output}${err.message}` }))
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
// Packages whose entry files are missing/empty — attw would only re-report those missing
// files more verbosely, so it's skipped for exactly these (and only these) below.
const shellFailed = new Set()

// 1. Empty-shell guard + 2. publint (in-process API, one pass over all packages).
for (const { relDir, pkg } of packages) {
  for (const entryFile of collectEntryFiles(pkg)) {
    const abs = join(repoRoot, relDir, entryFile)
    // A present-but-empty artifact (0 bytes) is an empty shell too — importing it resolves
    // to nothing — so existence alone isn't enough; require actual content.
    let size = -1
    try {
      size = statSync(abs).size
    } catch {
      // missing → size stays -1
    }
    if (size <= 0) {
      shellFailed.add(relDir)
      const why = size < 0 ? 'does not exist' : 'is empty (0 bytes)'
      problems.push(
        `${pkg.name}: entry point ${entryFile} ${why} — the package would publish as an empty shell. Run \`pnpm build\` first; if dist/ is built, the exports map is wrong.`,
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

// 3. attw over the packed tarball. Run it independently of the publint/shell problems above
// (a publint error in package A must not hide an attw regression in package B), skipping only
// the specific packages whose shell guard already failed — for those attw adds no signal.
const attwTargets = packages.filter(
  ({ relDir, pkg }) => !ATTW_SKIP.has(pkg.name) && !shellFailed.has(relDir),
)
const results = await mapWithConcurrency(attwTargets, ATTW_CONCURRENCY, runAttw)
for (const { relDir, code, output } of results) {
  if (code !== 0) {
    console.error(output)
    problems.push(
      `${relDir}: attw found type-resolution problems in the packed tarball (see output above).`,
    )
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
