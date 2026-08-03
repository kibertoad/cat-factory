#!/usr/bin/env node
// Bans the SILENT PROMISE DROP — `.catch(() => {})` — in backend non-test source.
//
// The observability gap analysis (docs/initiatives/observability-logging-gaps.md, B1) counted
// ~115 of these: work whose failure must not propagate into the caller, dropped with no log, no
// metric and no marker. Phase 1 gave the domain packages a `Logger` port and
// `runBestEffort(logger, label, fn, fields)` — the same swallow, plus one `warn` naming the
// operation with the cause attached. Phase 1b drained the backend tail. This guard is what stops
// it regrowing: without it the idiom comes back one convenient call site at a time, and the
// initiative has to be re-run to find them.
//
// It is a script rather than a lint rule because oxlint ships no `no-restricted-syntax`
// (checked against oxlint 1.75) — the same reason `check-file-size.mjs` exists beside
// `max-lines`. Pure node, no install, runs in the always-on `repo-guards` CI job.
//
// This file is the WALKER only. The detection — which spellings of an empty handler count, and
// how a comment or string literal is told apart from code — lives in `silent-catch.mjs`, with
// fixtures in `silent-catch.test.mjs` (`node --test 'scripts/*.test.mjs'`). That split is not
// ceremony: a guard nothing tests is a guard that is trusted without evidence, and the first
// version of this one had a hole in the exact shape of the idiom it bans (a `//` inside a string
// on the same line switched it off).
//
// SCOPE — deliberately narrower than "all source", and the gap is tracked, not forgotten:
//   - `backend/packages/**` + `backend/runtimes/**`, non-test only. These are the packages the
//     kernel `Logger` port reaches, so every site here has a mechanical fix.
//   - `backend/internal/executor-harness` and `backend/internal/deploy-harness` are EXCLUDED:
//     a harness source change bumps the published runner image, so the initiative batches all
//     harness work into one slice (5.5). Adding them here would force an image bump for a
//     logging-only change.
//   - `frontend/**` is EXCLUDED: the SPA has no logger to report through. Client-side error
//     reporting is its own slice (6.5 / finding C8); the idiom becomes bannable there once a
//     sink exists.
//   - `sdk/typescript/src` IS scanned, non-test only, even though it cannot reach the kernel
//     `Logger` (a published client's dependencies become every consumer's, so it depends on
//     nothing). It has no mechanical fix, only the escape hatch — which is the point: a client
//     library swallowing a rejection is exactly where a drop goes unseen forever, since there is
//     no operator watching its logs. Each one states its reason instead.
//   - A BARE `catch {}` is not checked here. There are ~110 in scope, most of them documented
//     deliberate swallows, and draining them is its own slice (1.2d) rather than a drive-by.
//
// What DOES count is every spelling of an empty `.catch` handler — arrow or `function`, typed
// param or not, and a body holding only a comment. That last one matters most: it is how the
// idiom grows back, because it lets an author document a swallow without the stated reason the
// escape hatch demands. `.catch(noop)` is out of reach by design — whether a named function is
// empty is not a question a text scan can answer, and guessing makes a guard unpredictable.
//
// ESCAPE HATCH: a genuinely-correct silent drop keeps the idiom and states why, on the line
// before it:
//
//     // silent-catch-ok: the race below already observes and reports this rejection.
//     promise.catch(() => {})
//
// The marker requires a reason after the colon, so opting out is a sentence a reviewer reads
// rather than a token they skim past.
//
// Usage:  node scripts/check-silent-catch.mjs
// Exit 0 = clean; exit 1 = at least one un-annotated silent drop.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSilentCatches } from './silent-catch.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Roots scanned. See the SCOPE note above for what is deliberately absent. */
const SCAN_ROOTS = ['backend/packages', 'backend/runtimes', 'sdk/typescript/src']

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'drizzle', 'migrations'])

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
    } else if (/\.[cm]?ts$/.test(entry) && !entry.endsWith('.d.ts')) {
      yield abs
    }
  }
}

const failures = []

for (const root of SCAN_ROOTS) {
  for (const abs of sourceFiles(join(repoRoot, root))) {
    const rel = relative(repoRoot, abs).replaceAll('\\', '/')
    if (isTestPath(rel)) continue
    for (const line of findSilentCatches(readFileSync(abs, 'utf8'))) {
      failures.push(`${rel}:${line}`)
    }
  }
}

if (failures.length > 0) {
  console.error('Silent promise drops found (a swallowed failure with no log, no cause):\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nReplace each with `runBestEffort(logger, label, fn, fields)` from @cat-factory/kernel —',
  )
  console.error('it keeps the swallow and adds one `warn` naming the operation and its cause.')
  console.error('Patterns: backend/docs/logging.md. A genuinely-silent drop annotates itself:')
  console.error('  // silent-catch-ok: <why this failure needs no report>')
  process.exit(1)
}

console.log('No silent promise drops.')
