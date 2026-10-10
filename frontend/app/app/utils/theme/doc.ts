/**
 * The theme document: the sparse `ThemeDoc` the Nuxt UI theme editor (https://ui.nuxt.com/theme)
 * edits and shares as a `?doc=` link. The app speaks THAT format rather than one of its own, so a
 * theme built in the editor is importable as-is and a built-in theme is a document a user could
 * have exported. Everything absent inherits the Nuxt UI defaults, so an empty document IS the
 * stock library theme.
 *
 * The tables and the two expansions (`styleTokens`, `styleComponents`) are ported from the editor
 * engine (`docs/app/utils/theme/engine/types.ts` in nuxt/ui, MIT). They are kept byte-compatible in
 * MEANING with the editor's export, because the promise to the user is "what you saw in the editor
 * is what the app renders". Fields the app does not act on (`icons`, `font.weights`, the body
 * typography flags) are typed so an imported document round-trips unchanged, and ignored on apply.
 */

export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type Shade = (typeof SHADES)[number]
export type ShadeStop = 'white' | Shade | 'black'

export type ColorAlias =
  | 'primary'
  | 'secondary'
  | 'success'
  | 'info'
  | 'warning'
  | 'error'
  | 'neutral'

export const COLOR_ALIASES: readonly ColorAlias[] = [
  'primary',
  'secondary',
  'success',
  'info',
  'warning',
  'error',
  'neutral',
]

export interface ThemePalette {
  shades: Partial<Record<Shade, string>>
}

export type DefaultVariant =
  | 'default'
  | 'solid'
  | 'outline'
  | 'soft'
  | 'subtle'
  | 'ghost'
  | 'link'
  | 'none'
export type DefaultSize = 'default' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type DefaultColor = 'default' | ColorAlias
export type VariantGroup = 'buttons' | 'panels' | 'inputs'

export interface StyleOptions {
  defaults?: {
    variant?: DefaultVariant
    size?: DefaultSize
    variants?: Partial<Record<VariantGroup, DefaultVariant>>
    colors?: Partial<Record<VariantGroup, DefaultColor>>
  }
  /** Semantic token → ramp shade per mode; keys whitelisted in `TOKEN_SHADE_TARGETS`. */
  tokenShades?: Record<string, { light?: ShadeStop; dark?: ShadeStop }>
}

export interface ThemeDoc {
  version: 1
  /** Custom palettes, injected as `--color-{name}-{shade}`. */
  palettes?: Record<string, ThemePalette>
  /** Alias → palette name (a Tailwind colour or a key of `palettes`). */
  colors?: Partial<Record<ColorAlias, string>>
  blackAsPrimary?: boolean
  /** Explicit `--ui-*` (or any `--*`) token overrides per mode. */
  tokens?: {
    light?: Record<string, string>
    dark?: Record<string, string>
  }
  radius?: number
  /** Root font size in px. */
  fontSize?: number
  font?: {
    sans?: string
    serif?: string
    mono?: string
    weights?: { normal?: number; medium?: number; semibold?: number; bold?: number }
    uppercase?: boolean
    italic?: boolean
    letterSpacing?: number
    lineHeight?: number
  }
  icons?: string
  style?: StyleOptions
  /** Per-component overrides merged into `app.config` `ui.<component>`. */
  components?: Record<string, Record<string, unknown>>
}

/** A editor link's document. `preset` is the short form for an untouched preset. */
export type ThemeLink = ThemeDoc & { preset?: string }

export const DEFAULT_COLORS: Record<ColorAlias, string> = {
  primary: 'green',
  secondary: 'blue',
  success: 'green',
  info: 'blue',
  warning: 'yellow',
  error: 'red',
  neutral: 'slate',
}

export const THEME_DEFAULTS = { radius: 0.25, fontSize: 16, font: 'Public Sans' } as const

/* ---------------------------------------------------------------- style -- */

const FIELD_VARIANTS = ['outline', 'soft', 'subtle', 'ghost', 'none']
const FIELD_COMPONENTS = [
  'input',
  'select',
  'textarea',
  'selectMenu',
  'inputMenu',
  'inputNumber',
  'inputTags',
  'inputDate',
  'inputTime',
  'pinInput',
]

/** Which components support which default variant values. */
export const VARIANT_SUPPORT: Record<string, string[]> = {
  button: ['solid', 'outline', 'soft', 'subtle', 'ghost', 'link'],
  badge: ['solid', 'outline', 'soft', 'subtle'],
  alert: ['solid', 'outline', 'soft', 'subtle'],
  card: ['solid', 'outline', 'soft', 'subtle'],
  empty: ['solid', 'outline', 'soft', 'subtle'],
  ...Object.fromEntries(FIELD_COMPONENTS.map((component) => [component, FIELD_VARIANTS])),
}

/** Components the app-wide size default scales (exactly the xs–xl axis). */
export const SIZE_SUPPORT = [
  'button',
  'badge',
  ...FIELD_COMPONENTS,
  'inputRating',
  'tabs',
  'checkbox',
  'checkboxGroup',
  'radioGroup',
  'switch',
  'slider',
  'stepper',
  'calendar',
  'colorPicker',
  'fileUpload',
  'formField',
  'fieldGroup',
  'dropdownMenu',
  'contextMenu',
  'commandPalette',
  'listbox',
]

/** Components with a colour prop; the panels group has no colour axis. */
export const COLOR_SUPPORT = ['button', 'badge', ...FIELD_COMPONENTS]

export const VARIANT_GROUPS: Record<VariantGroup, string[]> = {
  buttons: ['button', 'badge'],
  panels: ['card', 'alert', 'empty'],
  inputs: FIELD_COMPONENTS,
}

export type TokenRamp = ColorAlias

/**
 * The semantic tokens the editor exposes as shade sliders, with the LIBRARY's resting values.
 * Some rest on a literal ladder end (light `--ui-bg` is `white`, not a ramp stop).
 */
export const TOKEN_SHADE_TARGETS: ReadonlyArray<{
  token: string
  ramp: TokenRamp
  defaults: { light: ShadeStop; dark: ShadeStop }
}> = [
  { token: '--ui-primary', ramp: 'primary', defaults: { light: 500, dark: 400 } },
  { token: '--ui-secondary', ramp: 'secondary', defaults: { light: 500, dark: 400 } },
  { token: '--ui-success', ramp: 'success', defaults: { light: 500, dark: 400 } },
  { token: '--ui-info', ramp: 'info', defaults: { light: 500, dark: 400 } },
  { token: '--ui-warning', ramp: 'warning', defaults: { light: 500, dark: 400 } },
  { token: '--ui-error', ramp: 'error', defaults: { light: 500, dark: 400 } },
  { token: '--ui-bg', ramp: 'neutral', defaults: { light: 'white', dark: 900 } },
  { token: '--ui-bg-muted', ramp: 'neutral', defaults: { light: 50, dark: 800 } },
  { token: '--ui-bg-elevated', ramp: 'neutral', defaults: { light: 100, dark: 800 } },
  { token: '--ui-bg-accented', ramp: 'neutral', defaults: { light: 200, dark: 700 } },
  { token: '--ui-bg-inverted', ramp: 'neutral', defaults: { light: 900, dark: 'white' } },
  { token: '--ui-text-dimmed', ramp: 'neutral', defaults: { light: 400, dark: 500 } },
  { token: '--ui-text-muted', ramp: 'neutral', defaults: { light: 500, dark: 400 } },
  { token: '--ui-text-toned', ramp: 'neutral', defaults: { light: 600, dark: 300 } },
  { token: '--ui-text', ramp: 'neutral', defaults: { light: 700, dark: 200 } },
  { token: '--ui-text-highlighted', ramp: 'neutral', defaults: { light: 900, dark: 'white' } },
  { token: '--ui-text-inverted', ramp: 'neutral', defaults: { light: 'white', dark: 900 } },
  { token: '--ui-border', ramp: 'neutral', defaults: { light: 200, dark: 800 } },
  { token: '--ui-border-muted', ramp: 'neutral', defaults: { light: 200, dark: 700 } },
  { token: '--ui-border-accented', ramp: 'neutral', defaults: { light: 300, dark: 700 } },
  { token: '--ui-border-inverted', ramp: 'neutral', defaults: { light: 900, dark: 'white' } },
]

/** The stop closest to a value, where an off-ladder shade reference lands. */
export function nearestShade(value: number): Shade {
  return SHADES.reduce((best, stop) =>
    Math.abs(stop - value) < Math.abs(best - value) ? stop : best,
  )
}

/** A ramp shade reference, or the literal for white/black. */
export function shadeRef(ramp: string, stop: ShadeStop | number): string {
  if (stop === 'white' || stop === 'black') return stop
  return `var(--ui-color-${ramp}-${nearestShade(stop)})`
}

export interface ModeTokens {
  light: Record<string, string>
  dark: Record<string, string>
}

/** Semantic token shades: the only CSS variables a style choice emits. */
export function styleTokens(style: StyleOptions | undefined): ModeTokens {
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const [token, shade] of Object.entries(style?.tokenShades ?? {})) {
    const target = TOKEN_SHADE_TARGETS.find((candidate) => candidate.token === token)
    if (!target || !shade) continue
    if (shade.light !== undefined) light[token] = shadeRef(target.ramp, shade.light)
    if (shade.dark !== undefined) dark[token] = shadeRef(target.ramp, shade.dark)
  }
  return { light, dark }
}

export type ComponentOverrides = Record<string, Record<string, unknown>>

type DefaultVariants = Record<string, string>

function withDefaultVariants(
  fragments: ComponentOverrides,
  component: string,
  patch: DefaultVariants,
): void {
  const current = fragments[component]?.defaultVariants as DefaultVariants | undefined
  fragments[component] = {
    ...fragments[component],
    defaultVariants: { ...current, ...patch },
  }
}

/** Expand the default variant/size/colour choices into `ui.<component>.defaultVariants`. */
export function styleComponents(style: StyleOptions | undefined): ComponentOverrides {
  const fragments: ComponentOverrides = {}
  const defaults = style?.defaults
  if (!defaults) return fragments

  const set = (value?: string): value is string => !!value && value !== 'default'

  if (set(defaults.variant)) {
    for (const [component, supported] of Object.entries(VARIANT_SUPPORT)) {
      if (supported.includes(defaults.variant)) {
        withDefaultVariants(fragments, component, { variant: defaults.variant })
      }
    }
  }
  for (const [group, components] of Object.entries(VARIANT_GROUPS) as Array<
    [VariantGroup, string[]]
  >) {
    const groupVariant = defaults.variants?.[group]
    if (set(groupVariant)) {
      for (const component of components) {
        if (VARIANT_SUPPORT[component]?.includes(groupVariant)) {
          withDefaultVariants(fragments, component, { variant: groupVariant })
        }
      }
    }
    const groupColor = defaults.colors?.[group]
    if (set(groupColor)) {
      for (const component of components) {
        if (COLOR_SUPPORT.includes(component)) {
          withDefaultVariants(fragments, component, { color: groupColor })
        }
      }
    }
  }
  if (set(defaults.size)) {
    for (const component of SIZE_SUPPORT) {
      withDefaultVariants(fragments, component, { size: defaults.size })
    }
  }
  return fragments
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge two `ui.<component>` override fragments so BOTH take effect: slot class strings
 * concatenate (extra last, so it wins the tailwind-merge), `compoundVariants` append,
 * `defaultVariants` replace per key. A spread would silently drop whichever side loses.
 */
export function mergeComponentOverrides(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base || Object.keys(base).length === 0) return extra
  if (!extra || Object.keys(extra).length === 0) return base
  const result: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    const a = base[key]
    const b = extra[key]
    if (a === undefined) result[key] = b
    else if (b === undefined) result[key] = a
    else if (key === 'compoundVariants' && Array.isArray(a) && Array.isArray(b))
      result[key] = [...a, ...b]
    else if (key === 'defaultVariants' && isPlainObject(a) && isPlainObject(b))
      result[key] = { ...a, ...b }
    else if (typeof a === 'string' && typeof b === 'string') result[key] = `${a} ${b}`
    else if (isPlainObject(a) && isPlainObject(b)) result[key] = mergeComponentOverrides(a, b)
    else result[key] = b
  }
  return result
}

/** Merge two whole `ui` records component-wise. */
export function mergeUi(
  base: ComponentOverrides | undefined,
  extra: ComponentOverrides | undefined,
): ComponentOverrides {
  const result: ComponentOverrides = {}
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(extra ?? {})])) {
    const merged = mergeComponentOverrides(base?.[key], extra?.[key])
    if (merged && Object.keys(merged).length > 0) result[key] = merged
  }
  return result
}

/** The `ui.<component>` overrides a document asks for: its style expansion plus explicit ones. */
export function docComponentOverrides(doc: ThemeDoc): ComponentOverrides {
  return mergeUi(styleComponents(doc.style), doc.components)
}

/** The alias → palette map a document resolves to, defaults filled in. */
export function docColors(doc: ThemeDoc): Record<ColorAlias, string> {
  const colors = { ...DEFAULT_COLORS }
  for (const alias of COLOR_ALIASES) {
    const palette = doc.colors?.[alias]
    if (palette) colors[alias] = palette
  }
  return colors
}
