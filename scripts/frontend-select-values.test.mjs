// Fixtures for the empty select value ban (issue #2393). Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.
//
// The boundary that matters is the item shape: `value: ''` is also how a form row starts blank,
// and that row is not a select item and must not be flagged.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findEmptySelectValues } from './check-frontend-select-values.mjs'

/** The 1-based lines flagged in a source fragment, read as `file`. */
const lines = (source, file) => findEmptySelectValues(source, file).map((hit) => hit.line)

describe('findEmptySelectValues', () => {
  it('flags the one-line item the seven selects used, in either key order', () => {
    assert.deepEqual(lines("  { label: t('x.inherit'), value: '' },"), [1])
    assert.deepEqual(lines("  { value: '', label: t('x.default') },"), [1])
    assert.deepEqual(lines('  { label, value: "" },'), [1])
    assert.deepEqual(lines('  { label: x, value: `` },'), [1])
  })

  it('flags an item the formatter broke across lines, on its value line', () => {
    const source = [
      'const items = [',
      '  {',
      "    label: t('x.none'),",
      "    value: '',",
      '  },',
      ']',
    ]
    assert.deepEqual(lines(source.join('\n')), [4])
  })

  it('flags an item whose label or neighbours carry braces of their own', () => {
    assert.deepEqual(lines("  { label: t('x.count', { n: 2 }), value: '' },"), [1])
    assert.deepEqual(lines('  { label: `${prefix} none`, value: "" },'), [1])
    assert.deepEqual(
      lines("  { label: t('x.none'), icon: 'i-x', ui: { base: 'a' }, value: '' },"),
      [1],
    )
  })

  it('flags an item inline in a template binding', () => {
    const source = `<template>\n  <USelect :items="[{ label: 'None', value: '' }]" />\n</template>`
    assert.deepEqual(lines(source, 'Example.vue'), [2])
  })

  it('reads the script of a .vue file past template prose with an apostrophe', () => {
    const source = [
      '<template>',
      "  <p>Don't pick a module.</p>",
      '</template>',
      '<script setup lang="ts">',
      "const items = [{ label: t('x.none'), value: '' }]",
      '</script>',
    ]
    assert.deepEqual(lines(source.join('\n'), 'Example.vue'), [5])
  })

  it('leaves an item with a real value alone', () => {
    assert.deepEqual(lines("  { label: t('x.none'), value: SELECT_NONE },"), [])
    assert.deepEqual(lines("  { label: t('x.oneHour'), value: '1h' },"), [])
    assert.deepEqual(lines("  selectNoneItem(t('x.inherit')),"), [])
  })

  it('leaves a form row with an empty value and no label key alone', () => {
    assert.deepEqual(lines("const blankRow = () => ({ key: '', description: '', value: '' })"), [])
    assert.deepEqual(lines("rows.push({ subLabel: 'x', value: '' })"), [])
    // `label` as a VALUE, not a key.
    assert.deepEqual(lines("rows.push({ text: label, value: '' })"), [])
    // The label belongs to a nested object, not to the one holding the empty value.
    assert.deepEqual(lines("rows.push({ meta: { label: 'x' }, value: '' })"), [])
  })

  it('leaves a type literal alone', () => {
    assert.deepEqual(lines("type Row = { label: string; value: '' | 'a' }"), [])
    assert.deepEqual(lines("type Row = { label: string, value: '' | 'a' }"), [])
    assert.deepEqual(lines("type Row = { label: string; value: '' }"), [])
  })

  it('does not read a comment about the rule as an offence', () => {
    assert.deepEqual(lines("// An item like { label: 'x', value: '' } throws in Reka."), [])
    assert.deepEqual(lines("/* { label: 'x', value: '' } */"), [])
  })

  it('honours the waiver on the value line or the line before it', () => {
    assert.deepEqual(lines("{ label: 'x', value: '' } // select-empty-value-ok: a radio group"), [])
    const source = ['// select-empty-value-ok: feeds a URadioGroup', "{ label: 'x', value: '' }"]
    assert.deepEqual(lines(source.join('\n')), [])
  })
})
