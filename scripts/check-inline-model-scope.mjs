#!/usr/bin/env node
// Every inline LLM caller resolves its credential scope through kernel's `resolveInlineScope`,
// never a hand-built object literal.
//
// WHY THIS IS A GUARD AND NOT A REVIEW NOTE. The scope decides which API keys a call draws on,
// whose local model endpoints it can see, and whether an individual-usage subscription can be
// leased. A caller that drops the run or the user it was holding still resolves a model and still
// returns an answer; the only symptom is the call landing on the deployment's routing default
// instead of the model the workspace's preset names. Six callers had drifted into that shape
// before anyone noticed, across three packages, over about a year. Nothing in the type system can
// see it, because `{ workspaceId }` is a perfectly valid `ModelScope`.
//
// `resolveInlineScope` takes a DISCRIMINATED subject (`block` / `run` / `user` / `workspace`), so
// a caller has to name which tier it holds. That turns the failure from an omission into a claim:
// `kind: 'workspace'` says "I hold no run and no user", which a reviewer can check against the
// caller's own inputs, and which several callers legitimately do say.
//
// TWO CHECKS, because either alone has a hole:
//   1. No object literal passed straight into `.forScope(` / `resolveScopedModelProvider(`. This
//      is the shape every one of the six gaps was written in.
//   2. A file that resolves a scope at all must import the seam. This covers the indirection the
//      first check cannot follow (a literal assigned to a `scope` variable a line earlier).
//
// ESCAPE HATCH, for a genuine pass-through (a wrapper handed a scope its caller already built):
//
//     // inline-scope-ok: forwards the scope the public-API controller resolved from the key.
//     return generator.forScope(input.scope)
//
// The marker requires a reason after the colon, so opting out is a sentence rather than a token.
//
// Usage:  node scripts/check-inline-model-scope.mjs
// Exit 0 = clean; exit 1 = at least one hand-built or un-seamed scope.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnseamedScopes } from './inline-model-scope.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Backend source only: these are the packages that can see kernel's seam. */
const SCAN_ROOTS = ['backend/packages', 'backend/runtimes']

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'drizzle', 'migrations'])

/**
 * Files that define or transport the seam rather than consuming it, so the "must import it" half
 * does not apply. Each is a place a `ModelScope` is a PARAMETER, never a thing being decided.
 */
const DEFINERS = new Set([
  // The port itself: `resolveScopedModelProvider` IS the function under discussion.
  'backend/packages/kernel/src/ports/model-provider.ts',
  // Resolver DECORATORS: each implements `forScope(scope)` and forwards, adding telemetry, a
  // concurrency limit, or the inline subscription substitution. None of them chooses a scope.
  'backend/packages/server/src/agents/modelProviderResolver.ts',
  'backend/runtimes/local/src/harnessInline.ts',
])

function isTestPath(rel) {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?ts$/.test(rel)
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
    if (isTestPath(rel) || DEFINERS.has(rel)) continue
    const src = readFileSync(abs, 'utf8')
    for (const finding of findUnseamedScopes(src)) {
      const detail =
        finding.reason === 'literal'
          ? 'a hand-built scope literal'
          : 'a scope built without the seam'
      failures.push(
        `${rel}:${finding.line}  ${detail}: ${finding.snippet}
` +
          `    State what the caller holds through kernel's resolveInlineScope ` +
          `(block / run / user / workspace), or annotate a genuine pass-through with ` +
          `"// inline-scope-ok: <reason>".`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Inline model scopes must be built through resolveInlineScope (${failures.length} problem(s)):\n`,
  )
  for (const failure of failures) console.error(`  ${failure}\n`)
  process.exit(1)
}

console.log('Inline model scopes: every caller states what it holds.')
