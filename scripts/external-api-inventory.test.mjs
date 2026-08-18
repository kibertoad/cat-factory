// Fixtures for the external-API inventory guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the drift it watches from reopening, and this one is exposed
// to that in a specific way: its output is a set difference, so a detector that stopped matching
// yields an EMPTY candidate set, which every classification map satisfies trivially and silently.
// The call forms below are the ones this repo actually uses, including the three wrappers that made
// the skill's hand-written greps miss Confluence, Zeplin, Figma, Notion and the MCP OAuth walk.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  classificationFor,
  makesOutboundCall,
  malformedEntries,
  sweptVendors,
  unclassifiedFiles,
  unmatchedEntries,
} from './external-api-inventory.mjs'

test('detects the global in every call position we write it in', () => {
  assert.ok(makesOutboundCall('const res = await fetch(url, init)'))
  assert.ok(makesOutboundCall('  return fetch(url, init)'))
  assert.ok(makesOutboundCall('const pending = fetch(url)'))
  assert.ok(makesOutboundCall('const res = await globalThis.fetch(url)'))
})

test('detects the wrappers the vendor traffic actually goes through', () => {
  // Each of these is a real call form that a `fetch(` grep alone does not see, which is how
  // Confluence and Zeplin stayed off the inventory the skill's worked example produced.
  assert.ok(makesOutboundCall('const res = await safeFetch(url, init, assertSafe, makeError)'))
  assert.ok(makesOutboundCall('const safeFetch = createHostPinnedFetch({ host, label })'))
  assert.ok(makesOutboundCall('const response = await fetchImpl(`${base}/rest/api/3/issue`, {}) '))
  assert.ok(makesOutboundCall('const tokens = await this.http(spec.tokenUrl, body)'))
})

test('ignores an inbound `fetch` handler, which is a server rather than a call', () => {
  // Nine Durable Objects and the Worker entry point declare one. Matching them would bury the
  // vendor calls under entries whose only honest classification is "this is not a call".
  assert.equal(makesOutboundCall('  async fetch(request: Request): Promise<Response> {'), false)
  assert.equal(makesOutboundCall('export default { async fetch(req, env) {'), false)
})

test('ignores a bare reference that is not a call', () => {
  assert.equal(makesOutboundCall('fetchImpl?: typeof fetch'), false)
  assert.equal(makesOutboundCall('const http = this.deps.fetchImpl ?? fetch'), false)
})

const MAP = [
  { path: 'backend/internal/executor-harness/src/', kind: 'internal', reason: 'job-local' },
  {
    path: 'backend/internal/executor-harness/src/vcs-api.ts',
    kind: 'vendor',
    vendors: ['github', 'gitlab'],
  },
  { path: 'backend/packages/gitlab/src/', kind: 'vendor', vendors: ['gitlab'] },
]

test('the longest matching path wins, so one vendor file can sit inside our own directory', () => {
  // The harness is ours except for its VCS client, and restating the directory per file would be
  // the thing that rots.
  const inner = classificationFor('backend/internal/executor-harness/src/vcs-api.ts', MAP)
  assert.deepEqual(inner.vendors, ['github', 'gitlab'])
  const outer = classificationFor('backend/internal/executor-harness/src/context-images.ts', MAP)
  assert.equal(outer.kind, 'internal')
})

test('an exact entry does not cover its siblings', () => {
  const map = [{ path: 'a/b.ts', kind: 'vendor', vendors: ['x'] }]
  assert.equal(classificationFor('a/b.ts', map).kind, 'vendor')
  assert.equal(classificationFor('a/bc.ts', map), null)
})

test('reports a call site no entry covers: the new unswept integration', () => {
  const files = ['backend/packages/gitlab/src/client.ts', 'backend/packages/whimsy/src/vendor.ts']
  assert.deepEqual(unclassifiedFiles(files, MAP), ['backend/packages/whimsy/src/vendor.ts'])
})

test('reports an entry no call site matches: the map rotting into fiction', () => {
  // Worse than an absent entry, because a stale `vendor` row reads as evidence that vendor is
  // still reached from there.
  const files = [
    'backend/internal/executor-harness/src/vcs-api.ts',
    'backend/internal/executor-harness/src/context-images.ts',
  ]
  assert.deepEqual(unmatchedEntries(files, MAP), ['backend/packages/gitlab/src/'])
})

test('a prefix every file resolves past is dead too, not merely shadowed', () => {
  // "Unmatched" means no file RESOLVED here, not that no file starts with it. A directory whose
  // every call site has since earned its own entry is weight the next reader has to disprove.
  const files = ['backend/internal/executor-harness/src/vcs-api.ts']
  assert.ok(unmatchedEntries(files, MAP).includes('backend/internal/executor-harness/src/'))
})

test('a vendor entry naming no vendor is malformed, being the hole in a different disguise', () => {
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'vendor', vendors: [] }]), [
    "a/: kind 'vendor' with no vendors listed",
  ])
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'internal' }]), [
    "a/: kind 'internal' with no reason given",
  ])
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'maybe' }]), ["a/: unknown kind 'maybe'"])
  assert.deepEqual(malformedEntries(MAP), [])
})

test('the swept vendor list is deduplicated across entries', () => {
  assert.deepEqual(sweptVendors(MAP), ['github', 'gitlab'])
})
