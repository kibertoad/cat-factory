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
//   - A BARE `catch {}` is not checked here. There are ~110 in scope, most of them documented
//     deliberate swallows, and draining them is its own slice (1.2d) rather than a drive-by.
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Roots scanned. See the SCOPE note above for what is deliberately absent. */
const SCAN_ROOTS = ['backend/packages', 'backend/runtimes']

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'drizzle', 'migrations'])

/**
 * The banned idiom: a `.catch` whose handler body is empty, however it is spelled —
 * `() => {}`, `(e) => {}`, `async () => {}`, or with the arrow broken across lines. Written as
 * one regex rather than a parse because the shape is fixed and this runs on every PR.
 */
const SILENT_CATCH = /\.catch\(\s*(?:async\s*)?\(?\s*[\w$]*\s*\)?\s*=>\s*\{\s*\}\s*\)/g

/** An opt-out marker with a stated reason, e.g. `// silent-catch-ok: <why>`. */
const ALLOW_MARKER = /\/\/\s*silent-catch-ok:\s*\S/

/** The kernel helper itself documents the idiom it replaces; its prose is not a violation. */
const EXEMPT_FILES = new Set(['backend/packages/kernel/src/shared/best-effort.ts'])

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

/**
 * Whether a match is inside a comment — the docs in this repo quote the banned idiom when
 * explaining why it was replaced, and a guard that flags its own rationale is unusable.
 * Line comments are checked by prefix; block comments by whether the nearest fence before the
 * match is an opener.
 */
function inComment(src, index, lineStart) {
  if (src.slice(lineStart, index).includes('//')) return true
  const before = src.slice(0, index)
  return before.lastIndexOf('/*') > before.lastIndexOf('*/')
}

/**
 * Whether the CONTIGUOUS `//` comment block directly above the drop carries the opt-out marker.
 * A block rather than a single line, so a reason that needs two lines to be a real sentence still
 * counts; a blank line or any code ends the block, so the marker can't be inherited from afar.
 * `linesBefore` is every line preceding the drop's own line.
 */
function isAnnotated(linesBefore) {
  for (let i = linesBefore.length - 2; i >= 0; i--) {
    const line = linesBefore[i]?.trim() ?? ''
    if (!line.startsWith('//')) return false
    if (ALLOW_MARKER.test(line)) return true
  }
  return false
}

const failures = []

for (const root of SCAN_ROOTS) {
  for (const abs of sourceFiles(join(repoRoot, root))) {
    const rel = relative(repoRoot, abs).replaceAll('\\', '/')
    if (isTestPath(rel) || EXEMPT_FILES.has(rel)) continue
    const src = readFileSync(abs, 'utf8')
    for (const match of src.matchAll(SILENT_CATCH)) {
      const lineStart = src.lastIndexOf('\n', match.index) + 1
      if (inComment(src, match.index, lineStart)) continue
      const before = src.slice(0, lineStart).split('\n')
      if (isAnnotated(before)) continue
      failures.push(`${rel}:${before.length}`)
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
