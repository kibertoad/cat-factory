import { computed, ref, watch } from 'vue'

/**
 * Keeps the browser chrome (the mobile address bar, the desktop title bar where the browser
 * honours `theme-color`) on the app's canvas colour. The two first-paint metas in `nuxt.config.ts`
 * follow the OS scheme through media queries; the app's mode can differ from the OS (a dark app on
 * a light desktop), so once the app runs this pair, same media and no key, overrides both tags with
 * the computed `--app-bg-canvas` (unhead dedupes a `theme-color` meta by name AND media).
 *
 * The capture runs on unhead's own `dom:rendered` hook: the moment the colour-mode class and every
 * head style have landed. A tick is too early and a hidden tab never gets an animation frame.
 * `getComputedStyle` flushes style itself. Client-only: the SPA is `ssr: false`.
 */
export default defineNuxtPlugin(() => {
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

  function tint() {
    const probe = document.createElement('div')
    probe.style.color = 'var(--app-bg-canvas)'
    document.documentElement.appendChild(probe)
    const canvas = getComputedStyle(probe).color
    probe.remove()
    if (canvas) chrome.value = canvas
  }
  injectHead()?.hooks?.hook('dom:rendered', tint)
  watch(() => colorMode.value, tint, { flush: 'post' })
})
