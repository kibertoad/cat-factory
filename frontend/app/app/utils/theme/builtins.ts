import { THEME_DEFAULTS, type ThemeDoc } from '~/utils/theme/doc'
import { presets } from '~/utils/theme/presets'

/**
 * A theme the switcher offers: a editor document under a display name. Built-ins and the user's
 * imported themes share this shape, so the switcher, the store and the applier never branch on
 * where a theme came from.
 */
export interface NamedTheme {
  id: string
  /** A proper noun (a theme's name is data the way a locale's `name` is), not an i18n key. */
  name: string
  doc: ThemeDoc
}

export const DEFAULT_THEME_ID = 'cat-factory'

/**
 * The app's own theme, stated as the document a user could have exported from the editor. It MUST
 * agree with `app.config.ts`'s `ui.colors`: that block is what the very first paint renders from,
 * before the theme plugin runs, and a disagreement would flash one palette and settle on another.
 * `theme.builtins.spec.ts` pins the equality.
 *
 * Status hues are the app's long-standing choices (amber for warning, rose for error, emerald
 * for success, sky for info, violet for the secondary accent), named here as aliases so a theme
 * that recolours `warning` recolours every warning surface.
 *
 * `radius` is stated even though it equals `THEME_DEFAULTS.radius`, so the value every surface in
 * the app derives from has one visible home. It writes no CSS at that value (`css.ts` skips a
 * default), which is the point: changing the number here is the whole edit, and Nuxt UI's
 * `--radius-*` scale carries it to every `rounded-*` step (issue #2251).
 */
export const CAT_FACTORY_THEME: NamedTheme = {
  id: DEFAULT_THEME_ID,
  name: 'Cat Factory',
  doc: {
    version: 1,
    radius: THEME_DEFAULTS.radius,
    colors: {
      primary: 'indigo',
      secondary: 'violet',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
      neutral: 'slate',
    },
  },
}

/**
 * The editor's own Mono preset (black on a pure grey neutral, generous radius, Geist), taken from
 * the preset table rather than copied, so it stays whatever the editor ships. Its faces are
 * self-hosted in `nuxt.config.ts` (`fonts.families`); `builtins.spec.ts` pins that.
 */
const monoPreset = presets.find((preset) => preset.id === 'mono')
if (!monoPreset) throw new Error('the editor preset table has no "mono" entry')

export const MONO_THEME: NamedTheme = { id: 'mono', name: monoPreset.name, doc: monoPreset.doc }

export const BUILTIN_THEMES: readonly NamedTheme[] = [CAT_FACTORY_THEME, MONO_THEME]
