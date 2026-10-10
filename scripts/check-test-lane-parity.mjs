#!/usr/bin/env node
// Requires `pnpm test:quick` to exclude EXACTLY the packages CI's no-DB lane excludes.
//
// The rule it protects: `test:quick` is the scope a contributor runs when no Postgres and no
// `workerd` are available, and `docs/internal/running-tests.md` sells it as "the same set CI runs
// as its `Test units (no DB)` lane". That claim is what makes the script worth reaching for: it is
// broad confidence with no infra, and CI having already run the identical set is the only evidence
// on offer that the set is really infra-free.
//
// It is also the same fact written twice (a deny-list in the root package.json and a deny-list in
// the workflow) with nothing joining them. Add a fourth database-backed facade and whichever list
// is updated second silently changes what the other means: `test:quick` starts wanting a database
// it says it does not need (failing with `DATABASE_URL is required`, which reads as the
// contributor's setup being broken), or it quietly stops covering a package CI does cover, which
// is worse because it reports green.
//
// Both directions are checked. Unlike the reserved-env-key guard, neither side is the safe one to
// over-list: an extra local exclusion is false confidence, a missing one is a script that cannot
// run where it promises to.
//
// The single-source alternative (CI invoking `pnpm test:quick` directly) was considered and
// rejected: the script pins `--concurrency=50%` for a developer's box, which on a two-core runner
// would halve CI's own fan-out, and it goes through Turbo where the lane deliberately does not
// (Turbo's strict env mode filters the environment the lane's other steps rely on).
//
// Usage:  node scripts/check-test-lane-parity.mjs
// Exit 0 = the two lists agree; exit 1 = they have drifted.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  diffExclusions,
  excludedPackages,
  packageScript,
  workflowJob,
} from './test-lane-parity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(root, 'package.json')
const WORKFLOW = join(root, '.github', 'workflows', 'ci.yml')

/** The workflow job id of the lane named "Test units (no DB)". */
const NO_DB_LANE_JOB = 'test-units'
const SCRIPT = 'test:quick'

const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
const workflow = readFileSync(WORKFLOW, 'utf8')

const script = excludedPackages(packageScript(pkg, SCRIPT))
const lane = excludedPackages(workflowJob(workflow, NO_DB_LANE_JOB))

if (script.length === 0 || lane.length === 0) {
  // Neither side has ever been empty, and two empty lists compare equal, so an extractor that
  // stopped matching would report agreement having read nothing. Fail instead.
  console.error(
    `check-test-lane-parity: read ${script.length} exclusion(s) from \`${SCRIPT}\` and ` +
      `${lane.length} from the \`${NO_DB_LANE_JOB}\` job. An empty list on either side means the ` +
      'extractor no longer matches how the filters are written, not that the lanes agree.',
  )
  process.exit(1)
}

const { onlyInScript, onlyInLane } = diffExclusions(script, lane)

if (onlyInScript.length === 0 && onlyInLane.length === 0) {
  console.log(
    `check-test-lane-parity: \`${SCRIPT}\` and CI's no-DB lane exclude the same ` +
      `${script.length} package(s) (${script.join(', ')}).`,
  )
  process.exit(0)
}

console.error(
  `check-test-lane-parity: \`pnpm ${SCRIPT}\` and CI's "Test units (no DB)" lane no longer\n` +
    `exclude the same packages, so the scope a contributor runs without infra is not the scope\n` +
    `CI proved needs none (docs/internal/running-tests.md states that they match).\n`,
)
for (const name of onlyInScript) {
  console.error(`  • ${name}: excluded by \`${SCRIPT}\` only. CI runs it, so the local script`)
  console.error(`    silently covers less than it claims.`)
}
for (const name of onlyInLane) {
  console.error(`  • ${name}: excluded by the CI lane only. \`${SCRIPT}\` still runs it and will`)
  console.error(`    demand the infra the lane exists to avoid.`)
}
console.error(
  `\nFix: make the two deny-lists agree:\n` +
    `  package.json → scripts["${SCRIPT}"]\n` +
    `  .github/workflows/ci.yml → the \`${NO_DB_LANE_JOB}\` job`,
)
process.exit(1)
