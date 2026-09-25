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
import { findFixedRadii } from './check-frontend-radius.mjs'

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

  it('honours the waiver on the line itself and on the line before it', () => {
    assert.deepEqual(findFixedRadii('class="rounded" // radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('class="rounded"', '// radius-literal-ok: reason'), [])
    assert.deepEqual(findFixedRadii('class="rounded"', '// an unrelated comment'), ['rounded'])
  })
})
