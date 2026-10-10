// Fixtures for the conformance-group-parity guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the drift it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. This one is exposed to that in a specific way:
// its whole output is a set difference, and an extractor that stopped matching yields an EMPTY
// expected set, which every facade trivially satisfies. The group extractor therefore throws on a
// missing anchor rather than returning nothing, and the tests below pin that alongside the happy
// path.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  aggregateCalls,
  exportedGroups,
  missingGroups,
  registeredGroups,
} from './conformance-group-parity.mjs'

const SUITE = `import type { ConformanceHarness } from './harness.js'
import { defineCoreConformance } from './suites/core.js'
import { defineAgentConformance } from './suites/agents.js'

// Prose mentioning defineMiscConformance, which is not a call.
export {
  defineCoreConformance,
  defineAgentConformance,
}

export function defineConformanceSuite(harness: ConformanceHarness): void {
  defineCoreConformance(harness)
  defineAgentConformance(harness)
}
`

test('reads the groups from the export block, not the prose beside it', () => {
  assert.deepEqual(exportedGroups(SUITE), ['defineAgentConformance', 'defineCoreConformance'])
})

test('ignores the per-capability `define…Suite` exports a facade opts into', () => {
  // `defineCacheSuite` and its siblings are exported from the same package and legitimately run on
  // some facades only; counting them would fail the guard on a difference that is not drift.
  const source = `export { defineCoreConformance, defineCacheSuite, defineLlmMetricsSuite }`
  assert.deepEqual(exportedGroups(source), ['defineCoreConformance'])
})

test('throws rather than reporting an empty group list', () => {
  // An empty expected set makes every facade pass, so a renamed group convention has to fail loudly
  // instead of silently disarming the guard.
  assert.throws(() => exportedGroups('export { somethingElse }'), /no `define…Conformance` group/)
})

test('reads the aggregate from its own body, so a mention above it does not count as a call', () => {
  assert.deepEqual(aggregateCalls(SUITE), ['defineAgentConformance', 'defineCoreConformance'])
})

test('throws when the aggregate is gone, rather than reporting it calls nothing', () => {
  assert.throws(() => aggregateCalls('export const x = 1\n'), /could not find/)
})

test('counts a facade CALL, not a mention in a comment', () => {
  const spec = `// Sibling files call defineAgentConformance and defineMiscConformance.
import { defineCoreConformance } from '@cat-factory/conformance'
defineCoreConformance(harness)
`
  assert.deepEqual(registeredGroups([spec]), ['defineCoreConformance'])
})

test('unions the calls across a facade’s spec files', () => {
  const calls = registeredGroups(['defineCoreConformance(harness)', 'defineMiscConformance(h)'])
  assert.deepEqual(calls, ['defineCoreConformance', 'defineMiscConformance'])
})

test('names what a facade is missing, and stays quiet when it runs everything', () => {
  const groups = ['defineCoreConformance', 'defineMiscConformance']
  assert.deepEqual(missingGroups(groups, ['defineCoreConformance']), ['defineMiscConformance'])
  assert.deepEqual(missingGroups(groups, [...groups, 'defineExtraConformance']), [])
})
