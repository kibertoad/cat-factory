#!/usr/bin/env node
// Soft max-lines budget for non-test source files — the re-accretion guard the July 2026
// code-quality review asked for (docs/code-quality-observability-extensibility-review-2026-07.md
// §4/#5). The engine god-files have been split repeatedly (ExecutionService → RunDispatcher →
// RunAdmission / DeployerStepController / FollowUpGateController / review-kinds), and each time
// the recorded line counts drifted stale while the files silently regrew (RunDispatcher
// 2,779 → 4,217 between audits). This check turns that regrowth into a CI failure instead of a
// biennial audit finding.
//
// Policy:
//   - Every non-test `.ts`/`.vue` source file under the scanned roots must stay at or under
//     DEFAULT_MAX_LINES.
//   - Files that already exceeded it when this guard landed are RATCHETED in
//     LEGACY_ALLOWANCES at (roughly) their then-current size: they may shrink freely but may
//     not grow past their allowance. When you shrink one substantially, lower its allowance in
//     the same PR so the win is locked in; when a file drops under DEFAULT_MAX_LINES, delete
//     its entry.
//   - Genuinely needing to raise an allowance (or add one for a new file) is possible but
//     deliberate: edit this file in the same PR, so the growth is visible in review instead of
//     silent. Prefer extracting a collaborator (the RunDispatcher controllers are the model).
//
// Usage:  node scripts/check-file-size.mjs
// Exit 0 = every file is within budget; exit 1 = a file exceeds it (or a legacy entry is stale).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The soft per-file budget for regular source files. */
const DEFAULT_MAX_LINES = 1500

/**
 * Ratcheted ceilings for the files that predate this guard (their size when it landed,
 * rounded up to the next 50). Shrink-only: lower these as files are split; never raise one
 * without a deliberate, reviewed reason.
 */
const LEGACY_ALLOWANCES = new Map([
  // The cross-runtime conformance suite (review §4), split from one 11.2k-line `suite.ts`
  // into per-group modules under `suites/`. `suite.ts` is now a thin aggregator; each group
  // is ratcheted at its post-split size and keeps ratcheting DOWN as groups sub-split.
  // (`integration.ts` has since sub-split into `integration-{credentials,provisioning,
  // secrets,sources,environments}.ts`, and `execution.ts` into `execution-{tester,review,
  // gates}.ts` — each under DEFAULT_MAX_LINES, so none needs an entry.)
  ['backend/internal/conformance/src/suites/core.ts', 2500],
  ['backend/internal/conformance/src/suites/agents.ts', 1150],
  // The engine files the 2026-07 review names (post-split sizes; keep ratcheting DOWN). The
  // dispatcher's three built-in registries (step handlers / completion interceptors / resolvers)
  // now live in `dispatcher-registries.ts`, so `RunDispatcher.ts` ratchets down accordingly.
  ['backend/packages/orchestration/src/modules/execution/RunDispatcher.ts', 2517],
  ['backend/packages/orchestration/src/modules/execution/ExecutionService.ts', 2820],
  // The three DI composition roots (refactoring-candidates.md #6/#8 own the structural fix).
  // The orchestration root's optional-module factories now live in `container/modules.ts` and its
  // optional wiring flows through `container/module-registry.ts` (refactoring-candidates.md #6), so
  // `container.ts` holds the `CoreDependencies`/`Core` contract + the spine assembly only. The Node
  // root's container-agent-executor wiring now lives in `container-executor-deps.ts`.
  ['backend/runtimes/node/src/container.ts', 2600],
  ['backend/packages/orchestration/src/container.ts', 1948],
  ['backend/packages/orchestration/src/container/modules.ts', 1350],
  ['backend/runtimes/cloudflare/src/infrastructure/container.ts', 2720],
  // Wide-but-flat declaration files (schemas / wire contracts), not control flow.
  // (`entities.ts` was split — the run/execution runtime-state shapes moved to `execution.ts`,
  // both now under DEFAULT_MAX_LINES — so it no longer needs a ratcheted allowance.)
  ['backend/runtimes/node/src/db/schema.ts', 2300],
  // Remaining oversized service/logic files — split candidates, ratcheted meanwhile.
  ['backend/packages/integrations/src/modules/environments/provision-detect.logic.ts', 2321],
  ['backend/packages/server/src/agents/ContainerAgentExecutor.ts', 1700],
  ['backend/packages/server/src/github/FetchGitHubClient.ts', 1550],
  ['backend/packages/integrations/src/modules/environments/EnvironmentConnectionService.ts', 1550],
])

/** Roots scanned for source files (mirrors the workspace layout; deploy/* are one-liners). */
const SCAN_ROOTS = ['backend/packages', 'backend/runtimes', 'backend/internal', 'frontend/app']

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.nuxt', '.output', 'coverage'])

function isTestPath(rel) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(rel) ||
    /\.(test|spec)\.[cm]?ts$/.test(rel) ||
    /\.(test|spec)-d\.ts$/.test(rel)
  )
}

function* sourceFiles(dirAbs) {
  for (const entry of readdirSync(dirAbs)) {
    const abs = join(dirAbs, entry)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      yield* sourceFiles(abs)
    } else if (/\.([cm]?ts|vue)$/.test(entry) && !entry.endsWith('.d.ts')) {
      yield abs
    }
  }
}

const failures = []
const seenLegacy = new Set()

for (const root of SCAN_ROOTS) {
  const rootAbs = join(repoRoot, root)
  for (const abs of sourceFiles(rootAbs)) {
    const rel = relative(repoRoot, abs).replaceAll('\\', '/')
    if (isTestPath(rel)) continue
    const lines = readFileSync(abs, 'utf8').split('\n').length
    const allowance = LEGACY_ALLOWANCES.get(rel)
    if (allowance !== undefined) seenLegacy.add(rel)
    const budget = allowance ?? DEFAULT_MAX_LINES
    if (lines > budget) {
      failures.push(
        `${rel}: ${lines} lines exceeds its budget of ${budget}` +
          (allowance !== undefined
            ? ' (a ratcheted legacy allowance — split the file instead of growing it)'
            : ` (the default max of ${DEFAULT_MAX_LINES} — extract a collaborator/module)`),
      )
    }
  }
}

// A legacy entry whose file no longer exists (renamed/deleted) is stale — fail so the
// allowance can't silently linger and be repurposed by a future file at the same path.
for (const rel of LEGACY_ALLOWANCES.keys()) {
  if (!seenLegacy.has(rel)) {
    failures.push(`${rel}: legacy allowance entry is stale (file not found) — remove it`)
  }
}

if (failures.length > 0) {
  console.error('File-size budget check failed:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nSplit the file along a cohesive seam (see the RunDispatcher controller extractions),',
  )
  console.error('or — deliberately — adjust scripts/check-file-size.mjs in the same PR.')
  process.exit(1)
}

console.log('File-size budgets OK.')
