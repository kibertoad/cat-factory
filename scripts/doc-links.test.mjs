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
  websiteTemplatePaths,
} from './doc-links.mjs'

test('parses the website page inventory, dropping comments and normalising the leading slash', () => {
  const pages = parseWebsitePages(
    ['# a comment', '', '/', 'guide/budgets.html', '/deploy/local.html  # trailing note', ''].join(
      '\n',
    ),
  )
  assert.deepEqual([...pages].sort(), ['', 'deploy/local.html', 'guide/budgets.html'])
})

test('flags a website URL whose page is not recorded, in markdown and in source alike', () => {
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

test('reads a URL out of source, not only out of markdown link syntax', () => {
  const pages = parseWebsitePages('guide/budgets.html\n')
  assert.deepEqual(
    unknownWebsiteLinks("const b = 'https://www.catfactory.ai/guide/budgets.html'", pages),
    [],
  )
  assert.deepEqual(
    unknownWebsiteLinks("const x = 'https://www.catfactory.ai/extend/gone.html'", pages),
    ['https://www.catfactory.ai/extend/gone.html'],
  )
})

test('resolves a path composed onto a site-base constant, which raw scanning cannot see', () => {
  // The shape `config/docs.ts` actually uses. Scanned raw, the origin and the interpolated tail are
  // two unrelated strings and NEITHER is checked, so the guard would report green over the one
  // place a dead link reaches an operator mid-failure. This is the assertion that closes that.
  const source = [
    "const SITE_BASE = 'https://www.catfactory.ai'",
    'export const SITE_DOCS = {',
    '  vcsSetup: `${SITE_BASE}/reference/vcs-support-matrix.html#setting-each-one-up`,',
    '  gone: `${SITE_BASE}/extend/gone.html`,',
    '} as const',
  ].join('\n')
  assert.deepEqual(websiteTemplatePaths(source), [
    'reference/vcs-support-matrix.html#setting-each-one-up',
    'extend/gone.html',
  ])
  // The base constant's NAME is read from the file, so a second module picking its own is covered.
  const renamed = [
    "const DOCS_SITE = 'https://catfactory.ai'",
    'a: `${DOCS_SITE}/guide/skills.html`,',
  ].join('\n')
  assert.deepEqual(websiteTemplatePaths(renamed), ['guide/skills.html'])
  // No base constant means nothing to compose: never guess a bare interpolation is a site URL.
  assert.deepEqual(websiteTemplatePaths('x: `${OTHER}/guide/skills.html`,'), [])
})

test('trims prose punctuation that ran into a URL, and stops at markdown and quote delimiters', () => {
  const pages = parseWebsitePages('guide/budgets.html\n')
  for (const text of [
    'See https://www.catfactory.ai/guide/budgets.html.',
    'See https://www.catfactory.ai/guide/budgets.html, then stop.',
    '[b](https://www.catfactory.ai/guide/budgets.html)',
    "'https://www.catfactory.ai/guide/budgets.html'",
    '`https://www.catfactory.ai/guide/budgets.html`',
  ]) {
    assert.deepEqual(unknownWebsiteLinks(text, pages), [], text)
  }
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

test('reads inline links and reference definitions for the anchor extractor', () => {
  const md = [
    'See [the guide](./guide.md) and [the ADR](../adr/0031.md).',
    '',
    '[ref]: ./sibling.md',
    '',
    'A bare path like ./not-a-link.md in prose is not one.',
  ].join('\n')
  assert.deepEqual(linkTargets(md), ['./guide.md', '../adr/0031.md', './sibling.md'])
})
