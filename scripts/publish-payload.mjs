// The files-payload half of `check-publish-integrity.mjs`, split out so its rules are testable in
// isolation (`scripts/publish-payload.test.mjs`): the same split, for the same reason, as
// `deploy-placeholders.mjs` and `release-versions.mjs`.
//
// Why it sits BESIDE the entry-point (empty-shell) assertion rather than inside it: that one
// resolves `main`/`types`/`bin`/`exports`, which for the twenty-plus `files: ["dist"]` packages is
// strictly stronger, because `main: ./dist/index.js` fails the moment `dist/` is unbuilt.
// `@cat-factory/app` inverts the relation. It publishes SOURCE (`files: ["app", "i18n",
// "nuxt.config.ts"]`, `main: ./nuxt.config.ts`), so the only path the entry-point pass looks at is
// the config file and `app/` + `i18n/` are covered by nothing. It is also on `ATTW_SKIP`
// (a source-published Nuxt layer has no types entry for attw to read) and publint validates the
// manifest rather than the tree, so no layer of that guard sees the payload that IS the package.
// Its `1.0.0` reached npm with 95 files and no `i18n/`, against the ~900 a release ships now.
//
// The same hole covers every SECONDARY payload directory the other packages declare and no entry
// point names: the Worker's five migration trees, the Node runtime's `drizzle/`, the harness's
// `src/`. Where the two assertions do overlap (a `files` entry naming a single file) they agree,
// so the duplication is a deliberate cost of keeping the two failures readable apart: a missing
// entry point and a missing declared payload send a reader to different places.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `files` entries worth resolving on disk: the ones naming one concrete path.
 *
 * Negations (`!dist/.tsbuildinfo`) SUBTRACT from a payload rather than declare one, and a glob's
 * expansion is npm's business, so both are skipped rather than resolved: the same call
 * `collectEntryFiles` already makes about `*` subpaths in the exports tree. `README.md` and
 * `LICENSE` need no handling here because npm ships them whatever `files` says, so they are
 * absent from these lists by design and must never be required in one.
 */
export function resolvablePayloadEntries(files) {
  if (!Array.isArray(files)) return []
  const entries = []
  for (const entry of files) {
    if (typeof entry !== 'string') continue
    if (entry.startsWith('!')) continue
    if (/[*?[\]{}]/.test(entry)) continue
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    if (normalized === '' || normalized === '.') continue
    if (!entries.includes(normalized)) entries.push(normalized)
  }
  return entries
}

// Recursive, and stops at the first hit: a directory holding nothing but empty subdirectories
// reads as what it is, one npm would pack no file from.
function containsAnyFile(dirAbs) {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true
    if (containsAnyFile(join(dirAbs, entry.name))) return true
  }
  return false
}

/**
 * Classifies one resolved payload entry: `null` when it would publish content, otherwise the
 * reason it would not, worded to drop into the operator message.
 */
export function payloadEntryProblem(absPath) {
  let stat
  try {
    stat = statSync(absPath)
  } catch {
    return 'does not exist'
  }
  if (stat.isDirectory()) return containsAnyFile(absPath) ? null : 'contains no files'
  // A 0-byte file publishes nothing either, which is the entry-point rule verbatim.
  return stat.size > 0 ? null : 'is empty (0 bytes)'
}

/**
 * Every `files` entry of one package that would publish nothing: `{ entry, why }` per hit, empty
 * when the declared payload is all there.
 */
export function findMissingPayload(pkgDirAbs, pkg) {
  const problems = []
  for (const entry of resolvablePayloadEntries(pkg?.files)) {
    const why = payloadEntryProblem(join(pkgDirAbs, entry))
    if (why) problems.push({ entry, why })
  }
  return problems
}
