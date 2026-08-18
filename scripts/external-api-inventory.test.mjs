// Fixtures for the external-API inventory guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the drift it watches from reopening, and this one is exposed
// to that in a specific way: its output is a set difference, so a detector that stopped matching
// yields an EMPTY candidate set, which every classification map satisfies trivially and silently.
// The call forms below are the ones this repo actually uses, including the wrappers that made the
// skill's hand-written greps miss Confluence, Zeplin, Figma, Notion and the MCP OAuth walk, and the
// LOCALLY BOUND aliases that made the first version of this detector miss OpenRouter, the whole
// OIDC/SSO surface, the MCP probe and a GitHub call carrying the pinned API version.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  classificationFor,
  declaresVendorEndpoint,
  makesOutboundCall,
  malformedEntries,
  stripComments,
  sweptVendors,
  unclassifiedFiles,
  unmatchedEntries,
  vendorEndpointHosts,
  vendorEvidenceGaps,
} from './external-api-inventory.mjs'

test('detects the global in every call position we write it in', () => {
  assert.ok(makesOutboundCall('const res = await fetch(url, init)'))
  assert.ok(makesOutboundCall('  return fetch(url, init)'))
  assert.ok(makesOutboundCall('const pending = fetch(url)'))
  assert.ok(makesOutboundCall('const res = await globalThis.fetch(url)'))
  assert.ok(makesOutboundCall('void fetch(url).catch(report)'))
})

test('detects the wrappers the vendor traffic actually goes through', () => {
  // Each of these is a real call form that a `fetch(` grep alone does not see, which is how
  // Confluence and Zeplin stayed off the inventory the skill's worked example produced.
  assert.ok(makesOutboundCall('const res = await safeFetch(url, init, assertSafe, makeError)'))
  assert.ok(makesOutboundCall('const safeFetch = createHostPinnedFetch({ host, label })'))
  assert.ok(makesOutboundCall('const response = await fetchImpl(`${base}/rest/api/3/issue`, {}) '))
  assert.ok(makesOutboundCall('const tokens = await this.http(spec.tokenUrl, body)'))
})

test('detects a call through a locally bound alias, by the BINDING rather than the name', () => {
  // The alias can be called anything, so no name list finds it: `doFetch`, `ctx.fetch`,
  // `this.apiFetch`, `fetchLocalRunner`. What every one of them has is a file that either falls
  // back to the global or types the transport it was handed, and that is what is matched here.
  // Every line below is live source, and every one of them was invisible to the first detector.
  assert.ok(makesOutboundCall('const doFetch = this.deps.fetch ?? fetch'))
  assert.ok(makesOutboundCall('this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)'))
  assert.ok(makesOutboundCall('  fetchImpl?: typeof fetch'))
  assert.ok(makesOutboundCall('  ctx: { fetch: typeof fetch },'))
  assert.ok(makesOutboundCall('function probe(doFetch: typeof fetch = fetch) {'))
})

test('a bare aliased call is caught through its file, not its line', () => {
  // Worth pinning as the LIMIT it is. `await ctx.fetch(url)` on its own is indistinguishable from
  // `await queue.send(url)`: matching `<anything>.fetch(` would sweep in Hono's `app.fetch(request)`,
  // a Durable Object stub's `.fetch()` and every domain method named `fetch`. The file reaches the
  // inventory because it TYPES the transport, which is how `userSecretKinds.ts` does.
  assert.equal(makesOutboundCall('const res = await ctx.fetch(`${GITHUB_API_BASE}/user`)'), false)
  assert.ok(
    makesOutboundCall(
      [
        'async testConnection(input, ctx: { fetch: typeof fetch }) {',
        '  return ctx.fetch(url)',
        '}',
      ].join('\n'),
    ),
  )
})

test('ignores an inbound `fetch` handler, which is a server rather than a call', () => {
  // Nine Durable Objects and the Worker entry point declare one. Matching them would bury the
  // vendor calls under entries whose only honest classification is "this is not a call".
  assert.equal(makesOutboundCall('  async fetch(request: Request): Promise<Response> {'), false)
  assert.equal(makesOutboundCall('export default { async fetch(req, env) {'), false)
})

test('ignores a mention with no call, no binding and no type', () => {
  assert.equal(makesOutboundCall("const label = 'fetch'"), false)
  assert.equal(makesOutboundCall('interface Deps { queue: Queue }'), false)
})

test('a comment quoting a call is prose about a call', () => {
  // Otherwise this guard's own source, and two sibling scripts documenting `void fetch(...)`, read
  // as vendor integrations.
  assert.equal(makesOutboundCall('// it does not match a bare `fetch(` after `async`'), false)
  assert.equal(makesOutboundCall('/* const res = await fetch(url) */'), false)
  assert.equal(stripComments('a // await fetch(x)\nb').includes('fetch('), true)
})

test('detects a vendor endpoint DECLARED for something else to send to', () => {
  // The second direction, and the one no call-site walk can reach: a Gemini image contract an
  // AGENT calls with its own credential, and a provider base URL an SDK appends a path to. Both
  // are ours to get wrong.
  assert.ok(declaresVendorEndpoint("  endpoint: 'https://generativelanguage.googleapis.com',"))
  assert.ok(
    declaresVendorEndpoint("  servers: [{ url: 'https://generativelanguage.googleapis.com' }],"),
  )
  assert.ok(declaresVendorEndpoint("const FIGMA_API_HOST = 'api.figma.com'"))
  assert.ok(declaresVendorEndpoint("    baseUrl: 'https://api.z.ai/api/anthropic',"))
  assert.deepEqual(
    vendorEndpointHosts("const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'"),
    ['openrouter.ai'],
  )
})

test('ignores a host no vendor page settles: a fixture, a placeholder, or ours', () => {
  // RFC 2606 / RFC 6761 reserve these, which is exactly why the fakes and the deploy templates use
  // them. Requiring the host to be ASSIGNED as an endpoint is what keeps the doc links in error
  // messages and the placeholder copy in the SPA out.
  assert.equal(declaresVendorEndpoint("  baseUrl: 'https://github.test',"), false)
  assert.equal(declaresVendorEndpoint("  endpoint: 'https://api.example.com/v1',"), false)
  assert.equal(declaresVendorEndpoint("  baseUrl: 'http://localhost:8787',"), false)
  assert.equal(declaresVendorEndpoint("  apiBase: 'https://envs.internal',"), false)
  assert.equal(declaresVendorEndpoint("throw new Error('see https://docs.github.com/rest')"), false)
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
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'sdk' }]), [
    "a/: kind 'sdk' with no reason given",
  ])
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'maybe' }]), ["a/: unknown kind 'maybe'"])
  assert.deepEqual(malformedEntries(MAP), [])
})

test('a vendors STRING is malformed, having passed a length check one character at a time', () => {
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'vendor', vendors: 'github' }]), [
    "a/: kind 'vendor' needs a vendors ARRAY, got string",
  ])
  assert.deepEqual(malformedEntries([{ path: 'a/', kind: 'vendor', vendors: ['GitHub Inc'] }]), [
    "a/: 'GitHub Inc' is not a lowercase vendor slug",
  ])
  assert.deepEqual(
    malformedEntries([{ path: 'a/', kind: 'internal', reason: 'r', vendors: ['x'] }]),
    ["a/: kind 'internal' may not list vendors"],
  )
})

test('a duplicated path is reported as the map bug it is, not as a file that vanished', () => {
  // Only one of the two can ever be matched, so the copy surfaced through `unmatchedEntries` as
  // "it has moved or gone" and sent the reader after a file that was right there.
  const dupes = [
    { path: 'a/b.ts', kind: 'vendor', vendors: ['x'] },
    { path: 'a/b.ts', kind: 'internal', reason: 'r' },
  ]
  assert.deepEqual(malformedEntries(dupes), ['a/b.ts: a second entry names the same path'])
  assert.deepEqual(malformedEntries([{ kind: 'internal', reason: 'r' }]), [
    '{"kind":"internal","reason":"r"}: entry with no path',
  ])
})

test('the swept vendor list is deduplicated, and counts only what is SWEPT', () => {
  assert.deepEqual(sweptVendors(MAP), ['github', 'gitlab'])
  assert.deepEqual(
    sweptVendors([{ path: 'a/', kind: 'sdk', reason: 'the AI SDK owns the wire' }]),
    [],
  )
})

test('a declared host no listed vendor accounts for is the absorption bug, stated', () => {
  // What makes a DIRECTORY-wide vendor entry able to fail at all. `modules/tasks/` listed only
  // `jira` while covering the GitHub, GitLab and Linear providers beside it, and an Asana provider
  // dropped in tomorrow would have been verified against Atlassian's documentation.
  const map = [{ path: 'tasks/', kind: 'vendor', vendors: ['jira'] }]
  const sources = { 'tasks/Asana.ts': "const BASE_URL = 'https://app.asana.com/api/1.0'" }
  assert.deepEqual(
    vendorEvidenceGaps(['tasks/Asana.ts'], map, (f) => sources[f]),
    [
      'tasks/Asana.ts: declares app.asana.com, which the entry for tasks/ (jira) does not account for',
    ],
  )
})

test('a vendor token accounts for the host it appears in', () => {
  const map = [{ path: 'search/', kind: 'vendor', vendors: ['brave-search'] }]
  const sources = { 'search/brave.ts': "const BASE_URL = 'https://api.search.brave.com/res/v1'" }
  assert.deepEqual(
    vendorEvidenceGaps(['search/brave.ts'], map, (f) => sources[f]),
    [],
  )
})

test('a file that declares no host has to at least NAME the vendor it is filed under', () => {
  // This is what catches a typo minting a vendor nothing reaches: `githbu` would otherwise be
  // advertised on the success line as a 35th swept vendor and reconciled against nothing.
  const map = [{ path: 'a/', kind: 'vendor', vendors: ['githbu'] }]
  const sources = { 'a/client.ts': 'export const call = (p) => safeFetch(`${base}${p}`)' }
  assert.deepEqual(
    vendorEvidenceGaps(['a/client.ts'], map, (f) => sources[f]),
    ['a/client.ts: covered by the githbu entry for a/ but names none of them'],
  )
})

test('`evidence` waives the content check, and costs a sentence saying why', () => {
  // The honest escape hatch: a Jira site and a self-hosted GitLab arrive entirely from config, so
  // a file can reach a vendor while naming neither it nor a host.
  const map = [
    { path: 'a/', kind: 'vendor', vendors: ['jira'], evidence: 'the /rest/api/3 path is Jira own' },
  ]
  const sources = { 'a/client.ts': "const p = '/rest/api/3/search/jql'" }
  assert.deepEqual(
    vendorEvidenceGaps(['a/client.ts'], map, (f) => sources[f]),
    [],
  )
})
