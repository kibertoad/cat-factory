// Fixtures for the named-modal-width guard (issue #2251). Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.
//
// The boundary is NAMED versus PICKED: an `AppModal` names the kind of content and takes its width
// from that; a raw `UModal` or `USlideover`, or an `AppModal` carrying its own `max-w-*`, picks one.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WRAPPER, findOverlayOffenders } from './check-frontend-geometry.mjs'

const FILE = 'frontend/app/app/components/x/Some.vue'
const tpl = (body) =>
  `<script setup lang="ts">\nconst a = 1\n</script>\n\n<template>\n${body}\n</template>\n`
const found = (body, rel = FILE) =>
  findOverlayOffenders(tpl(body), rel).map((o) => `${o.line} ${o.message.split(':')[0]}`)

describe('findOverlayOffenders', () => {
  it('accepts an AppModal at each named size', () => {
    assert.deepEqual(found('  <AppModal size="prompt" v-model:open="open" title="T" />'), [])
    assert.deepEqual(found('  <AppModal size="wide" v-model:open="open" title="T" />'), [])
    assert.deepEqual(
      found('  <AppModal\n    size="form"\n    :ui="{ body: \'p-0\' }"\n  >\n  </AppModal>'),
      [],
    )
  })

  it('flags a raw UModal or USlideover in either casing, wherever its attributes wrap', () => {
    assert.deepEqual(found('  <UModal v-model:open="open">\n  </UModal>'), ['6 raw <UModal>'])
    assert.deepEqual(found('  <u-modal v-model:open="open"></u-modal>'), ['6 raw <UModal>'])
    assert.deepEqual(
      found('  <USlideover\n    side="left"\n    :ui="{ content: \'max-w-md\' }"\n  />'),
      ['6 raw <USlideover>'],
    )
  })

  it('flags an AppModal that names its own width, in ui or in class', () => {
    assert.deepEqual(found('  <AppModal size="form" :ui="{ content: \'max-w-3xl\' }" />'), [
      '6 <AppModal> with max-w-3xl',
    ])
    assert.deepEqual(
      found('  <AppModal\n    size="prompt"\n    :ui="{ content: \'sm:max-w-[90vw]\' }"\n  />'),
      ['6 <AppModal> with max-w-[90vw]'],
    )
    assert.deepEqual(found('  <AppModal size="prompt" class="max-w-sm" />'), [
      '6 <AppModal> with max-w-sm',
    ])
    assert.deepEqual(found('  <AppModal size="form" class="sm:w-[900px]" />'), [
      '6 <AppModal> with w-[900px]',
    ])
    assert.deepEqual(found('  <AppModal size="form" :ui="{ content: \'min-w-3xl\' }" />'), [
      '6 <AppModal> with min-w-3xl',
    ])
    // Another content class (a z-index above a stacked modal) is not a width.
    assert.deepEqual(found('  <AppModal size="prompt" :ui="{ content: \'z-[70]\' }" />'), [])
  })

  it('refuses an AppModal whose classes the guard cannot read', () => {
    assert.deepEqual(found('  <AppModal size="form" :ui="wideUi" />'), ['6 <AppModal> binds '])
    assert.deepEqual(found('  <AppModal size="form" v-bind="modalProps" />'), [
      '6 <AppModal> spreads v-bind',
    ])
    // A `v-model:` or `v-bind:` on another prop is not a spread.
    assert.deepEqual(found('  <AppModal size="form" v-model:open="open" v-bind:title="t" />'), [])
  })

  it('exempts an always-fullscreen modal and nothing that merely mentions the word', () => {
    assert.deepEqual(found('  <UModal v-model:open="open" fullscreen title="T" />'), [])
    assert.deepEqual(found('  <UModal :fullscreen="true" title="T" />'), [])
    assert.deepEqual(found('  <UModal title="Not fullscreen" />'), ['6 raw <UModal>'])
  })

  it('does not exempt a modal that is fullscreen only sometimes', () => {
    // Centered at every size where `isPhone` is false, so it needs a named width.
    assert.deepEqual(found('  <UModal :fullscreen="isPhone" title="T" />'), ['6 raw <UModal>'])
    assert.deepEqual(found('  <UModal :fullscreen="false" title="T" />'), ['6 raw <UModal>'])
  })

  it('names a waiver above a fullscreen modal as needless, not as stale', () => {
    assert.deepEqual(found('  <!-- workbench-width-ok: a grid. -->\n  <UModal fullscreen />'), [
      '7 workbench-width-ok',
    ])
  })

  it('exempts the wrapper', () => {
    assert.deepEqual(found('  <UModal v-bind="$attrs" :ui="ui" />', WRAPPER), [])
  })

  it('accepts a workbench waiver with a reason, on one line or wrapped, directly above the tag', () => {
    assert.deepEqual(
      found(
        '  <!-- workbench-width-ok: a sandbox grid, waits on #2359. -->\n' +
          '  <UModal :ui="{ content: \'max-w-5xl\' }" />',
      ),
      [],
    )
    assert.deepEqual(
      found(
        '  <!-- workbench-width-ok: the pipeline builder, up to 1152px. Its shell\n' +
          '       waits on #2359. -->\n' +
          '  <USlideover\n    side="left"\n  />',
      ),
      [],
    )
  })

  it('refuses a waiver with no reason, one that is not directly above, and one on an AppModal', () => {
    assert.deepEqual(found('  <!-- workbench-width-ok: -->\n  <UModal />'), [
      '7 workbench-width-ok',
    ])
    // A blank line between the waiver and the tag: the waiver is stale and the tag is raw.
    assert.deepEqual(found('  <!-- workbench-width-ok: a grid. -->\n\n  <UModal />'), [
      '6 stale workbench-width-ok',
      '8 raw <UModal>',
    ])
    // A converted surface that kept its waiver.
    assert.deepEqual(found('  <!-- workbench-width-ok: a grid. -->\n  <AppModal size="form" />'), [
      '6 stale workbench-width-ok',
    ])
  })

  it('reads the template only, so a script or a comment naming a UModal is not an overlay', () => {
    const source =
      '<script setup lang="ts">\n// wraps a <UModal> for the board, workbench-width-ok: no\n' +
      'const tag = "<UModal>"\n</script>\n\n' +
      '<template>\n  <!-- not a <UModal>, an AppModal -->\n  <AppModal size="prompt" />\n</template>\n'
    assert.deepEqual(findOverlayOffenders(source, FILE), [])
  })
})
