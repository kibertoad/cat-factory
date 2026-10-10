// Fixtures for the release-version guard's detection. Run by `node --test 'scripts/*.test.mjs'`.
//
// A guard is the only thing stopping the drift it watches from reopening, so a silent regression in
// ITS logic disarms it while still reporting green. This one is exposed to that in the usual way:
// its healthy answer is an EMPTY list, which is also what every broken filter returns. The tests
// below pin the filters that must NOT drop a package as much as the ones that must.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { changedVersions, collisions, formatCollisions } from './release-versions.mjs'

const pkg = (name, version, extra = {}) => ({ name, version, ...extra })

test('reads a bumped version, and ignores an unchanged one', () => {
  const changed = changedVersions([
    { path: 'a/package.json', head: pkg('@scope/a', '1.0.0'), base: pkg('@scope/a', '0.9.0') },
    { path: 'b/package.json', head: pkg('@scope/b', '0.9.0'), base: pkg('@scope/b', '0.9.0') },
  ])
  assert.deepEqual(changed, [{ name: '@scope/a', version: '1.0.0', path: 'a/package.json' }])
})

test('counts a package the branch ADDS', () => {
  // A new folder at the scaffold's default version is how a name gets published onto a number
  // someone else already used, so an absent base is a change, not a skip.
  const changed = changedVersions([
    { path: 'new/package.json', head: pkg('@scope/new', '1.0.0'), base: null },
  ])
  assert.deepEqual(changed, [{ name: '@scope/new', version: '1.0.0', path: 'new/package.json' }])
})

test('skips private packages, which never reach the registry', () => {
  const changed = changedVersions([
    {
      path: 'p/package.json',
      head: pkg('@scope/p', '1.0.0', { private: true }),
      base: pkg('@scope/p', '0.9.0'),
    },
  ])
  assert.deepEqual(changed, [])
})

test('skips a DELETED package.json rather than throwing on the null head', () => {
  const changed = changedVersions([
    { path: 'gone/package.json', head: null, base: pkg('@scope/gone', '1.0.0') },
  ])
  assert.deepEqual(changed, [])
})

test('skips a package.json with no name or no version', () => {
  // The repo root's own package.json is private, but a nameless or versionless manifest anywhere
  // must drop out rather than be looked up as `undefined` on the registry.
  const changed = changedVersions([
    { path: 'x/package.json', head: { version: '1.0.0' }, base: null },
    { path: 'y/package.json', head: { name: '@scope/y' }, base: null },
  ])
  assert.deepEqual(changed, [])
})

test('flags only the versions the registry already holds', () => {
  const changed = [
    { name: '@scope/taken', version: '1.0.0', path: 'taken/package.json' },
    { name: '@scope/free', version: '1.0.0', path: 'free/package.json' },
  ]
  const published = new Map([
    ['@scope/taken', ['0.9.0', '1.0.0']],
    ['@scope/free', ['0.9.0']],
  ])
  assert.deepEqual(collisions(changed, published), [changed[0]])
})

test('a name the registry has never seen is free', () => {
  const changed = [{ name: '@scope/brand-new', version: '1.0.0', path: 'p/package.json' }]
  assert.deepEqual(collisions(changed, new Map()), [])
})

test('reproduces the 2026-08-06 release', () => {
  // The real shape: a first major bump landing on a number a pre-changesets hand-publish had
  // already parked an unbuilt shell on, while everything released beside it pinned that number.
  const changed = changedVersions([
    {
      path: 'backend/packages/prompt-fragments/package.json',
      head: pkg('@cat-factory/prompt-fragments', '1.0.0'),
      base: pkg('@cat-factory/prompt-fragments', '0.16.0'),
    },
    {
      path: 'backend/packages/agents/package.json',
      head: pkg('@cat-factory/agents', '0.115.0'),
      base: pkg('@cat-factory/agents', '0.114.0'),
    },
  ])
  const published = new Map([
    ['@cat-factory/prompt-fragments', ['0.16.0', '1.0.0']],
    ['@cat-factory/agents', ['0.114.0']],
  ])
  const found = collisions(changed, published)
  assert.equal(found.length, 1)
  assert.equal(found[0].name, '@cat-factory/prompt-fragments')
  assert.match(formatCollisions(found), /@cat-factory\/prompt-fragments@1\.0\.0/)
})
