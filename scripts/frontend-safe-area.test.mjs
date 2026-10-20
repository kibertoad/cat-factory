// Fixtures for the hand-written full-screen surface ban. Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLASS_OWNERS,
  findForeignClassUse,
  findFullScreenFixed,
  isFullScreenFixed,
} from './check-frontend-safe-area.mjs'

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

describe('findForeignClassUse', () => {
  const panel = 'frontend/app/app/components/panels/SomePanel.vue'
  const bind = (name) => `import { ${name} } from '~/utils/safeArea'\n<div :class="${name}" />`

  it('lets each owning shell name its own class list', () => {
    for (const [name, owner] of Object.entries(CLASS_OWNERS)) {
      assert.deepEqual(findForeignClassUse(bind(name), owner), [])
    }
  })

  it('flags a class list named outside its shell, the other shell included', () => {
    assert.deepEqual(findForeignClassUse(bind('FULL_BLEED_TAKEOVER_CLASS'), panel), [
      { line: 1, name: 'FULL_BLEED_TAKEOVER_CLASS' },
      { line: 2, name: 'FULL_BLEED_TAKEOVER_CLASS' },
    ])
    const otherShell = CLASS_OWNERS.WINDOWED_OVERLAY_CLASS
    assert.deepEqual(findForeignClassUse(bind('FULL_BLEED_TAKEOVER_CLASS'), otherShell).length, 2)
  })

  it('reads no comment as a use, and leaves the definitions and the specs alone', () => {
    assert.deepEqual(findForeignClassUse('// binds FULL_BLEED_TAKEOVER_CLASS\nx', panel), [])
    assert.deepEqual(findForeignClassUse('<!-- WINDOWED_OVERLAY_CLASS -->\n<p>', panel), [])
    const defs = 'export const FULL_BLEED_TAKEOVER_CLASS = []'
    assert.deepEqual(findForeignClassUse(defs, 'frontend/app/app/utils/safeArea.ts'), [])
    assert.deepEqual(findForeignClassUse(defs, 'frontend/app/app/utils/safeArea.spec.ts'), [])
  })

  it('matches the whole name only', () => {
    assert.deepEqual(findForeignClassUse('const MY_FULL_BLEED_TAKEOVER_CLASS_X = 1', panel), [])
  })
})
