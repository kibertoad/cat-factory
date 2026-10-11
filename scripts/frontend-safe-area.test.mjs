// Fixtures for the hand-written full-screen surface ban. Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findFullScreenFixed, isFullScreenFixed } from './check-frontend-safe-area.mjs'

describe('isFullScreenFixed', () => {
  it('flags `fixed` beside any token that spans a whole side, in any order', () => {
    assert.equal(isFullScreenFixed('class="fixed inset-0 z-50"'), true)
    assert.equal(isFullScreenFixed('class="z-50 inset-0 fixed"'), true)
    assert.equal(isFullScreenFixed('class="fixed inset-y-0 start-0 w-64"'), true)
    assert.equal(isFullScreenFixed('class="fixed inset-x-0 bottom-0"'), true)
    assert.equal(isFullScreenFixed('class="fixed top-0 left-0 h-full w-full"'), true)
    assert.equal(isFullScreenFixed('class="fixed h-dvh"'), true)
  })

  it('flags a pair of opposite edges, which spans the axis between them', () => {
    assert.equal(isFullScreenFixed('class="fixed top-0 bottom-0 end-0"'), true)
    assert.equal(isFullScreenFixed('class="fixed start-0 end-0 top-4"'), true)
  })

  it('reads through variant prefixes, the important marker, and a class list in a constant', () => {
    assert.equal(isFullScreenFixed('class="max-lg:fixed max-lg:inset-0"'), true)
    assert.equal(isFullScreenFixed('class="!fixed !inset-0"'), true)
    assert.equal(isFullScreenFixed(`const ROOT = 'fixed inset-0 bg-app-950'`), true)
    assert.equal(isFullScreenFixed(`  ['fixed', 'inset-0'],`), true)
  })

  it('leaves a fixed surface that spans no side, and a full-size one that is not fixed', () => {
    assert.equal(isFullScreenFixed('class="fixed end-4 bottom-20 w-80"'), false)
    assert.equal(isFullScreenFixed('class="fixed top-0 end-0"'), false)
    assert.equal(isFullScreenFixed('class="absolute inset-0"'), false)
    assert.equal(isFullScreenFixed('class="h-full w-full"'), false)
    assert.equal(isFullScreenFixed('class="table-fixed w-full"'), false)
    assert.equal(isFullScreenFixed('class="bg-fixed h-screen"'), false)
  })
})

describe('findFullScreenFixed', () => {
  it('reports the line, and reads no comment as an application', () => {
    assert.deepEqual(findFullScreenFixed('<div\n  class="fixed inset-0"\n>'), [2])
    assert.deepEqual(findFullScreenFixed('// a fixed inset-0 root is banned\nx'), [])
    assert.deepEqual(findFullScreenFixed('<!-- fixed inset-0 -->\n<p>'), [])
  })

  it('takes a waiver on the line or the line above it', () => {
    assert.deepEqual(findFullScreenFixed(`const S = 'fixed inset-0' // safe-area-ok: a scrim`), [])
    assert.deepEqual(findFullScreenFixed(`// safe-area-ok: a scrim\nconst S = 'fixed inset-0'`), [])
  })

  it('takes a waiver above a wrapped tag, where no comment can sit beside the class', () => {
    const tag = [
      '<!-- safe-area-ok: a scrim -->',
      '<div',
      '  v-if="open"',
      '  class="fixed inset-0"',
      '/>',
    ]
    assert.deepEqual(findFullScreenFixed(tag.join('\n')), [])
  })

  it('does not let a waiver above one tag cover the next tag', () => {
    const tags = [
      '<!-- safe-area-ok: a scrim -->',
      '<div v-if="open" />',
      '<aside',
      '  class="fixed inset-y-0 start-0"',
      '>',
    ]
    assert.deepEqual(findFullScreenFixed(tags.join('\n')), [4])
  })

  it('does not end a tag at a `>` inside a quoted attribute value', () => {
    const tag = [
      '<!-- safe-area-ok: a scrim -->',
      '<div',
      '  v-if="count > 1"',
      '  class="fixed inset-0"',
      '/>',
    ]
    assert.deepEqual(findFullScreenFixed(tag.join('\n')), [])
  })
})
