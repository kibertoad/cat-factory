import { test, expect } from './fixtures'

// Guards the Nuxt UI theming migration (issue #2239): the SPA moved off raw Tailwind palette
// classes (`bg-slate-900`, `text-indigo-400`) onto Nuxt UI's ROLE tokens (`bg-default`,
// `text-muted`, ...), the `app-*` tokens for the five grey shades with no role token, and the
// `primary` alias for brand accents. Dark stayed pixel-identical only because every one of those
// resolves, in dark, to the exact slate/indigo shade it replaced. The chain each token rides:
//   bg-default  ->  var(--ui-bg)  ->  var(--ui-color-neutral-900)
//               ->  var(--color-slate-900, slate-900 literal)  ->  the slate-900 value
// This asserts, in the REAL built stylesheet, that `--ui-color-neutral-{n}` / `--ui-color-primary-{n}`
// resolve to the exact Tailwind slate/indigo values for every shade the app uses, and that each
// role / `app-*` token's DARK value is the shade it replaced. A Nuxt UI upgrade or an
// `app.config.ts` edit that broke the aliasing would reshade the whole app; it fails here instead.
//
// Two deliberate choices, both learned from getting it wrong first:
//   1. Read `--ui-color-*`, NOT `--color-*`. Nuxt UI declares `--color-neutral-*` with
//      `@theme ... inline`, which substitutes the value into utilities at build time and
//      emits NO runtime custom property, so `var(--color-neutral-{n})` resolves to
//      nothing. `--ui-color-*` is injected by Nuxt UI's colors plugin as a real `:root`
//      property and is what the inlined utility actually points at.
//   2. Resolve through inline `style`, NOT a mounted `class="bg-…"` node. Tailwind v4
//      JIT only compiles utilities it scans in source, so a class injected at runtime is
//      never emitted and reads back as transparent for BOTH sides (a vacuous pass).
//
// NUMBERED tokens only. Bare `text-primary` / `bg-primary` deliberately resolve to a
// different shade in light vs dark, so they are NOT identity-equal to a fixed
// `indigo-{n}` and are out of scope for the identity-swap phase.

// Tailwind v4's slate/indigo scales (tailwindcss/theme.css), the values the raw
// classes used before the swap. Pinned here on purpose: the test's whole job is to
// catch a drift away from them.
const SLATE: Record<number, string> = {
  100: 'oklch(96.8% 0.007 247.896)',
  200: 'oklch(92.9% 0.013 255.508)',
  300: 'oklch(86.9% 0.022 252.894)',
  400: 'oklch(70.4% 0.04 256.788)',
  500: 'oklch(55.4% 0.046 257.417)',
  600: 'oklch(44.6% 0.043 257.281)',
  700: 'oklch(37.2% 0.044 257.287)',
  800: 'oklch(27.9% 0.041 260.031)',
  900: 'oklch(20.8% 0.042 265.755)',
  950: 'oklch(12.9% 0.042 264.695)',
}
const INDIGO: Record<number, string> = {
  200: 'oklch(87% 0.065 274.039)',
  300: 'oklch(78.5% 0.115 274.713)',
  400: 'oklch(67.3% 0.182 276.935)',
  500: 'oklch(58.5% 0.233 277.117)',
  600: 'oklch(51.1% 0.262 276.966)',
  700: 'oklch(45.7% 0.24 277.023)',
  800: 'oklch(39.8% 0.195 277.366)',
  900: 'oklch(35.9% 0.144 278.697)',
  950: 'oklch(25.7% 0.09 281.288)',
}

// Resolve two CSS color expressions to the browser's computed `rgb()`/`oklch()` form
// in one round trip, so the comparison is between fully-resolved values and never
// between one resolved and one literal string.
async function resolvePair(
  page: import('@playwright/test').Page,
  a: string,
  b: string,
): Promise<[string, string]> {
  return page.evaluate(
    ([exprA, exprB]) => {
      const read = (expr: string): string => {
        const el = document.createElement('div')
        el.style.color = expr
        document.body.appendChild(el)
        const value = getComputedStyle(el).color
        el.remove()
        return value
      }
      return [read(exprA), read(exprB)] as [string, string]
    },
    [a, b] as const,
  )
}

test.describe('palette token parity', () => {
  // `seededBoard` opens a real, error-free board (the `pageErrors` auto fixture would
  // fail us on an incidental exception from a bare unseeded load). The parity check only
  // needs the SPA's theme layer mounted, which any opened page has; the board contents
  // are irrelevant.
  test('neutral-{n} chains to the slate-{n} value', async ({ page, seededBoard }) => {
    void seededBoard
    const resolved: string[] = []
    for (const [shade, expected] of Object.entries(SLATE)) {
      const [token, literal] = await resolvePair(page, `var(--ui-color-neutral-${shade})`, expected)
      expect(token, `--ui-color-neutral-${shade} must resolve to slate-${shade}`).toBe(literal)
      resolved.push(token)
    }
    // Spread guard: every shade differs, so a state where the var is unresolved and all
    // shades collapse to one inherited value cannot pass as a row of equal comparisons.
    expect(new Set(resolved).size, 'every neutral shade must resolve to a distinct value').toBe(
      resolved.length,
    )
  })

  test('primary-{n} chains to the indigo-{n} value', async ({ page, seededBoard }) => {
    void seededBoard
    const resolved: string[] = []
    for (const [shade, expected] of Object.entries(INDIGO)) {
      const [token, literal] = await resolvePair(page, `var(--ui-color-primary-${shade})`, expected)
      expect(token, `--ui-color-primary-${shade} must resolve to indigo-${shade}`).toBe(literal)
      resolved.push(token)
    }
    expect(new Set(resolved).size, 'every primary shade must resolve to a distinct value').toBe(
      resolved.length,
    )
  })

  // The role-token migration (#2239) keeps DARK pixel-identical only because each role token's dark
  // value equals the numbered shade it replaced, and each hand-defined `--app-{n}` token's dark
  // value equals its shade. This asserts that in the real dark stylesheet, so a Nuxt UI change or an
  // edit to the `--app-*` block that shifted a dark value fails here instead of silently reshading
  // dark mode. Light values are Nuxt UI's own responsibility (role tokens) and are mirrored by
  // construction (`--app-*`), so only the dark side is pinned here.
  const s = (n: number): string => {
    const v = SLATE[n]
    if (!v) throw new Error(`no slate-${n} literal in the parity table`)
    return v
  }
  const DARK_EXPECT: Array<[string, string]> = [
    ['--ui-bg', s(900)], // bg-default
    ['--ui-bg-elevated', s(800)], // bg-elevated
    ['--ui-bg-accented', s(700)], // bg-accented
    ['--ui-text', s(200)], // text-default
    ['--ui-text-toned', s(300)], // text-toned
    ['--ui-text-muted', s(400)], // text-muted
    ['--ui-text-dimmed', s(500)], // text-dimmed
    ['--ui-border', s(800)], // border-default
    ['--ui-border-muted', s(700)], // border-muted
    ['--app-950', s(950)], // bg-app-950 (deep surface)
    ['--app-100', s(100)], // text-app-100
    ['--app-600', s(600)], // text-app-600
    ['--app-500', s(500)], // bg-app-500
    ['--app-400', s(400)], // ring-app-400
  ]

  test('role + app tokens keep their dark values (dark stays identical)', async ({
    page,
    seededBoard,
  }) => {
    void seededBoard
    await page.evaluate(() => localStorage.setItem('nuxt-color-mode', 'dark'))
    await page.reload()
    // `text-highlighted` is #fff in dark; assert it too, separately from the neutral-shade set.
    const [hi, white] = await resolvePair(page, 'var(--ui-text-highlighted)', 'rgb(255,255,255)')
    expect(hi, '--ui-text-highlighted must be white in dark (== text-white)').toBe(white)
    for (const [cssVar, expected] of DARK_EXPECT) {
      const [token, literal] = await resolvePair(page, `var(${cssVar})`, expected)
      expect(token, `${cssVar} must resolve to ${expected} in dark`).toBe(literal)
    }
  })
})
