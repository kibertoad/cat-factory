// Fixtures for the shipped-doc link guard's extractors. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the hole it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. The failure mode to fear here is a link
// classifier that is too eager: call an absolute URL "relative" and the guard fails the whole repo
// on its first run and gets deleted; miss `../../..` and it protects nothing.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { escapingLinks, isRelativePath, linkTargets } from './shipped-doc-links.mjs'

test('reads inline links and reference definitions, ignoring plain prose', () => {
  const md = [
    'See [the guide](./guide.md) and [the ADR](../../adr/0031.md).',
    'An angle-bracketed [target](<./has spaces.md>) counts too.',
    '',
    '[ref]: ../../../backend/docs/reusable-operations.md',
    '',
    'A bare path like ./not-a-link.md in prose is not one.',
  ].join('\n')
  assert.deepEqual(linkTargets(md), [
    './guide.md',
    '../../adr/0031.md',
    './has spaces.md',
    '../../../backend/docs/reusable-operations.md',
  ])
})

test('treats only genuine relative paths as resolvable', () => {
  for (const target of ['./guide.md', '../sibling.md', 'guide.md', '../../a/b.md']) {
    assert.ok(isRelativePath(target), target)
  }
  // The over-eager failure mode: each of these must be left alone.
  for (const target of [
    'https://github.com/kibertoad/cat-factory/blob/main/backend/docs/x.md',
    'http://example.com',
    'mailto:someone@example.com',
    '#a-heading',
    '/served/route',
    '//cdn.example.com/x.png',
  ]) {
    assert.ok(!isRelativePath(target), target)
  }
})

test('flags a link that leaves the package root and nothing that stays inside', () => {
  const md = [
    '[inside](./sibling.md)',
    '[also inside](../other//thing.md)',
    '[the root itself](../..)',
    '[escapes](../../../../backend/docs/reusable-operations.md)',
  ].join('\n')
  // The document sits two levels down (`app/docs/x.md`), so the package root is two `..` away.
  assert.deepEqual(escapingLinks(md, 'app/docs', '.'), [
    '../../../../backend/docs/reusable-operations.md',
  ])
})

test('strips a fragment and a query before resolving, so an anchor is not a path segment', () => {
  const md = '[section](../README.md#interface-modes) and [q](../x.md?plain=1)'
  assert.deepEqual(escapingLinks(md, 'app/docs', '.'), [])
  // …and an anchor on an ESCAPING target is still caught rather than hidden by the fragment.
  assert.deepEqual(escapingLinks('[x](../../../a.md#h)', 'app/docs', '.'), ['../../../a.md#h'])
})

test('the exact link that motivated the guard, from the file it was in', () => {
  // `@cat-factory/app` ships `app/`, so `app/docs/consumer-extensions.md` is in the tarball and
  // four levels up is not.
  const md =
    '[`backend/docs/reusable-operations.md`](../../../../backend/docs/reusable-operations.md)'
  assert.equal(escapingLinks(md, 'app/docs', '.').length, 1)
})
