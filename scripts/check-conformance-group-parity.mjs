#!/usr/bin/env node
// Requires every group of the split cross-runtime conformance suite to run on EVERY facade, and
// the aggregate to stay total over the same list.
//
// The rule it protects: `@cat-factory/conformance` is what makes a facade-parity gap a test
// failure instead of a production surprise, and CLAUDE.md treats such a gap as a showstopper. The
// suite used to be one `defineConformanceSuite(harness)` call per facade, so wiring it was a
// single line nobody could half-do. It is now five group functions × three facades = fifteen
// registrations spread over fifteen spec files, and nothing joins them: add a sixth group and the
// suite that runs is whatever the last person remembered to wire. The failure reports GREEN — the
// facade runs the groups it does have, every assertion passes, and the missing group's assertions
// simply never execute, which is indistinguishable from them passing.
//
// Both directions of the aggregate are checked too. It runs on no facade today (all three call the
// groups directly), which is exactly why it can rot unnoticed: a group added only to the aggregate
// runs nowhere at all, and a group added only to the facades leaves the one call a NEW facade is
// pointed at covering less than the name promises.
//
// Scope, stated because the package exports more than these: only the `define…Conformance` GROUPS,
// the split halves of one suite every facade owes. The `define…Suite` exports beside them
// (`defineCacheSuite`, `defineLlmMetricsSuite`) are per-capability suites a facade opts into, and
// a facade legitimately running one and not another is not drift.
//
// Usage:  node scripts/check-conformance-group-parity.mjs
// Exit 0 = every facade runs every group; exit 1 = a registration has drifted.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateCalls,
  exportedGroups,
  missingGroups,
  registeredGroups,
} from './conformance-group-parity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUITE = join(root, 'backend', 'internal', 'conformance', 'src', 'suite.ts')

/** Every facade that must run the whole suite, by the test tree its spec files live in. */
const FACADES = [
  { name: 'cloudflare', dir: join('backend', 'runtimes', 'cloudflare', 'test') },
  { name: 'node', dir: join('backend', 'runtimes', 'node', 'test') },
  { name: 'local', dir: join('backend', 'runtimes', 'local', 'test') },
]

/** Every spec file under a directory, recursively (the Worker keeps its conformance specs a level down). */
function specFiles(dir) {
  if (!existsSync(dir)) {
    // Named rather than an ENOENT stack: a moved test tree would otherwise read as this guard
    // being broken, when what it is reporting is a facade whose specs it can no longer see.
    throw new Error(
      `no test tree at ${dir}; if a facade moved its specs, update FACADES in ` +
        'scripts/check-conformance-group-parity.mjs to match',
    )
  }
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...specFiles(path))
    else if (/\.(spec|test)\.ts$/.test(entry.name)) found.push(path)
  }
  return found
}

const suite = readFileSync(SUITE, 'utf8')
const groups = exportedGroups(suite)
const failures = []

const aggregate = aggregateCalls(suite)
const uncalled = missingGroups(groups, aggregate)
if (uncalled.length > 0) {
  failures.push(
    `\`defineConformanceSuite\` does not call: ${uncalled.join(', ')}. The aggregate is what a ` +
      'new facade reaches for first, so a group it skips is a group that facade never runs.',
  )
}
const unexported = missingGroups(aggregate, groups)
if (unexported.length > 0) {
  failures.push(
    `\`defineConformanceSuite\` calls ${unexported.join(', ')}, which suite.ts does not export. ` +
      'A facade cannot register a group it cannot import.',
  )
}

for (const facade of FACADES) {
  const dir = join(root, facade.dir)
  const registered = registeredGroups(specFiles(dir).map((path) => readFileSync(path, 'utf8')))
  const missing = missingGroups(groups, registered)
  if (missing.length > 0) {
    failures.push(
      `the ${facade.name} facade runs no spec calling: ${missing.join(', ')}. Add one per group ` +
        `under ${facade.dir}/, copying a sibling \`conformance.<group>.spec.ts\`.`,
    )
  }
}

if (failures.length > 0) {
  console.error(
    'check-conformance-group-parity: the conformance suite does not run whole on every facade.\n',
  )
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    '\nEvery facade must run every group, or the assertions it skips report green by being ' +
      'absent. See backend/internal/conformance/README.md.',
  )
  process.exit(1)
}

console.log(
  `Conformance group parity OK (${groups.length} groups × ${FACADES.length} facades, plus the aggregate).`,
)
