// Fixtures for the fixed-palette ban (issue #2239). Run with `node --test scripts/` — the built-in
// runner, so CI's guards job stays install-free.
//
// The cases that matter are the false friends: a blind substring scan would flag the word
// "translated", the `neutral: 'slate'` alias value, a comment that names a shade, and the app's own
// `text-app-primary-400` token (which CONTAINS `primary-400`). The guard must flag only real
// fixed-palette utilities and must accept the theme tokens that replaced them.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findColourLiterals,
  findFixedBlackWhite,
  findRawPalette,
} from './check-frontend-palette.mjs'

describe('findRawPalette', () => {
  it('flags raw utilities for every aliased hue, including variants and opacity', () => {
    assert.deepEqual(findRawPalette('class="bg-slate-900"'), ['bg-slate-900'])
    assert.deepEqual(findRawPalette('class="text-indigo-400"'), ['text-indigo-400'])
    assert.deepEqual(findRawPalette('class="border-slate-800"'), ['border-slate-800'])
    assert.deepEqual(findRawPalette('class="hover:bg-slate-950/40"'), ['bg-slate-950/40'])
    assert.deepEqual(findRawPalette('class="text-amber-300 border-rose-800"'), [
      'text-amber-300',
      'border-rose-800',
    ])
    assert.deepEqual(findRawPalette('class="bg-emerald-950/40 text-sky-300 ring-violet-500"'), [
      'bg-emerald-950/40',
      'text-sky-300',
      'ring-violet-500',
    ])
    assert.deepEqual(findRawPalette('class="text-red-400"'), ['text-red-400'])
  })

  it('flags a fixed numbered alias utility (follows the palette, not the mode)', () => {
    assert.deepEqual(findRawPalette('class="text-primary-400"'), ['text-primary-400'])
    assert.deepEqual(findRawPalette('class="bg-warning-950/40 border-error-800"'), [
      'bg-warning-950/40',
      'border-error-800',
    ])
    assert.deepEqual(findRawPalette('class="bg-neutral-900"'), ['bg-neutral-900'])
  })

  it('deduplicates repeated hits on one line', () => {
    assert.deepEqual(findRawPalette('a bg-slate-900 b bg-slate-900'), ['bg-slate-900'])
  })

  it('accepts the theme tokens that replaced the fixed classes', () => {
    assert.deepEqual(
      findRawPalette('class="bg-app-950 text-primary border-app-warning-800 bg-app-error-950/40"'),
      [],
    )
    assert.deepEqual(findRawPalette('class="bg-default text-muted border-default"'), [])
    assert.deepEqual(findRawPalette('class="text-primary bg-warning/10 ring-error/25"'), [])
  })

  it('flags a raw category hue too, and accepts its app-hue token', () => {
    assert.deepEqual(findRawPalette('class="text-pink-300 bg-teal-500/15 text-orange-300"'), [
      'text-pink-300',
      'bg-teal-500/15',
      'text-orange-300',
    ])
    assert.deepEqual(findRawPalette('class="text-app-hue-pink bg-app-hue-teal/15"'), [])
  })

  it('flags the retired numbered primary token', () => {
    assert.deepEqual(findRawPalette('class="text-app-primary-400 bg-app-primary-950/30"'), [
      'text-app-primary-400',
      'bg-app-primary-950/30',
    ])
  })

  it('ignores the false friends a substring scan would trip on', () => {
    assert.deepEqual(findRawPalette('  -translate-x-1/2 -translate-y-1/2'), [])
    assert.deepEqual(findRawPalette("      neutral: 'slate',"), [])
    assert.deepEqual(findRawPalette("      primary: 'indigo',"), [])
    assert.deepEqual(findRawPalette('// a deep slate-950 surface so the slate-900 panels pop'), [])
    assert.deepEqual(findRawPalette(' * translated ten times, never re-worded'), [])
    assert.deepEqual(findRawPalette('  --app-warning-300: var(--ui-color-warning-300);'), [])
  })

  it('ignores an out-of-range shade (not a real Tailwind step)', () => {
    assert.deepEqual(findRawPalette('class="bg-slate-1000"'), [])
  })

  it('requires a left boundary so an identifier substring is not a false positive', () => {
    assert.deepEqual(findRawPalette('myaccent-indigo-400'), [])
    assert.deepEqual(findRawPalette('xbg-slate-900'), [])
    assert.deepEqual(findRawPalette('data-bg-slate-900'), [])
    // A real variant prefix still matches (the char before the utility is `:`, not word/dash).
    assert.deepEqual(findRawPalette('class="hover:bg-slate-900"'), ['bg-slate-900'])
  })
})

describe('findColourLiterals', () => {
  it('flags hex and colour-function literals in attributes, styles and keyframes', () => {
    assert.deepEqual(findColourLiterals('<path d="M0,0" fill="#f59e0b" />'), ['#f59e0b'])
    assert.deepEqual(findColourLiterals('  color: rgb(226 232 240);'), ['rgb('])
    assert.deepEqual(findColourLiterals('    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5);'), [
      'rgba(',
    ])
    assert.deepEqual(findColourLiterals("  frontend: { accent: '#60a5fa' },"), ['#60a5fa'])
    assert.deepEqual(findColourLiterals('  background: #fff;'), ['#fff'])
    assert.deepEqual(findColourLiterals('  color: #fff8;'), ['#fff8'])
    assert.deepEqual(findColourLiterals('  --x: #0b1020ff;'), ['#0b1020ff'])
    // An ID selector is code, not a comment: the literal inside it must still be caught.
    assert.deepEqual(findColourLiterals('#app { color: #ff0000; }'), ['#ff0000'])
    assert.deepEqual(findColourLiterals('#board .edge { stroke: rgb(1 2 3); }'), ['rgb('])
  })

  // The literal regex covers the modern colour functions too. A guard with a zero-offender policy
  // must enumerate the syntax space it claims, or a hole is a rule that silently does not apply.
  // hex 3/4/6/8 and rgb()/rgba() are covered above; these are the rest.
  it('flags every colour-function form the header enumerates', () => {
    assert.deepEqual(findColourLiterals('  color: hsl(210 40% 96%);'), ['hsl('])
    assert.deepEqual(findColourLiterals('  color: hsla(210, 40%, 96%, 0.5);'), ['hsla('])
    assert.deepEqual(findColourLiterals('  --x: oklch(62.8% 0.15 264);'), ['oklch('])
    assert.deepEqual(findColourLiterals('  --x: oklab(0.6 0.1 -0.1);'), ['oklab('])
    assert.deepEqual(findColourLiterals('  --x: lab(52% 40 59);'), ['lab('])
    assert.deepEqual(findColourLiterals('  --x: lch(52% 72 49);'), ['lch('])
    assert.deepEqual(findColourLiterals('  --x: color(display-p3 1 0 0);'), ['color('])
  })

  it('covers the four hex widths and the 3/4-digit terminator boundary', () => {
    assert.deepEqual(findColourLiterals('  a: #abc;'), ['#abc'])
    assert.deepEqual(findColourLiterals('  a: #abcd;'), ['#abcd'])
    assert.deepEqual(findColourLiterals('  a: #a1b2c3;'), ['#a1b2c3'])
    assert.deepEqual(findColourLiterals('  a: #a1b2c3d4;'), ['#a1b2c3d4'])
    // A 3/4-digit hex needs a value terminator (`"');,` or space) after it: a slot closed by `>`
    // and a 5-hex-char word both stay clear. (A real 4-hex word before a space, `#cafe `, does
    // match; that is the accepted cost of catching `#fff8;`.)
    assert.deepEqual(findColourLiterals('<template #abc>'), [])
    assert.deepEqual(findColourLiterals('const slug = "#faced"'), [])
  })

  it('flags a hex alpha appended to a colour value', () => {
    assert.deepEqual(findColourLiterals(':style="{ backgroundColor: typeMeta.accent + \'22\' }"'), [
      "accent + '22'",
    ])
    assert.deepEqual(findColourLiterals('backgroundColor: `${typeBadge.color}22`'), [
      '${typeBadge.color}22',
    ])
    assert.deepEqual(findColourLiterals(':style="{ backgroundColor: tint(a.color) }"'), [])
  })

  it('accepts tokens, template slots, url(#id) references and comments', () => {
    assert.deepEqual(findColourLiterals('  color: var(--ui-text-highlighted);'), [])
    assert.deepEqual(findColourLiterals("  fill: 'var(--app-hue-blue)',"), [])
    assert.deepEqual(findColourLiterals('<template #body>'), [])
    assert.deepEqual(findColourLiterals('<template #add>'), [])
    assert.deepEqual(findColourLiterals('#app {'), [])
    assert.deepEqual(findColourLiterals('#__nuxt { height: 100%; }'), [])
    assert.deepEqual(findColourLiterals('marker-end="url(#task-arrow-done)"'), [])
    assert.deepEqual(findColourLiterals('// the canvas was the literal #0b1020 navy'), [])
    assert.deepEqual(
      findColourLiterals(' * `rgb(30 41 59)` is what the reader used to hardcode'),
      [],
    )
    assert.deepEqual(
      findColourLiterals("content: '#020618', // colour-literal-ok: first-paint fallback"),
      [],
    )
  })
})

describe('findFixedBlackWhite', () => {
  it('flags fixed white/black utilities, alpha and arbitrary-opacity forms included', () => {
    assert.deepEqual(findFixedBlackWhite('class="bg-white"'), ['bg-white'])
    assert.deepEqual(findFixedBlackWhite('class="text-black"'), ['text-black'])
    assert.deepEqual(findFixedBlackWhite('class="border-white/5"'), ['border-white/5'])
    assert.deepEqual(findFixedBlackWhite('class="bg-white/[0.02]"'), ['bg-white/[0.02]'])
    assert.deepEqual(findFixedBlackWhite('class="ring-white/10"'), ['ring-white/10'])
    assert.deepEqual(findFixedBlackWhite('class="border-white/5 bg-white/[0.02]"'), [
      'border-white/5',
      'bg-white/[0.02]',
    ])
    // A variant prefix precedes the utility and does not affect the match; a side border does.
    assert.deepEqual(findFixedBlackWhite('class="hover:bg-black/20"'), ['bg-black/20'])
    assert.deepEqual(findFixedBlackWhite('class="border-x-black"'), ['border-x-black'])
  })

  it('needs a whole-word colour and a left boundary', () => {
    assert.deepEqual(findFixedBlackWhite('class="fill-whitesmoke"'), []) // not `white`
    assert.deepEqual(findFixedBlackWhite('class="text-blackout"'), []) // not `black`
    assert.deepEqual(findFixedBlackWhite('data-bg-white'), []) // no left boundary
  })

  it('reads code only: skips a comment line and honours the escape marker', () => {
    assert.deepEqual(findFixedBlackWhite('// a bg-white panel used to sit here'), [])
    assert.deepEqual(
      findFixedBlackWhite("const C = 'border-default bg-black' // fixed-colour-ok: diff composite"),
      [],
    )
  })

  it('honours the marker on the line before, the eslint-disable-next-line shape', () => {
    const prev = '<!-- fixed-colour-ok: diff canvas backdrop -->'
    assert.deepEqual(findFixedBlackWhite('  <canvas class="rounded bg-black" />', prev), [])
    // Without the preceding marker the same line is an offender.
    assert.deepEqual(findFixedBlackWhite('  <canvas class="rounded bg-black" />'), ['bg-black'])
  })

  it('strips a trailing HTML comment, so a comment naming a utility is prose', () => {
    assert.deepEqual(findFixedBlackWhite('<div class="bg-muted" /> <!-- was bg-white -->'), [])
  })
})
