// Fixtures for the documentation-link guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the hole it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. Two failure modes are worth naming here. The
// slugifier is one: GitHub DROPS punctuation rather than replacing it, so `## Storage & retention`
// is `storage--retention`, and a "tidier" single-hyphen slug would pass every anchor that has no
// punctuation and quietly stop protecting the ones that do. The `DOCS.*` scanner is the other: it
// must read the two argument shapes that exist (a string literal and an `ENV_VARS_ANCHORS`
// constant) and must not silently treat a computed argument as "no anchor", which would report a
// call it never actually checked.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  brokenDocAnchors,
  docsReferences,
  documentAnchors,
  headingSlug,
  linkTargets,
  parseBlobTemplatePaths,
  parseDocsMap,
  parseEnvVarAnchors,
  parseWebsitePages,
  unknownWebsiteLinks,
} from './doc-links.mjs'

test('parses the website page inventory, dropping comments and normalising the leading slash', () => {
  const pages = parseWebsitePages(
    ['# a comment', '', '/', 'guide/budgets.html', '/deploy/local.html  # trailing note', ''].join(
      '\n',
    ),
  )
  assert.deepEqual([...pages].sort(), ['', 'deploy/local.html', 'guide/budgets.html'])
})

test('flags a website link whose page is not recorded, and passes one that is', () => {
  const pages = parseWebsitePages('guide/budgets.html\ndeploy/configuration.html\n')
  const md = [
    'Recorded: [budgets](https://www.catfactory.ai/guide/budgets.html).',
    'Recorded with an anchor: [auth](https://www.catfactory.ai/deploy/configuration.html#authentication).',
    'Not recorded: [sdks](https://www.catfactory.ai/extend/sdks.html)',
    'A non-www host is checked too: [x](https://catfactory.ai/operate/observability.html)',
    'Someone else entirely: [mcp](https://modelcontextprotocol.io).',
  ].join('\n')
  assert.deepEqual(unknownWebsiteLinks(md, pages), [
    'https://www.catfactory.ai/extend/sdks.html',
    'https://catfactory.ai/operate/observability.html',
  ])
})

test('slugifies a heading the way GitHub does, dropping punctuation rather than replacing it', () => {
  // The four `ENV_VARS_ANCHORS` slugs that carry punctuation, against their real headings.
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
    '# Not a heading: a shell comment.',
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
    'const REPO_DOC_BLOB_BASE = `https://github.com/kibertoad/cat-factory/blob/main`',
    'export const VCS_DOC_URLS = {',
    '  vcsProviders: `${REPO_DOC_BLOB_BASE}/backend/docs/vcs-providers.md`,',
    '} as const',
  ].join('\n')
  assert.deepEqual(parseBlobTemplatePaths(source), ['backend/docs/vcs-providers.md'])
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
  const readDoc = (path) => docs[path] ?? null
  const broken = brokenDocAnchors(
    [
      {
        path: 'backend/docs/vcs-providers.md',
        anchor: 'setup',
        call: "DOCS.vcsProviders('setup')",
      },
      { path: 'backend/docs/vcs-providers.md', anchor: 'feature-parity', call: 'b' },
      { path: 'backend/docs/gone.md', anchor: null, call: 'c' },
    ],
    readDoc,
  )
  assert.deepEqual(
    broken.map(({ call, reason }) => [call, reason]),
    [
      ['b', 'no heading slugs to #feature-parity'],
      ['c', 'no such document in the repo'],
    ],
  )
})

test('reads inline links and reference definitions, ignoring prose', () => {
  const md = [
    'See [the guide](https://www.catfactory.ai/guide/budgets.html).',
    '',
    '[ref]: https://www.catfactory.ai/deploy/local.html',
    '',
    'A bare https://www.catfactory.ai/extend/sdks.html in prose is not a link.',
  ].join('\n')
  assert.deepEqual(linkTargets(md), [
    'https://www.catfactory.ai/guide/budgets.html',
    'https://www.catfactory.ai/deploy/local.html',
  ])
})
