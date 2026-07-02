/**
 * i18n locale-parity guard — fail a PR that changes an `en.json` message key without
 * changing the SAME key in every other locale too.
 *
 * The repo's other i18n guards (typed message keys, the `vue-i18n-extract` missing-key check)
 * catch a raw-key leak, but nothing stops a translated catalog going STALE: an `en.json` value
 * edited (or a key added) while `es/fr/he/ja/pl/tr/uk` keep the old text — which is exactly the
 * class of miss review found on the frontend-preview work (an updated `envInjectionHint` in `en`
 * only). This closes that gap.
 *
 * It is a CHANGE-COUPLING check against the PR base, NOT a full key-parity check, so it does not
 * fight the incremental-translation policy: it looks ONLY at the keys THIS PR touched in `en`
 * (added / modified / removed vs the base) and requires each such key to be touched in every
 * other locale too. Pre-existing translation lag on keys the PR did not touch is left alone.
 *
 * Translator-description siblings (`@<key>`) live only in `en.json`, so any path with an
 * `@`-prefixed segment is ignored — editing a description never forces a locale change.
 *
 * Usage: `node scripts/i18n-locale-parity.mjs --since origin/main`
 *   - `--since <ref>` (or `I18N_BASE_REF=<ref>`) names the base git ref to diff against.
 *   - With no base ref (a push/dispatch build, not a PR) it prints a notice and passes: there
 *     is no "changed vs base" set to enforce off a PR.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const EN_FILE = 'en.json'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const baseRef = arg('--since') ?? process.env.I18N_BASE_REF
if (!baseRef) {
  console.log(
    'i18n locale parity: no base ref (--since / I18N_BASE_REF) — skipping (not a PR build).',
  )
  process.exit(0)
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const localesRel = 'frontend/app/i18n/locales'
const localesDir = join(repoRoot, localesRel)

// Diff against the MERGE-BASE of the PR and its base branch, not the base branch TIP. The base
// may have advanced past the PR's fork point; comparing against the tip would count keys the base
// gained AFTER the fork as "changed by this PR". `merge-base` pins the fork point, so only this
// PR's own edits are considered. Falls back to the ref itself if merge-base can't be computed.
let mergeBase = baseRef
try {
  mergeBase = execFileSync('git', ['merge-base', baseRef, 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch {
  // Shallow checkout without a common ancestor — fall back to the ref (best effort).
}

/** Flatten a message catalog to `dotted.key → string value`, skipping `@description` siblings. */
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) continue // translator-description metadata (en-only, never a message)
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.set(key, typeof v === 'string' ? v : JSON.stringify(v))
  }
}

/** The current on-disk catalog, flattened. */
function currentCatalog(file) {
  const out = new Map()
  flatten(JSON.parse(readFileSync(join(localesDir, file), 'utf8')), '', out)
  return out
}

/** The base (git `<ref>`) catalog, flattened. A file absent at the base is an empty catalog. */
function baseCatalog(file) {
  const out = new Map()
  let raw
  try {
    raw = execFileSync('git', ['show', `${mergeBase}:${localesRel}/${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return out // new file at this PR — every key counts as added
  }
  flatten(JSON.parse(raw), '', out)
  return out
}

/** Keys whose value differs between two flattened catalogs (added, modified, or removed). */
function changedKeys(base, cur) {
  const keys = new Set([...base.keys(), ...cur.keys()])
  const changed = new Set()
  for (const k of keys) if (base.get(k) !== cur.get(k)) changed.add(k)
  return changed
}

const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith('.json'))
if (!localeFiles.includes(EN_FILE)) {
  console.error(`i18n locale parity: ${EN_FILE} not found in ${localesRel}`)
  process.exit(1)
}
const otherLocales = localeFiles.filter((f) => f !== EN_FILE)

const enBase = baseCatalog(EN_FILE)
const enCur = currentCatalog(EN_FILE)
const enChanged = changedKeys(enBase, enCur)

if (enChanged.size === 0) {
  console.log('i18n locale parity: no en.json message keys changed vs base — nothing to check.')
  process.exit(0)
}

// For each locale, every en-changed key must be touched the same way: an en add/modify requires
// the locale's value to also differ from its base (added or updated); an en removal requires the
// locale to have removed it too (a locale that never had it is fine — pre-existing lag).
const violations = []
for (const file of otherLocales) {
  const base = baseCatalog(file)
  const cur = currentCatalog(file)
  for (const key of enChanged) {
    const enHasNow = enCur.has(key)
    if (enHasNow) {
      const touched = base.get(key) !== cur.get(key)
      if (!touched) {
        violations.push(
          `${file}: '${key}' — en ${enBase.has(key) ? 'changed' : 'added'} it, but ${file} was not updated to match.`,
        )
      }
    } else if (cur.has(key)) {
      violations.push(`${file}: '${key}' — en removed it, but ${file} still has it.`)
    }
  }
}

if (violations.length) {
  console.error(
    `✗ i18n locale parity: ${violations.length} locale key(s) not kept in sync with en.json:\n`,
  )
  for (const v of violations) console.error(`   - ${v}`)
  console.error(
    `\nen.json changed ${enChanged.size} message key(s) in this PR: [${[...enChanged].join(', ')}].` +
      `\nUpdate the SAME key(s) in every locale (${otherLocales.join(', ')}) so translations don't go stale.`,
  )
  process.exit(1)
}

console.log(
  `✓ i18n locale parity: all ${enChanged.size} changed en.json key(s) mirrored across ${otherLocales.length} locale(s).`,
)
