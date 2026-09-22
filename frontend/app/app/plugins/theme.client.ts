import { computed, nextTick, ref, toRaw, watch } from 'vue'
import { useThemeStore } from '~/stores/theme'
import { captureBootPalette, writeBootPalette } from '~/utils/theme/bootPalette'
import { isSafePaletteName, themeDocToCss } from '~/utils/theme/css'
import {
  COLOR_ALIASES,
  DEFAULT_COLORS,
  docColors,
  docComponentOverrides,
  mergeUi,
  type ComponentOverrides,
  type ThemeDoc,
} from '~/utils/theme/doc'

/**
 * Applies the active theme document to the running app, the runtime twin of pasting the editor's
 * `main.css` + `app.config.ts` export into the source tree:
 *
 * - the alias → palette map lands on `appConfig.ui.colors`, which Nuxt UI's own colours plugin
 *   watches and re-emits as the `--ui-color-<alias>-<shade>` ramps (so every role token, every
 *   bare `text-primary`, and the app's `--app-*` tokens follow with no work here);
 * - the default-variant expansion and explicit component overrides land on `appConfig.ui.<comp>`,
 *   merged INTO the layer's own overrides from `app.config.ts` (the modal / slideover / toaster
 *   slots) rather than over them, and reset when the next theme no longer touches a component;
 * - everything that is a CSS variable rides one `<style id="app-theme">` in the head plus a
 *   `data-theme` attribute on `<html>` the stylesheet's selectors anchor on (see `css.ts`).
 *
 * Runs client-only because the SPA is `ssr: false` and the document lives in browser storage.
 */

type UiConfig = Record<string, unknown> & { colors: Record<string, string> }

export default defineNuxtPlugin(() => {
  const store = useThemeStore()
  const appConfig = useAppConfig()
  const ui = appConfig.ui as unknown as UiConfig

  // The layer's own overrides, snapshotted ONCE before any theme touches them: they are the base
  // every theme merges into, and the value a component returns to when a theme stops naming it.
  const baseUi: ComponentOverrides = {}
  for (const [key, value] of Object.entries(toRaw(ui))) {
    if (key !== 'colors' && typeof value === 'object' && value !== null) {
      baseUi[key] = structuredClone(toRaw(value)) as Record<string, unknown>
    }
  }
  let themedKeys = new Set<string>()

  function apply(doc: ThemeDoc) {
    // `docColors` fills defaults but passes a document's own alias values through untouched, and
    // Nuxt UI interpolates each into `--ui-color-<alias>-<shade>: var(--color-<value>-<shade>)`, so
    // an imported document's value has to clear the same grammar as any token that reaches CSS.
    const colors = docColors(doc)
    for (const alias of COLOR_ALIASES) {
      const value = colors[alias]
      ui.colors[alias] = isSafePaletteName(value) ? value : DEFAULT_COLORS[alias]
    }

    const overrides = docComponentOverrides(doc)
    const next = new Set(Object.keys(overrides))
    for (const key of themedKeys) {
      if (next.has(key)) continue
      if (key in baseUi) ui[key] = structuredClone(baseUi[key])
      else delete ui[key]
    }
    const merged = mergeUi(
      Object.fromEntries([...next].map((key) => [key, baseUi[key]]).filter(([, v]) => v)),
      overrides,
    )
    for (const key of next) ui[key] = merged[key]
    themedKeys = next
  }

  const css = computed(() => themeDocToCss(store.active.doc))
  useHead({
    htmlAttrs: { 'data-theme': computed(() => store.active.id) },
    style: [{ id: 'app-theme', innerHTML: css }],
  })

  watch(() => store.active.doc, apply, { immediate: true })

  // The browser chrome and the loading shell's cache both want the COMPUTED canvas colour, which
  // exists only after unhead has written the theme style and Nuxt UI's colour ramps into the DOM.
  // That moment is unhead's own `dom:rendered` hook (the same one Nuxt UI's colours plugin uses),
  // so the capture runs there rather than after a tick or a frame: a tick is too early, and a
  // hidden tab never gets a frame. `getComputedStyle` flushes style itself.
  //
  // The chrome rides `useHead` too: unhead dedupes a `theme-color` meta by name AND media, so this
  // pair (same media as the first-paint pair in `nuxt.config.ts`, no key) overrides those two tags
  // with the live colour, whichever the OS scheme selects, and unhead never re-renders a stale
  // value over a hand-edited tag.
  const colorMode = useColorMode()
  const chrome = ref<string | null>(null)
  useHead({
    meta: [
      {
        name: 'theme-color',
        media: '(prefers-color-scheme: dark)',
        // The first-paint fallbacks, the same two values `nuxt.config.ts` ships.
        content: computed(() => chrome.value ?? '#020618'), // colour-literal-ok: first paint
      },
      {
        name: 'theme-color',
        media: '(prefers-color-scheme: light)',
        content: computed(() => chrome.value ?? '#e2e8f0'), // colour-literal-ok: first paint
      },
    ],
  })
  function recordBootColours() {
    const mode = colorMode.value
    if (mode !== 'light' && mode !== 'dark') return
    const entry = captureBootPalette()
    if (!entry) return
    writeBootPalette(store.active.id, mode, entry)
    chrome.value = entry.bg
  }
  injectHead()?.hooks?.hook('dom:rendered', recordBootColours)
  watch(
    () => [store.active.id, colorMode.value] as const,
    async () => {
      await nextTick()
      recordBootColours()
    },
    { immediate: true },
  )
})
