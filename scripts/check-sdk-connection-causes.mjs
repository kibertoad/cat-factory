#!/usr/bin/env node
// Requires the connection-failure cause vocabulary PORTED into each of the four published SDKs to
// still agree with the canonical one in `@cat-factory/contracts`.
//
// Why this is a guard and not a per-language test: the SDKs declare no dependencies by design, so
// none of them can see the contracts picklist, and a test that hardcodes the expected list in the
// SDK's own language is a fifth copy rather than a check. Only something reading BOTH sides can
// detect the drift, and only a repo-level script can read four languages. The failure it prevents
// is silent in every direction: a member added to the platform leaves four clients rendering
// `unknown` for a cause the platform names, and a member retired leaves them claiming one it no
// longer produces.
//
// The extraction, the deliberate limit to the MEMBER SET, and the reasoning live in
// `sdk-connection-causes.mjs`, which has fixtures in `sdk-connection-causes.test.mjs`
// (`node --test 'scripts/*.test.mjs'`).
//
// Pure node, no install; runs in the always-on `repo-guards` CI job beside the others.

import { fileURLToPath } from 'node:url'
import { compareCauseVocabularies, repoReader } from './sdk-connection-causes.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const problems = compareCauseVocabularies(repoReader(ROOT))

if (problems.length > 0) {
  console.error('SDK connection-failure vocabularies have drifted from the platform\u2019s:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\nThe four copies exist because the SDKs have no dependencies. Keeping them in step is ' +
      'what this guard is for: change the member everywhere, or change it nowhere.',
  )
  process.exit(1)
}

console.log('SDK connection-failure vocabularies agree with the platform\u2019s.')
