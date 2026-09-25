// Fixtures for the non-scaling-radius ban (issue #2251). Run with `node --test scripts/` — the
// built-in runner, so CI's guards job stays install-free.
//
// The boundary that matters is BARE alias versus THEME-BACKED step, because the two differ by one
// character and only one of them follows the theme. `rounded-sm` is allowed and `rounded-s` is not,
// `rounded-e` is banned and `rounded-2xl` is not. A step is not enough on its own either:
// `rounded-4xl` reads like the rest of the scale and is a 2rem literal, because Nuxt UI rebinds
// only xs through 3xl.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findFixedRadii, tracksOpenClassList } from './check-frontend-radius.mjs'

describe('findFixedRadii', () => {
  it('flags the bare alias the migration removed', () => {
    assert.deepEqual(findFixedRadii('class="rounded"'), ['rounded'])
    assert.deepEqual(findFixedRadii('class="rounded border border-default p-3"'), ['rounded'])
  })

  it('flags a bare SIDE or CORNER alias, logical and physical alike', () => {
    // The SPA is RTL-aware, so a guard that knew only `t`/`b` would pass every logical form.
    assert.deepEqual(findFixedRadii('class="rounded-t"'), ['rounded-t'])
    assert.deepEqual(findFixedRadii('class="rounded-bl"'), ['rounded-bl'])
    assert.deepEqual(findFixedRadii('class="rounded-s"'), ['rounded-s'])
    assert.deepEqual(findFixedRadii('class="rounded-ee"'), ['rounded-ee'])
  })

  it('accepts every named step, which all derive from --ui-radius', () => {
    assert.deepEqual(findFixedRadii('class="rounded-sm rounded-md rounded-lg"'), [])
    assert.deepEqual(findFixedRadii('class="rounded-xl rounded-2xl rounded-3xl rounded-xs"'), [])
    // A named step behind a side is still a named step.
    assert.deepEqual(findFixedRadii('class="rounded-t-2xl rounded-b-sm rounded-ss-lg"'), [])
  })

  it('flags a step OUTSIDE the seven Nuxt UI rebinds, which reads like the rest of the scale', () => {
    // Tailwind ships `--radius-4xl: 2rem` and Nuxt UI leaves it alone, so this is the bare alias's
    // defect wearing a named step's clothes: a fixed 32px while every neighbour follows the theme.
    assert.deepEqual(findFixedRadii('class="rounded-4xl"'), ['rounded-4xl'])
    assert.deepEqual(findFixedRadii('class="rounded-t-4xl"'), ['rounded-t-4xl'])
  })

  it('accepts the pill and the square, which have no scale to follow', () => {
    assert.deepEqual(findFixedRadii('class="rounded-full"'), [])
    assert.deepEqual(findFixedRadii('class="rounded-none rounded-t-none"'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 9999px;'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 50%;'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 0;'), [])
  })

  it('flags an arbitrary value, the shape the fix would come back as', () => {
    assert.deepEqual(findFixedRadii('class="rounded-[10px]"'), ['rounded-[10px]'])
    assert.deepEqual(findFixedRadii('class="rounded-t-[0.6rem]"'), ['rounded-t-[0.6rem]'])
  })

  it('flags a raw declaration in px, rem and em, and accepts the scale variable', () => {
    // `rem` is claimed too: it tracks the ROOT FONT SIZE, a different theme knob, so it follows
    // `--ui-radius` no better than px does.
    assert.deepEqual(findFixedRadii('  border-radius: 0.25rem;'), ['border-radius: 0.25rem'])
    assert.deepEqual(findFixedRadii('  border-radius: 6px;'), ['border-radius: 6px'])
    assert.deepEqual(findFixedRadii('  border-radius: 0.5em;'), ['border-radius: 0.5em'])
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius-lg);'), [])
  })

  it('reads each declaration on its own, so a pill beside a literal hides nothing', () => {
    // The teardrop shape: two pill corners and two real ones. Suppressing the whole line on the
    // `50%` would let the 8px through.
    assert.deepEqual(findFixedRadii('  border-radius: 50% 50% 8px 8px;'), [
      'border-radius: 50% 50% 8px 8px',
    ])
    assert.deepEqual(findFixedRadii('  border-radius: 0.25rem; border-radius: 50%;'), [
      'border-radius: 0.25rem',
    ])
  })

  it('flags an alias behind a variant, and deduplicates within a line', () => {
    assert.deepEqual(findFixedRadii('class="sm:rounded hover:rounded"'), ['rounded'])
    assert.deepEqual(findFixedRadii('class="rounded rounded-t"'), ['rounded', 'rounded-t'])
  })

  it('flags an alias in a bound class expression, not only a static attribute', () => {
    assert.deepEqual(findFixedRadii(`:class="compact ? 'rounded' : 'rounded-lg'"`), ['rounded'])
    assert.deepEqual(findFixedRadii(`const CLS = 'w-full rounded border border-default'`), [
      'rounded',
    ])
  })

  it('needs a left boundary, so a longer token merely containing `rounded` is not a match', () => {
    assert.deepEqual(findFixedRadii('class="group-rounded"'), [])
    assert.deepEqual(findFixedRadii('class="not-last:rounded-none"'), [])
    assert.deepEqual(findFixedRadii('// the value is rounded down before display'), [])
  })

  it('reads code, not prose: a comment line explaining the rule is clean', () => {
    assert.deepEqual(findFixedRadii('// `rounded` was the old spelling'), [])
    assert.deepEqual(findFixedRadii(' * each edge is rounded OUTWARD'), [])
    assert.deepEqual(findFixedRadii('<!-- was rounded -->'), [])
  })

  it('reads a utility only where one can live, because `rounded` is also an English word', () => {
    assert.deepEqual(findFixedRadii('      <p>Fully rounded corners on every card</p>'), [])
    assert.deepEqual(findFixedRadii('const shown = Math.round(ms / 1000) // seconds, rounded'), [])
    // The three places a class list really is written.
    assert.deepEqual(findFixedRadii('  @apply rounded bg-elevated;'), ['rounded'])
    assert.deepEqual(findFixedRadii('    class="rounded border'), ['rounded'])
  })

  it('reads a class list wrapped over several lines, not only the line carrying `class="`', () => {
    // The continuation lines hold no quote pair, no `@apply` and no `class=`, so without the
    // carried state a bare alias parked on one of them ships.
    const wrapped = ['  class="flex items-center gap-2', '         rounded bg-elevated"', '>']
    const found = []
    let open = false
    for (const [i, line] of wrapped.entries()) {
      found.push(...findFixedRadii(line, wrapped[i - 1] ?? '', open))
      open = tracksOpenClassList(line, open)
    }
    assert.deepEqual(found, ['rounded'])
    // The attribute closes on the quote, so the line after it is ordinary code again.
    assert.equal(tracksOpenClassList('         rounded bg-elevated"', true), false)
  })

  it('flags a per-corner longhand, physical and logical alike', () => {
    // No `border-radius:` substring in either, so a shorthand-only pattern reads both as clean.
    assert.deepEqual(findFixedRadii('  border-top-left-radius: 4px;'), [
      'border-top-left-radius: 4px',
    ])
    assert.deepEqual(findFixedRadii('  border-start-start-radius: 0.25rem;'), [
      'border-start-start-radius: 0.25rem',
    ])
    assert.deepEqual(findFixedRadii('  border-end-end-radius: var(--radius-lg);'), [])
  })

  it('does not read a double-quoted SENTENCE as a class list', () => {
    // A bare double-quoted span is the shape of ordinary prose, so the arm is anchored on the
    // attribute name. Without that, a sentence, an `alt` and a spec name each failed CI with a
    // message about a radius the line does not carry, and the only escape was a waiver that lied.
    assert.deepEqual(findFixedRadii('const msg = "the value is rounded to two places"'), [])
    assert.deepEqual(findFixedRadii('    <img alt="rounded avatar" :src="src">'), [])
    assert.deepEqual(findFixedRadii('describe("rounded corners", () => {'), [])
    // The attribute itself still reads, `:class` and `active-class` included.
    assert.deepEqual(findFixedRadii('<div active-class="rounded">'), ['rounded'])
  })

  it('flags an INTERPOLATED step, which cannot be one of the seven', () => {
    // The right boundary rejected the whole token on the `-` before `${`, so a computed class was
    // not classified at all and a `size` resolving to `4xl` shipped past a zero-tolerance guard.
    assert.deepEqual(findFixedRadii(':class="`rounded-${size}`"'), ['rounded-${size}'])
    assert.deepEqual(findFixedRadii('const c = `rounded-t-${step}`'), ['rounded-t-${step}'])
  })

  it('does not read an apostrophe as a quote, so English prose is not a class list', () => {
    assert.deepEqual(findFixedRadii("      <p>It's a rounded corner, don't use it</p>"), [])
    assert.deepEqual(findFixedRadii("    description: 'chunky rounded type, large controls.',"), [
      'rounded',
    ])
  })

  it('reads the CSS universal selector as a rule, not as a JSDoc continuation', () => {
    // A leading `*` is the shape of both, so what tells them apart is what FOLLOWS: a selector
    // continues into `{`, `,` or a combinator, where a comment continues into prose. Reading this
    // one as prose let a reset rule carry a px literal straight past a zero-tolerance guard.
    assert.deepEqual(findFixedRadii('* { border-radius: 4px; }'), ['border-radius: 4px'])
    assert.deepEqual(findFixedRadii('*, *::before { border-radius: 0.25rem; }'), [
      'border-radius: 0.25rem',
    ])
    // The JSDoc continuation and the block-comment close still read as prose.
    assert.deepEqual(findFixedRadii(' * each edge is rounded OUTWARD'), [])
    assert.deepEqual(findFixedRadii(' */'), [])
  })

  it('flags a `var()` naming a step Nuxt UI does not rebind', () => {
    // `--radius-4xl` is Tailwind's own 2rem and `--radius` is the deprecated alias inlined as
    // 0.25rem, so both are rules 1 and 2 spelled in CSS. A unit check alone waves them through.
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius-4xl);'), [
      'border-radius: var(--radius-4xl)',
    ])
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius);'), [
      'border-radius: var(--radius)',
    ])
    // The scale variable itself and the seven rebinds stay clean.
    assert.deepEqual(findFixedRadii('  border-radius: var(--ui-radius);'), [])
    assert.deepEqual(findFixedRadii('  border-radius: calc(var(--ui-radius) * 2);'), [])
    assert.deepEqual(findFixedRadii('  border-radius: var(--radius-3xl);'), [])
  })

  it('flags the JS style spelling a `:style` binding uses', () => {
    // A camelCase name contains no `border-radius` substring, so the CSS pattern reads it as clean,
    // and a `:style` binding is the third place a fixed radius can be written.
    assert.deepEqual(findFixedRadii(`:style="{ borderRadius: '4px' }"`), ['borderRadius: 4px'])
    // The separator is `:` in an object literal and `=` in an `element.style` assignment.
    assert.deepEqual(findFixedRadii(`el.style.borderTopLeftRadius = '0.25rem'`), [
      'borderTopLeftRadius: 0.25rem',
    ])
    assert.deepEqual(findFixedRadii(`:style="{ borderStartStartRadius: '6px', top: 0 }"`), [
      'borderStartStartRadius: 6px',
    ])
    assert.deepEqual(findFixedRadii(`:style="{ borderRadius: 'var(--ui-radius)' }"`), [])
  })

  it('does not strip a pill spelling out of the middle of a longer number', () => {
    // `999px` sits inside `4999px`: an unbounded removal leaves `4`, which carries no unit, so a
    // real literal reads as clean.
    assert.deepEqual(findFixedRadii('  border-radius: 4999px;'), ['border-radius: 4999px'])
    assert.deepEqual(findFixedRadii('  border-radius: 150%;'), [])
    // The pill spellings themselves still suppress, on their own and beside a literal.
    assert.deepEqual(findFixedRadii('  border-radius: 9999px;'), [])
    assert.deepEqual(findFixedRadii('  border-radius: 100vmax 100vmax 8px 8px;'), [
      'border-radius: 100vmax 100vmax 8px 8px',
    ])
  })

  it('reads code, not a TRAILING comment, so a note about the rule is clean', () => {
    // `COMMENT_LINE` only sees a line that OPENS with a marker, and the README invites writing
    // exactly this note. A `//` inside a URL follows a colon and so is not a comment.
    assert.deepEqual(findFixedRadii(`const n = 1 // was 'rounded' before #2251`), [])
    assert.deepEqual(findFixedRadii(`const c = 'rounded-sm' /* not 'rounded' */`), [])
    assert.deepEqual(findFixedRadii(`const u = 'https://x' // fine`), [])
    // Code before the comment is still code.
    assert.deepEqual(findFixedRadii(`class="rounded" // an unrelated note`), ['rounded'])
  })

  it('honours the waiver on the line itself and on the line before it', () => {
    assert.deepEqual(findFixedRadii('class="rounded" // radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('class="rounded"', '// radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('class="rounded"', '// an unrelated comment'), ['rounded'])
  })
})
