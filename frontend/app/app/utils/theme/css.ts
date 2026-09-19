import {
  THEME_DEFAULTS,
  styleTokens,
  type ModeTokens,
  type ThemeDoc,
  type ThemePalette,
} from '~/utils/theme/doc'

/**
 * A theme document as the stylesheet the app injects at runtime (the `<style id="app-theme">` the
 * theme plugin owns). This is the runtime twin of the editor's `main.css` export: the same
 * variables, but scoped so they win without depending on source order.
 *
 * Every rule is anchored on `:root[data-theme]`, the attribute the plugin sets on `<html>`. That
 * gives each block a specificity the library's own `@layer theme` rules AND `main.css`'s unlayered
 * `.dark {}` blocks cannot reach: light values ride `:root[data-theme]` (0,2,0), dark values
 * `:root[data-theme].dark` (0,3,0), so dark wins whenever the colour-mode class is present and the
 * editor's "restate the library's dark value" workaround is unnecessary. It also means a theme can
 * override the app's own `--app-*` tokens (declared in `main.css` on `.dark`) with no ordering
 * game.
 *
 * Values are the WRITE BOUNDARY for untrusted input: an imported document ends up concatenated into
 * a stylesheet, so every character class below excludes `;`, `}` and `<`, which is what keeps a
 * value from ending its declaration early or closing the tag. A rejected value is dropped, never
 * escaped: a half-applied theme is visible, a corrupted stylesheet is not.
 */

const SAFE_CSS_VAR_KEY = /^--[\w-]+$/
const OKLCH_NUMBER = String.raw`\d+(?:\.\d+)?|\.\d+`
const SAFE_OKLCH = new RegExp(
  String.raw`^oklch\(\s*(?:${OKLCH_NUMBER})%?\s+(?:${OKLCH_NUMBER}|none)\s+(?:(?:${OKLCH_NUMBER})(?:deg)?|none)\s*\)$`,
  'i',
)
const SAFE_HEX = /^#[0-9a-f]{3,8}$/i
// var() refs, hex, keywords, px/% lengths and literal oklch()/rgb() colours.
const SAFE_CSS_VAR_VALUE =
  /^(?:var\(--[\w-]+\)|#[0-9a-f]{3,8}|[a-z]+|-?\d{1,3}(?:\.\d+)?(?:px|%|rem)|oklch\([\w.% -]{1,40}\)|rgba?\([\d.%, /]{1,40}\))$/i
const SAFE_PALETTE_NAME = /^[\w-]{1,50}$/
const SAFE_FONT_NAME = /^[\w -]{1,50}$/
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isSafeCssVarKey(key: string): boolean {
  return SAFE_CSS_VAR_KEY.test(key) && !UNSAFE_KEYS.has(key.slice(2))
}

export function isSafeCssVarValue(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CSS_VAR_VALUE.test(value)
}

export function isSafeShadeValue(value: unknown): value is string {
  return typeof value === 'string' && (SAFE_OKLCH.test(value) || SAFE_HEX.test(value))
}

export function isSafeFontName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_FONT_NAME.test(value)
}

function cleanVars(vars: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (isSafeCssVarKey(key) && isSafeCssVarValue(value)) result[key] = value
  }
  return result
}

/** The per-mode variable set a document resolves to: style shades first, explicit tokens win. */
export function docModeTokens(doc: ThemeDoc): ModeTokens {
  const style = styleTokens(doc.style)
  const light = { ...style.light, ...cleanVars(doc.tokens?.light) }
  const dark = {
    ...style.dark,
    ...(doc.blackAsPrimary ? { '--ui-primary': 'white' } : {}),
    ...cleanVars(doc.tokens?.dark),
  }
  if (doc.blackAsPrimary && !('--ui-primary' in light)) light['--ui-primary'] = 'black'
  return { light, dark }
}

function paletteLines(name: string, palette: ThemePalette): string[] {
  if (!SAFE_PALETTE_NAME.test(name) || UNSAFE_KEYS.has(name)) return []
  return Object.entries(palette.shades ?? {})
    .filter(([shade, value]) => /^\d{2,3}$/.test(shade) && isSafeShadeValue(value))
    .map(([shade, value]) => `  --color-${name}-${shade}: ${value};`)
}

function block(selector: string, lines: string[]): string[] {
  return lines.length > 0 ? [`${selector} {`, ...lines, '}'] : []
}

function declarations(vars: Record<string, string>): string[] {
  return Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`)
}

/**
 * The stylesheet for a document. Empty for an empty document, so the stock library theme injects
 * nothing at all.
 */
export function themeDocToCss(doc: ThemeDoc): string {
  const root: string[] = []

  // Custom palettes ride the runtime colours plugin's fallback: it emits
  // `var(--color-<name>-<shade>, <tailwind literal>)` for every alias, so declaring the ramp as a
  // real custom property on the root is enough for the alias to pick it up.
  for (const [name, palette] of Object.entries(doc.palettes ?? {})) {
    root.push(...paletteLines(name, palette))
  }
  if (doc.radius !== undefined && doc.radius !== THEME_DEFAULTS.radius && isFinite(doc.radius)) {
    root.push(`  --ui-radius: ${doc.radius}rem;`)
  }
  // Tailwind's `--font-*` theme variables are live custom properties (`font-sans` compiles to
  // `var(--font-sans)`, and preflight's body family derives from it), so a root override reaches
  // every utility and the classless body alike. The FACE is the deployment's to provide: this
  // names the family and lets the browser fall back when it is not installed or self-hosted.
  if (isSafeFontName(doc.font?.sans) && doc.font.sans !== THEME_DEFAULTS.font) {
    root.push(`  --font-sans: '${doc.font.sans}', ui-sans-serif, system-ui, sans-serif;`)
  }
  if (isSafeFontName(doc.font?.serif)) {
    root.push(`  --font-serif: '${doc.font.serif}', ui-serif, serif;`)
  }
  if (isSafeFontName(doc.font?.mono)) {
    root.push(`  --font-mono: '${doc.font.mono}', ui-monospace, monospace;`)
  }
  for (const step of ['normal', 'medium', 'semibold', 'bold'] as const) {
    const weight = doc.font?.weights?.[step]
    if (typeof weight === 'number' && weight >= 100 && weight <= 900) {
      root.push(`  --font-weight-${step}: ${weight};`)
    }
  }

  const tokens = docModeTokens(doc)
  const lines = [
    ...block(':root[data-theme]', root),
    ...block(':root[data-theme]', declarations(tokens.light)),
    ...block(':root[data-theme].dark', declarations(tokens.dark)),
  ]
  if (
    doc.fontSize !== undefined &&
    doc.fontSize !== THEME_DEFAULTS.fontSize &&
    doc.fontSize >= 8 &&
    doc.fontSize <= 32
  ) {
    lines.push(`html[data-theme] { font-size: ${doc.fontSize}px; }`)
  }
  return lines.join('\n')
}
