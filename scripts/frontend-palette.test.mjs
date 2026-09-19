// Fixtures for the raw-palette ban (issue #2239). Run with `node --test scripts/` — the built-in
// runner, so CI's guards job stays install-free.
//
// The cases that matter are the false friends: a blind `slate`/`indigo` substring scan would flag
// the word "translated", the `neutral: 'slate'` alias value, and a comment that names a shade, none
// of which are utility classes. The guard must flag only real color utilities and must accept the
// aliases that replaced them.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findRawPalette } from './check-frontend-palette.mjs'

describe('findRawPalette', () => {
  it('flags raw slate/indigo utilities, including variants and opacity', () => {
    assert.deepEqual(findRawPalette('class="bg-slate-900"'), ['bg-slate-900'])
    assert.deepEqual(findRawPalette('class="text-indigo-400"'), ['text-indigo-400'])
    assert.deepEqual(findRawPalette('class="border-slate-800"'), ['border-slate-800'])
    assert.deepEqual(findRawPalette('class="hover:bg-slate-950/40"'), ['bg-slate-950/40'])
    assert.deepEqual(findRawPalette('class="divide-slate-800 ring-indigo-500"'), [
      'divide-slate-800',
      'ring-indigo-500',
    ])
  })

  it('deduplicates repeated hits on one line', () => {
    assert.deepEqual(findRawPalette('a bg-slate-900 b bg-slate-900'), ['bg-slate-900'])
  })

  it('accepts the theme aliases that replaced the raw classes', () => {
    assert.deepEqual(
      findRawPalette('class="bg-neutral-950 text-primary-400 border-neutral-800"'),
      [],
    )
  })

  it('ignores the false friends a substring scan would trip on', () => {
    assert.deepEqual(findRawPalette('  -translate-x-1/2 -translate-y-1/2'), [])
    assert.deepEqual(findRawPalette("      neutral: 'slate',"), [])
    assert.deepEqual(findRawPalette("      primary: 'indigo',"), [])
    assert.deepEqual(findRawPalette('// a deep slate-950 surface so the slate-900 panels pop'), [])
    assert.deepEqual(findRawPalette(' * translated ten times, never re-worded'), [])
  })

  it('ignores an out-of-range shade (not a real Tailwind step)', () => {
    assert.deepEqual(findRawPalette('class="bg-slate-1000"'), [])
  })

  it('requires a left boundary so an identifier substring is not a false positive', () => {
    // Without the boundary these matched on `accent-indigo-400` / `bg-slate-900` and failed CI.
    assert.deepEqual(findRawPalette('myaccent-indigo-400'), [])
    assert.deepEqual(findRawPalette('xbg-slate-900'), [])
    assert.deepEqual(findRawPalette('data-bg-slate-900'), [])
    // A real variant prefix still matches (the char before the utility is `:`, not word/dash).
    assert.deepEqual(findRawPalette('class="hover:bg-slate-900"'), ['bg-slate-900'])
  })
})
