// Fixtures for the repo-relative link guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the hole it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. This one has two opposite failure modes and
// both have real precedent in this repository:
//
//   too eager   reading a PowerShell `[Net.ServicePointManager]::SecurityProtocol` line inside a
//               fence as a reference definition fails a document nobody can fix, which is how a
//               guard gets deleted rather than obeyed.
//   too lax     missing a `../` one level short, or a heading that was renumbered, protects
//               nothing: those are exactly the twelve links that were live when this was written.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { brokenLinks, isFrozenHistory, repoLinks, stripFences } from './doc-links.mjs'

test('resolves a relative target against the document, not the repo root', () => {
  const links = repoLinks('[a](./sibling.md) and [b](../other/thing.md)', 'backend/docs/a.md')
  assert.deepEqual(
    links.map((l) => l.path),
    ['backend/docs/sibling.md', 'backend/other/thing.md'],
  )
})

test('keeps a same-document anchor, pointed at the document itself', () => {
  // `public-api.md` linked its own `#scopes` after the section had been renumbered, and nothing
  // saw it, because a bare fragment looks like the one link that cannot be wrong.
  const [link] = repoLinks('see [Scopes](#scopes) below', 'backend/docs/public-api.md')
  assert.equal(link.path, 'backend/docs/public-api.md')
  assert.equal(link.anchor, 'scopes')
})

test('splits an anchor off a path, and tolerates a query', () => {
  const links = repoLinks('[a](./x.md#some-heading) [b](./y.md?plain=1)', 'docs/a.md')
  assert.deepEqual(links, [
    { target: './x.md#some-heading', path: 'docs/x.md', anchor: 'some-heading' },
    { target: './y.md?plain=1', path: 'docs/y.md', anchor: null },
  ])
})

test('leaves alone what is not an in-repo link', () => {
  const md = [
    '[abs](https://github.com/kibertoad/cat-factory/blob/main/README.md)',
    '[site](https://www.catfactory.ai/extend/manifests.html)',
    '[route](/api/v1/runs)',
    '[mail](mailto:someone@example.com)',
    '[proto](//cdn.example.com/x.png)',
  ].join('\n')
  assert.deepEqual(repoLinks(md, 'docs/a.md'), [])
})

test('a link inside a fence is an illustration, not a link', () => {
  const md = [
    'Real: [a](./real.md)',
    '',
    '```md',
    '[example](./does-not-exist.md)',
    '```',
    '',
    '```powershell',
    "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'",
    '```',
  ].join('\n')
  assert.deepEqual(
    repoLinks(md, 'docs/a.md').map((l) => l.path),
    ['docs/real.md'],
  )
})

test('stripFences keeps the line count so a reported position still lands', () => {
  const md = ['a', '```', 'b', '```', 'c'].join('\n')
  assert.equal(stripFences(md).split('\n').length, 5)
})

test('a tilde fence does not close a backtick fence', () => {
  const md = ['```', '~~~', '[inner](./nope.md)', '```', '[outer](./yes.md)'].join('\n')
  assert.deepEqual(
    repoLinks(md, 'docs/a.md').map((l) => l.path),
    ['docs/yes.md'],
  )
})

test('reports the three failures separately, because they are three different edits', () => {
  const tree = {
    'docs/there.md': '# Title\n\n## A heading\n',
    'docs/dir': null, // a directory
  }
  const lookup = (p) => (p in tree ? (tree[p] === null ? 'dir' : 'file') : null)
  const readDoc = (p) => tree[p]

  const broken = brokenLinks(
    [
      { target: './gone.md', path: 'docs/gone.md', anchor: null },
      { target: './dir#x', path: 'docs/dir', anchor: 'x' },
      { target: './there.md#missing', path: 'docs/there.md', anchor: 'missing' },
      { target: './there.md#a-heading', path: 'docs/there.md', anchor: 'a-heading' },
    ],
    lookup,
    readDoc,
  )
  assert.deepEqual(
    broken.map((b) => [b.target, b.reason]),
    [
      ['./gone.md', 'no such path in the repo'],
      ['./dir#x', 'a directory cannot carry a heading anchor'],
      ['./there.md#missing', 'no heading slugs to #missing'],
    ],
  )
})

test('a link into a non-markdown file is checked for existence only', () => {
  const lookup = (p) => (p === 'src/routing.ts' ? 'file' : null)
  const broken = brokenLinks(
    [{ target: './routing.ts#L42', path: 'src/routing.ts', anchor: 'L42' }],
    lookup,
    () => {
      throw new Error('must not read a non-markdown file for anchors')
    },
  )
  assert.deepEqual(broken, [])
})

test('CHANGELOGs are frozen history and nothing else is', () => {
  assert.ok(isFrozenHistory('backend/packages/kernel/CHANGELOG.md'))
  assert.ok(isFrozenHistory('CHANGELOG.md'))
  assert.equal(isFrozenHistory('backend/docs/auth.md'), false)
  assert.equal(isFrozenHistory('docs/CHANGELOG-notes.md'), false)
})
