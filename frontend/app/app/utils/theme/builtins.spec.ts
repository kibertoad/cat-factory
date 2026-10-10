import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_THEMES, CAT_FACTORY_THEME, DEFAULT_THEME_ID } from '~/utils/theme/builtins'

// `app.config.ts` / `nuxt.config.ts` call Nuxt's auto-imported define helpers; under plain Vitest
// each is an identity function.
vi.stubGlobal('defineAppConfig', <T>(config: T) => config)
vi.stubGlobal('defineNuxtConfig', <T>(config: T) => config)

describe('built-in themes', () => {
  it('states the default theme as exactly what app.config.ts paints the first frame with', async () => {
    // A disagreement would flash one palette and settle on another: the theme plugin applies the
    // document AFTER Nuxt UI's colours plugin has already emitted the ramps from `app.config`.
    const appConfig = (await import('~/app.config')).default as {
      ui: { colors: Record<string, string> }
    }
    expect(CAT_FACTORY_THEME.doc.colors).toEqual(appConfig.ui.colors)
  })

  it('self-hosts every face a built-in theme names', async () => {
    // The theme plugin sets the family at runtime, which `@nuxt/fonts`' CSS scan cannot see, so the
    // face must be listed in `fonts.families` or the built-in renders in the browser's fallback.
    const nuxtConfig = (await import('../../../nuxt.config')).default as {
      fonts: { families: Array<{ name: string }> }
    }
    const hosted = new Set(nuxtConfig.fonts.families.map((family) => family.name))
    for (const theme of BUILTIN_THEMES) {
      for (const face of Object.values(theme.doc.font ?? {})) {
        if (typeof face === 'string') expect(hosted, `${theme.id} names ${face}`).toContain(face)
      }
    }
  })

  it('has unique ids and names the default among them', () => {
    const ids = BUILTIN_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_THEME_ID)
  })
})
