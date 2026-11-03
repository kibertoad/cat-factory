import { sharedOverlayStack } from '@modular-vue/core'
import { trackForeignLayers } from '~/utils/foreignLayers'

// Put every open Nuxt UI menu, select, popover and modal on the shared overlay stack, so the
// takeover or window under it leaves Escape and Tab to it. Why: `utils/foreignLayers.ts`.
export default defineNuxtPlugin(() => {
  trackForeignLayers(document.body, sharedOverlayStack)
})
