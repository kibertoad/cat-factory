// Fixtures for the font-size-literal ban (issue #2248). Run with `node --test scripts/`: the
// built-in runner, so CI's guards job stays install-free.
//
// The cases that matter are the boundaries. `text-[...]` is a shape SHARED with arbitrary colours
// and with utilities that merely end in `text-`, and the neighbouring guard
// (`check-frontend-palette.mjs`) owns colour. A blind `text-[` scan would claim `text-[#f59e0b]`
// from it and report the same line twice, and would flag `leading-[18px]`, which #2248 left alone.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findTypeLiterals } from './check-frontend-type-scale.mjs'
import { codeLines } from './lib/frontend-scan.mjs'

/** Every literal in a source fragment, read line by line the way the CLI reads a file. */
const find = (source) => codeLines(source).flatMap(findTypeLiterals)

describe('findTypeLiterals', () => {
  it('flags every px literal the migration removed', () => {
    assert.deepEqual(find('class="text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(find('class="text-[10px]"'), ['text-[10px]'])
    assert.deepEqual(find('class="text-[9px]"'), ['text-[9px]'])
    assert.deepEqual(find('class="text-[12.5px]"'), ['text-[12.5px]'])
  })

  it('flags the rem, em and pt forms, which scale but are still unnameable', () => {
    assert.deepEqual(find('class="text-[0.6875rem]"'), ['text-[0.6875rem]'])
    assert.deepEqual(find('class="text-[.75em]"'), ['text-[.75em]'])
    assert.deepEqual(find('class="text-[9pt]"'), ['text-[9pt]'])
  })

  it('flags the other three spellings of the same declaration', () => {
    // Banning one spelling and not its siblings teaches the next contributor the siblings.
    assert.deepEqual(find('class="text-[length:11px]"'), ['text-[length:11px]'])
    assert.deepEqual(find('class="[font-size:11px]"'), ['[font-size:11px]'])
    assert.deepEqual(find('class="sm:[font-size:0.7rem]"'), ['[font-size:0.7rem]'])
    assert.deepEqual(find('  font-size: 11px;'), ['font-size: 11px'])
  })

  it('leaves a raw declaration that already follows the root alone', () => {
    // `rem` and `em` track the `font-size` a theme document sets, so only `px` is a literal here.
    assert.deepEqual(find('  font-size: 0.8rem;'), [])
    assert.deepEqual(find('  font-size: 0.95em;'), [])
    assert.deepEqual(find('  font-size: max(16px, 1em);'), [])
    // The theme writer itself, the one place a px root is the point (`utils/theme/css.ts`).
    assert.deepEqual(find('lines.push(`html[data-theme] { font-size: ${n}px; }`)'), [])
  })

  it('flags a literal behind a variant, and deduplicates within a line', () => {
    assert.deepEqual(find('class="sm:text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(find('class="hover:text-[11px] text-[11px]"'), ['text-[11px]'])
    assert.deepEqual(find('class="text-[11px] text-[13px]"'), ['text-[11px]', 'text-[13px]'])
  })

  it('flags a literal in a bound class expression, not only a static attribute', () => {
    assert.deepEqual(find(`:class="compact ? 'text-[9px]' : 'text-2xs'"`), ['text-[9px]'])
  })

  it('accepts every named step, including the two the app declares', () => {
    assert.deepEqual(find('class="text-3xs text-2xs text-xs text-sm text-base"'), [])
    assert.deepEqual(find('class="text-2xs font-semibold uppercase text-dimmed"'), [])
  })

  it('leaves arbitrary COLOUR to the palette guard, so one line is never reported twice', () => {
    assert.deepEqual(find('class="text-[#f59e0b]"'), [])
    assert.deepEqual(find('class="text-[var(--app-hue-pink)]"'), [])
    assert.deepEqual(find('class="text-[rgb(30_41_59)]"'), [])
  })

  it('leaves every non-font-size arbitrary value alone', () => {
    assert.deepEqual(find('class="leading-[18px]"'), [])
    assert.deepEqual(find('class="w-[420px] max-w-[60ch] gap-[3px]"'), [])
    assert.deepEqual(find('class="tracking-[0.12em]"'), [])
  })

  it('needs a left boundary, so a utility merely ending in `text-` is not a match', () => {
    assert.deepEqual(find('class="placeholder-text-[11px]"'), [])
    assert.deepEqual(find('class="mytext-[11px]"'), [])
  })

  it('flags the font shorthand and the JS spellings, which pin text in px just the same', () => {
    assert.deepEqual(find('  font: 600 11px/1.2 Geist;'), ['font: 600 11px'])
    assert.deepEqual(find('class="[font:600_11px/1.2_Geist]"'), ['[font:600_11px/1.2_Geist]'])
    assert.deepEqual(find(`:style="{ fontSize: '11px' }"`), [`fontSize: '11px`])
    assert.deepEqual(find(`el.style.fontSize = '11px'`), [`fontSize = '11px`])
    assert.deepEqual(find(`:style="{ 'font-size': '11px' }"`), [`font-size': '11px`])
    assert.deepEqual(find(`el.style.setProperty('font-size', '11px')`), [
      `setProperty('font-size', '11px`,
    ])
  })

  it('leaves a shorthand or JS value that already follows the root alone', () => {
    assert.deepEqual(find('  font: 600 0.6875rem/1.2 Geist;'), [])
    assert.deepEqual(find('  font: inherit;'), [])
    assert.deepEqual(find(`:style="{ fontSize: '0.75rem' }"`), [])
    // A line height in px is not a font size, and an ID or a decimal is not a size boundary.
    assert.deepEqual(find('  font: 600 0.75rem/18px Geist;'), [])
    assert.deepEqual(find('  font-family: Geist; line-height: 18px;'), [])
  })

  it('reads code, not prose: a comment explaining the rule is clean', () => {
    assert.deepEqual(find('// `text-[11px]` was the old spelling'), [])
    assert.deepEqual(find('/*\n * `text-[10px]` folds onto `text-3xs`\n */'), [])
    assert.deepEqual(find('<!--\n  was text-[11px]\n-->'), [])
    assert.deepEqual(find(`const c = 'text-2xs' /* not 'text-[11px]' */`), [])
    // Code before OR after a comment is still code.
    assert.deepEqual(find('class="text-[11px]" // an unrelated note'), ['text-[11px]'])
    assert.deepEqual(find('<!-- note --> <div class="text-[11px]">'), ['text-[11px]'])
  })

  it('reads a leading `*` outside a block comment as the CSS universal selector', () => {
    assert.deepEqual(find('* { font-size: 11px }'), ['font-size: 11px'])
    assert.deepEqual(find('*::placeholder { font-size: 10px; }'), ['font-size: 10px'])
    assert.deepEqual(find('/* a closed note */\n* { font-size: 11px }'), ['font-size: 11px'])
  })

  it('honours the waiver on the line itself and on the line before it', () => {
    assert.deepEqual(find('class="text-[11px]" // type-literal-ok: reason'), [])
    assert.deepEqual(find('// type-literal-ok: reason\nclass="text-[11px]"'), [])
    assert.deepEqual(find('// an unrelated comment\nclass="text-[11px]"'), ['text-[11px]'])
  })
})
