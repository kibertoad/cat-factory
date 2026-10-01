// Fixtures for the non-scaling-radius ban (issue #2251). Run with `node --test scripts/`, the
// built-in runner, so CI's guards job stays install-free.
//
// The scale itself is fixed in `main.css`, so the boundary that matters here is NAMED versus
// WELDED: every `rounded-*` step follows `--ui-radius` and is allowed, an arbitrary value is not,
// and a raw declaration follows it only by naming `--ui-radius` itself.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findFixedRadii } from './check-frontend-radius.mjs'

describe('findFixedRadii', () => {
  it('accepts every named step, the bare alias included, because all of them now scale', () => {
    // `main.css` binds `--radius` and `--radius-4xl` onto `--ui-radius`, so there is no longer a
    // spelling of the utility that ignores a theme document's `radius`.
    assert.deepEqual(findFixedRadii('class="rounded"'), [])
    assert.deepEqual(findFixedRadii('class="rounded-sm rounded-md rounded-4xl"'), [])
    assert.deepEqual(findFixedRadii('class="rounded-t rounded-bl rounded-ss-lg"'), [])
    assert.deepEqual(findFixedRadii('class="rounded-full rounded-none"'), [])
  })

  it('flags an arbitrary value in both v4 syntaxes', () => {
    // The bracket form and the CSS-variable shorthand are the same defect, and a side or corner
    // prefix hides neither.
    assert.deepEqual(findFixedRadii('class="rounded-[10px]"'), ['rounded-[10px]'])
    assert.deepEqual(findFixedRadii('class="rounded-t-[0.6rem]"'), ['rounded-t-[0.6rem]'])
    assert.deepEqual(findFixedRadii('class="rounded-(--my-radius)"'), ['rounded-(--my-radius)'])
    assert.deepEqual(findFixedRadii('class="rounded-bl-(--x)"'), ['rounded-bl-(--x)'])
  })

  it('needs no quote context, because `rounded-[` and `rounded-(` are not English', () => {
    // The whole class of prose false positive the bare-alias ban had to work around is gone: a
    // sentence, an `alt`, a spec name and a wrapped class list all read the same way now.
    assert.deepEqual(findFixedRadii('const msg = "the value is rounded to two places"'), [])
    assert.deepEqual(findFixedRadii('    <img alt="rounded avatar" :src="src">'), [])
    assert.deepEqual(findFixedRadii('describe("rounded corners", () => {'), [])
    assert.deepEqual(findFixedRadii('      <p>Fully rounded corners on every card</p>'), [])
    // And an arbitrary value is caught wherever it sits, wrapped attribute or bound expression.
    assert.deepEqual(findFixedRadii('         rounded-[10px] bg-elevated"'), ['rounded-[10px]'])
    assert.deepEqual(findFixedRadii(':class="compact ? `rounded-[4px]` : `rounded-lg`"'), [
      'rounded-[4px]',
    ])
    assert.deepEqual(findFixedRadii('class="group-rounded-[x]"'), [])
  })

  it('flags a raw declaration in any absolute unit, longhands and the JS spelling included', () => {
    assert.deepEqual(findFixedRadii('  border-radius: 6px;'), ['border-radius: 6px'])
    assert.deepEqual(findFixedRadii('  border-radius: 0.25rem;'), ['border-radius: 0.25rem'])
    // `pt` and a space before the colon each slipped past an earlier draft.
    assert.deepEqual(findFixedRadii('  border-radius: 4pt;'), ['border-radius: 4pt'])
    assert.deepEqual(findFixedRadii('  border-radius : 4px;'), ['border-radius: 4px'])
    assert.deepEqual(findFixedRadii('  border-top-left-radius: 4px;'), [
      'border-top-left-radius: 4px',
    ])
    assert.deepEqual(findFixedRadii('  border-start-start-radius: 0.25rem;'), [
      'border-start-start-radius: 0.25rem',
    ])
    assert.deepEqual(findFixedRadii(`:style="{ borderRadius: '4px' }"`), ['borderRadius: 4px'])
    assert.deepEqual(findFixedRadii(`el.style.borderTopLeftRadius = '0.25rem'`), [
      'borderTopLeftRadius: 0.25rem',
    ])
    assert.deepEqual(findFixedRadii(`:style="{ 'border-radius': '4px' }"`), ['border-radius: 4px'])
  })

  it('accepts a declaration that reaches the scale, calc arithmetic included', () => {
    assert.deepEqual(findFixedRadii('  border-radius: var(--ui-radius);'), [])
    assert.deepEqual(findFixedRadii('  border-radius: calc(var(--ui-radius) * 2);'), [])
    // An inner box kept concentric with its parent still MOVES with the theme, so the literal in
    // the arithmetic is not a welded radius.
    assert.deepEqual(findFixedRadii('  border-radius: calc(var(--ui-radius) - 1px);'), [])
    assert.deepEqual(findFixedRadii(`:style="{ borderRadius: 'var(--ui-radius)' }"`), [])
  })

  it('flags a `--radius-*` theme variable, which is correct only while something else uses it', () => {
    // Tailwind emits those only where the compiled stylesheet graph references them, so one works
    // until the last other reference is deleted and then silently computes to 0. A scoped SFC
    // `<style>` block is not part of that graph at all.
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius-lg);'), [
      'border-radius: var(--radius-lg)',
    ])
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius);'), [
      'border-radius: var(--radius)',
    ])
    // A fallback does not rescue it, and did defeat an earlier draft's `\\s*\\)`.
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius, 0);'), [
      'border-radius: var(--radius, 0)',
    ])
  })

  it('accepts the pill and the square, which have no scale to follow', () => {
    assert.deepEqual(findFixedRadii('  border-radius: 9999px;'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 50%;'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 0;'), [])
  })

  it('reads each declaration on its own, so a pill beside a literal hides nothing', () => {
    // The teardrop shape: two pill corners and two real ones. Suppressing the whole line on the
    // `50%` would let the 8px through.
    assert.deepEqual(findFixedRadii('  border-radius: 50% 50% 8px 8px;'), [
      'border-radius: 50% 50% 8px 8px',
    ])
    // `999px` sits inside `4999px`: an unbounded removal leaves `4`, which carries no unit.
    assert.deepEqual(findFixedRadii('  border-radius: 4999px;'), ['border-radius: 4999px'])
    assert.deepEqual(findFixedRadii('  border-radius: 150%;'), [])
  })

  it('reads code, not prose: a comment about the rule is clean', () => {
    assert.deepEqual(findFixedRadii('// `rounded-[10px]` was the old spelling'), [])
    assert.deepEqual(findFixedRadii(' * each edge is rounded OUTWARD'), [])
    assert.deepEqual(findFixedRadii('<!-- was border-radius: 4px -->'), [])
    assert.deepEqual(findFixedRadii(`const n = 1 // was 'rounded-[4px]' before #2251`), [])
    assert.deepEqual(findFixedRadii(`const c = 'rounded-sm' /* not 'rounded-[4px]' */`), [])
    assert.deepEqual(findFixedRadii(`const u = 'https://x' // fine`), [])
    // Code before OR after the comment is still code.
    assert.deepEqual(findFixedRadii('class="rounded-[4px]" // an unrelated note'), [
      'rounded-[4px]',
    ])
    assert.deepEqual(findFixedRadii('<!-- note --> <div class="rounded-[4px]">'), ['rounded-[4px]'])
  })

  it('reads the CSS universal selector as a rule, not as a JSDoc continuation', () => {
    // A leading `*` is the shape of both. The formatter writes a combinator with spaces around it,
    // and whitespace is itself the descendant combinator, so all of these are rules.
    assert.deepEqual(findFixedRadii('* { border-radius: 4px; }'), ['border-radius: 4px'])
    assert.deepEqual(findFixedRadii('*, *::before { border-radius: 4px; }'), [
      'border-radius: 4px',
    ])
    assert.deepEqual(findFixedRadii('* p { border-radius: 4px }'), ['border-radius: 4px'])
    assert.deepEqual(findFixedRadii('* > .x { border-radius: 4px }'), ['border-radius: 4px'])
    assert.deepEqual(findFixedRadii('* + * { border-radius: 4px; }'), ['border-radius: 4px'])
    // The JSDoc continuation and the block-comment close still read as prose.
    assert.deepEqual(findFixedRadii(' * each edge is rounded OUTWARD'), [])
    assert.deepEqual(findFixedRadii(' */'), [])
  })

  it('honours the waiver on the line itself and on the line before it', () => {
    assert.deepEqual(findFixedRadii('  border-radius: 4px; // radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 4px;', '// radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 4px;', '// an unrelated comment'), [
      'border-radius: 4px',
    ])
  })
})
