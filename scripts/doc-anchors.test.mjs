// Fixtures for the doc-anchor guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the hole it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. Two failure modes are worth naming. The
// slugifier is one: GitHub DROPS punctuation rather than replacing it, so `## Storage & retention`
// is `storage--retention`, and a "tidier" single-hyphen slug would pass every anchor with no
// punctuation and quietly stop protecting the ones that have it. The `DOCS.*` scanner is the other:
// it must read both argument shapes that exist, and must not treat a COMPUTED argument as "no
// anchor", which would report a call it never actually resolved.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  brokenDocAnchors,
  docsReferences,
  documentAnchors,
  headingSlug,
  parseBlobTemplatePaths,
  parseDirectDocUrlCalls,
  parseDocsMap,
  parseEnvVarAnchors,
} from './doc-anchors.mjs'

test('slugifies a heading the way GitHub does, dropping punctuation rather than replacing it', () => {
  // The `ENV_VARS_ANCHORS` slugs that carry punctuation, against their real headings.
  assert.equal(headingSlug('Core service & networking'), 'core-service--networking')
  assert.equal(headingSlug('Storage & retention'), 'storage--retention')
  assert.equal(headingSlug('VCS integration (GitHub / GitLab)'), 'vcs-integration-github--gitlab')
  assert.equal(headingSlug('Authentication'), 'authentication')
  // A single hyphen here is the regression this test exists to catch.
  assert.notEqual(headingSlug('Storage & retention'), 'storage-retention')
})

test('collects a document’s anchors and ignores headings inside a fenced block', () => {
  const md = [
    '# Top',
    '',
    '## Setup',
    '',
    '```sh',
    '# Not a heading: a comment.',
    '```',
    '',
    '### Deeper section',
  ].join('\n')
  assert.deepEqual([...documentAnchors(md)].sort(), ['deeper-section', 'setup', 'top'])
})

test('reads the DOCS map and the ENV_VARS_ANCHORS constants out of the source', () => {
  const source = [
    'export const DOCS = {',
    "  envVars: (anchor?: string) => repoDocUrl('docs/environment-variables.md', anchor),",
    '  runnerPool: (anchor?: string) =>',
    "    repoDocUrl('backend/docs/runner-pool-integration.md', anchor),",
    '} as const',
    '',
    'export const ENV_VARS_ANCHORS = {',
    "  authentication: 'authentication',",
    "  storageRetention: 'storage--retention',",
    '} as const',
  ].join('\n')
  assert.deepEqual(
    [...parseDocsMap(source)],
    [
      ['envVars', 'docs/environment-variables.md'],
      ['runnerPool', 'backend/docs/runner-pool-integration.md'],
    ],
  )
  assert.deepEqual(
    [...parseEnvVarAnchors(source)],
    [
      ['authentication', 'authentication'],
      ['storageRetention', 'storage--retention'],
    ],
  )
})

test('reads the paths a kernel-side blob template spells out', () => {
  const source = [
    'export const VCS_DOC_URLS = {',
    '  vcsProviders: `${REPO_DOC_BLOB_BASE}/backend/docs/vcs-providers.md`,',
    '} as const',
  ].join('\n')
  assert.deepEqual(parseBlobTemplatePaths(source), ['backend/docs/vcs-providers.md'])
})

test('reads a module that spells its URLs out directly, anchors and all', () => {
  // The agents package keeps its own `repoDocUrl` (it sits below the server layer) and states each
  // anchor at the DEFINITION, so there is no call site to resolve. These are the load-bearing two:
  // a provisioning failure sends an operator to `model-support.md#8-provisioning-per-runtime`.
  const source = [
    "  root: () => repoDocUrl('backend/docs/model-support.md'),",
    "  provisioning: () => repoDocUrl('backend/docs/model-support.md', '8-provisioning-per-runtime'),",
    "  bedrock: () => repoDocUrl('backend/docs/model-support.md', 'aws-bedrock-opt-in'),",
  ].join('\n')
  assert.deepEqual(
    parseDirectDocUrlCalls(source).map(({ path, anchor }) => ({ path, anchor })),
    [
      { path: 'backend/docs/model-support.md', anchor: null },
      { path: 'backend/docs/model-support.md', anchor: '8-provisioning-per-runtime' },
      { path: 'backend/docs/model-support.md', anchor: 'aws-bedrock-opt-in' },
    ],
  )
  // Must NOT claim the server module's parameterised builder: there the anchor comes from the call
  // sites, and reading it as 'no anchor' would report those calls as checked when they never were.
  assert.deepEqual(
    parseDirectDocUrlCalls("repoDocUrl('docs/environment-variables.md', anchor)"),
    [],
  )
})

test('resolves both anchor argument shapes and skips a computed one', () => {
  const docsMap = new Map([
    ['envVars', 'docs/environment-variables.md'],
    ['vcsProviders', 'backend/docs/vcs-providers.md'],
  ])
  const envAnchors = new Map([['authentication', 'authentication']])
  const source = [
    "const a = DOCS.vcsProviders('setup')",
    'const b = DOCS.envVars(ENV_VARS_ANCHORS.authentication)',
    'const c = DOCS.envVars()',
    'const d = DOCS.envVars(pickAnchor(kind))',
    "const e = DOCS.notAKey('nope')",
  ].join('\n')
  assert.deepEqual(
    docsReferences(source, docsMap, envAnchors).map(({ path, anchor }) => ({ path, anchor })),
    [
      { path: 'backend/docs/vcs-providers.md', anchor: 'setup' },
      { path: 'docs/environment-variables.md', anchor: 'authentication' },
      { path: 'docs/environment-variables.md', anchor: null },
    ],
  )
})

test('separates a missing document from a missing heading, and passes a live anchor', () => {
  const docs = { 'backend/docs/vcs-providers.md': '# VCS providers\n\n## Setup\n\nSet it up.\n' }
  const broken = brokenDocAnchors(
    [
      { path: 'backend/docs/vcs-providers.md', anchor: 'setup', call: 'a' },
      { path: 'backend/docs/vcs-providers.md', anchor: 'feature-parity', call: 'b' },
      { path: 'backend/docs/gone.md', anchor: null, call: 'c' },
    ],
    (path) => docs[path] ?? null,
  )
  assert.deepEqual(
    broken.map(({ call, reason }) => [call, reason]),
    [
      ['b', 'no heading slugs to #feature-parity'],
      ['c', 'no such document in the repo'],
    ],
  )
})
