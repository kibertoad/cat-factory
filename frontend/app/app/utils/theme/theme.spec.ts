import { describe, expect, it } from 'vitest'
import { docModeTokens, isSafePaletteName, themeDocToCss } from '~/utils/theme/css'
import {
  DEFAULT_COLORS,
  docColors,
  docComponentOverrides,
  mergeUi,
  styleComponents,
  styleTokens,
  type ThemeDoc,
} from '~/utils/theme/doc'
import { MONO_THEME } from '~/utils/theme/builtins'

describe('theme document expansion', () => {
  it('fills the alias map with the library defaults', () => {
    expect(docColors({ version: 1 })).toEqual(DEFAULT_COLORS)
    expect(docColors({ version: 1, colors: { neutral: 'neutral' } }).neutral).toBe('neutral')
    expect(docColors({ version: 1, colors: { neutral: 'neutral' } }).primary).toBe('green')
  })

  it('expands token shades into ramp references, per mode, whitelisted', () => {
    const tokens = styleTokens({
      tokenShades: {
        '--ui-bg': { dark: 950 },
        '--ui-text-highlighted': { light: 950, dark: 50 },
        '--ui-bg-inverted': { light: 'white' },
        '--not-a-token': { light: 500 },
      },
    })
    expect(tokens.light).toEqual({
      '--ui-text-highlighted': 'var(--ui-color-neutral-950)',
      '--ui-bg-inverted': 'white',
    })
    expect(tokens.dark).toEqual({
      '--ui-bg': 'var(--ui-color-neutral-950)',
      '--ui-text-highlighted': 'var(--ui-color-neutral-50)',
    })
  })

  it('expands a group variant onto exactly the components that support it', () => {
    const fragments = styleComponents({ defaults: { variants: { inputs: 'subtle' } } })
    expect(fragments.input).toEqual({ defaultVariants: { variant: 'subtle' } })
    expect(fragments.selectMenu).toEqual({ defaultVariants: { variant: 'subtle' } })
    expect(fragments.button).toBeUndefined()
    // `solid` is not in the field vocabulary, so an app-wide solid must not unstyle inputs.
    expect(styleComponents({ defaults: { variant: 'solid' } }).input).toBeUndefined()
    expect(styleComponents({ defaults: { variant: 'solid' } }).button).toEqual({
      defaultVariants: { variant: 'solid' },
    })
  })

  it('merges component overrides so both sides survive', () => {
    const merged = mergeUi(
      { modal: { slots: { content: 'bg-app-950' } } },
      { modal: { slots: { content: 'ring-2' }, defaultVariants: { size: 'lg' } } },
    )
    expect(merged.modal).toEqual({
      slots: { content: 'bg-app-950 ring-2' },
      defaultVariants: { size: 'lg' },
    })
  })

  it('layers explicit components over the style expansion', () => {
    const doc: ThemeDoc = {
      version: 1,
      style: { defaults: { variants: { inputs: 'subtle' } } },
      components: { input: { defaultVariants: { size: 'lg' } } },
    }
    expect(docComponentOverrides(doc).input).toEqual({
      defaultVariants: { variant: 'subtle', size: 'lg' },
    })
  })
})

describe('themeDocToCss', () => {
  it('emits nothing for the stock document', () => {
    expect(themeDocToCss({ version: 1 })).toBe('')
  })

  it('anchors every block on the data-theme attribute and puts dark on the higher selector', () => {
    const css = themeDocToCss(MONO_THEME.doc)
    expect(css).toContain(':root[data-theme] {\n  --ui-radius: 0.5rem;')
    expect(css).toContain("--font-sans: 'Geist', ui-sans-serif, system-ui, sans-serif;")
    expect(css).toContain("--font-mono: 'Geist Mono', ui-monospace, monospace;")
    expect(css).toMatch(/:root\[data-theme\] \{[^}]*--ui-primary: black;/)
    expect(css).toMatch(/:root\[data-theme\]\.dark \{[^}]*--ui-primary: white;/)
    expect(css).toMatch(/:root\[data-theme\]\.dark \{[^}]*--ui-bg: var\(--ui-color-neutral-950\);/)
    expect(css).not.toMatch(/^\.dark/m)
  })

  it('lets an explicit token override any variable, including the app tokens', () => {
    const tokens = docModeTokens({
      version: 1,
      tokens: { dark: { '--app-bg-canvas': 'var(--ui-color-neutral-900)' } },
    })
    expect(tokens.dark['--app-bg-canvas']).toBe('var(--ui-color-neutral-900)')
  })

  it('drops a value that could break out of its declaration', () => {
    const css = themeDocToCss({
      version: 1,
      tokens: { light: { '--ui-bg': 'red; } body { display: none', '--ui-text': 'black' } },
      font: { sans: "Inter'; } </style><script>" },
      palettes: {
        'x;y': { shades: { 500: '#fff' } },
        ok: { shades: { 500: 'url(x)', 600: '#abc' } },
      },
    })
    expect(css).not.toContain('display')
    expect(css).not.toContain('<')
    expect(css).not.toContain('x;y')
    expect(css).not.toContain('url(')
    expect(css).toContain('--ui-text: black;')
    expect(css).toContain('--color-ok-600: #abc;')
  })

  it('applies blackAsPrimary at the same precedence in both modes', () => {
    const tokens = docModeTokens({
      version: 1,
      blackAsPrimary: true,
      style: { tokenShades: { '--ui-primary': { light: 600, dark: 600 } } },
    })
    // The style sets a --ui-primary shade in both modes; blackAsPrimary is the coarser control and
    // wins in BOTH (the old code let the light style shade suppress it, so light disagreed).
    expect(tokens.light['--ui-primary']).toBe('black')
    expect(tokens.dark['--ui-primary']).toBe('white')
  })

  it('lets an explicit token beat blackAsPrimary in both modes', () => {
    const tokens = docModeTokens({
      version: 1,
      blackAsPrimary: true,
      tokens: {
        light: { '--ui-primary': 'var(--custom-l)' },
        dark: { '--ui-primary': 'var(--custom-d)' },
      },
    })
    expect(tokens.light['--ui-primary']).toBe('var(--custom-l)')
    expect(tokens.dark['--ui-primary']).toBe('var(--custom-d)')
  })

  it('accepts a plain palette name and rejects one that could break out of CSS', () => {
    expect(isSafePaletteName('green')).toBe(true)
    expect(isSafePaletteName('brand-1')).toBe(true)
    expect(isSafePaletteName('red; } body { display: none')).toBe(false)
    expect(isSafePaletteName('__proto__')).toBe(false)
    expect(isSafePaletteName(undefined)).toBe(false)
  })
})
