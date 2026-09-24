// Fixtures for the font-size-literal ban (issue #2248). Run with `node --test scripts/` — the
// built-in runner, so CI's guards job stays install-free.
//
// The cases that matter are the boundaries. `text-[...]` is a shape SHARED with arbitrary colours
// and with utilities that merely end in `text-`, and the neighbouring guard
// (`check-frontend-palette.mjs`) owns colour. A blind `text-[` scan would claim `text-[#f59e0b]`
// from it and report the same line twice, and would flag `leading-[18px]`, which #2248 left alone.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findTypeLiterals } from './check-frontend-type-scale.mjs'

describe('findTypeLiterals', () => {
  it('flags every px literal the migration removed', () => {
    assert.deepEqual(findTypeLiterals('class="text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(findTypeLiterals('class="text-[10px]"'), ['text-[10px]'])
    assert.deepEqual(findTypeLiterals('class="text-[9px]"'), ['text-[9px]'])
    assert.deepEqual(findTypeLiterals('class="text-[12.5px]"'), ['text-[12.5px]'])
  })

  it('flags the rem, em and pt forms, which scale but are still unnameable', () => {
    assert.deepEqual(findTypeLiterals('class="text-[0.6875rem]"'), ['text-[0.6875rem]'])
    assert.deepEqual(findTypeLiterals('class="text-[.75em]"'), ['text-[.75em]'])
    assert.deepEqual(findTypeLiterals('class="text-[9pt]"'), ['text-[9pt]'])
  })

  it('flags a literal behind a variant, and deduplicates within a line', () => {
    assert.deepEqual(findTypeLiterals('class="sm:text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(findTypeLiterals('class="hover:text-[11px] text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(findTypeLiterals('class="text-[11px] text-[13px]"'), [
      'text-[11px]',
      'text-[13px]',
    ])
  })

  it('flags a literal in a bound class expression, not only a static attribute', () => {
    assert.deepEqual(findTypeLiterals(`:class="compact ? 'text-[9px]' : 'text-2xs'"`), [
      'text-[9px]',
    ])
  })

  it('accepts every named step, including the two the app declares', () => {
    assert.deepEqual(findTypeLiterals('class="text-3xs text-2xs text-xs text-sm text-base"'), [])
    assert.deepEqual(findTypeLiterals('class="text-2xs font-semibold uppercase text-dimmed"'), [])
  })

  it('leaves arbitrary COLOUR to the palette guard, so one line is never reported twice', () => {
    assert.deepEqual(findTypeLiterals('class="text-[#f59e0b]"'), [])
    assert.deepEqual(findTypeLiterals('class="text-[var(--app-hue-pink)]"'), [])
    assert.deepEqual(findTypeLiterals('class="text-[rgb(30_41_59)]"'), [])
  })

  it('leaves every non-font-size arbitrary value alone', () => {
    assert.deepEqual(findTypeLiterals('class="leading-[18px]"'), [])
    assert.deepEqual(findTypeLiterals('class="w-[420px] max-w-[60ch] gap-[3px]"'), [])
    assert.deepEqual(findTypeLiterals('class="tracking-[0.12em]"'), [])
  })

  it('needs a left boundary, so a utility merely ending in `text-` is not a match', () => {
    assert.deepEqual(findTypeLiterals('class="placeholder-text-[11px]"'), [])
    assert.deepEqual(findTypeLiterals('class="mytext-[11px]"'), [])
  })

  it('reads code, not prose: a comment line explaining the rule is clean', () => {
    assert.deepEqual(findTypeLiterals('// `text-[11px]` was the old spelling'), [])
    assert.deepEqual(findTypeLiterals(' * `text-[10px]` folds onto `text-3xs`'), [])
    assert.deepEqual(findTypeLiterals('<!-- was text-[11px] -->'), [])
  })

  it('honours the waiver on the line itself and on the line before it', () => {
    assert.deepEqual(findTypeLiterals('class="text-[11px]" // type-literal-ok: reason'), [])
    assert.deepEqual(findTypeLiterals('class="text-[11px]"', '// type-literal-ok: reason'), [])
    assert.deepEqual(findTypeLiterals('class="text-[11px]"', '// an unrelated comment'), [
      'text-[11px]',
    ])
  })
})
