import { computed } from 'vue'

/**
 * The public seam a consumer deployment uses to open its own top-level overlays (extension
 * slice D — the frontend-extension-mechanism initiative). A deployment contributes an overlay
 * component to the `appOverlays` slot (`{ id: '<ns>:<name>', component }`) and opens it from a
 * nav item's `run` closure (or any consumer code) with `useAppOverlays().open('<ns>:<name>')`.
 * The single `<AppOverlayHost>` in `pages/index.vue` resolves the slot and mounts the matching
 * component, handing it the optional `subject`.
 *
 * This is a thin, auto-imported wrapper over the `ui` store's overlay pointer so a consumer
 * never has to reach into the layer's Pinia stores directly — the same decoupling the rest of
 * the consumer surface follows (auto-imported composables + `#components`, no deep layer
 * imports). Opening a second overlay replaces the first (a pick-one host).
 */
export function useAppOverlays() {
  const ui = useUiStore()
  return {
    /** The active consumer overlay (`{ id, subject? }`) or null when none is open. */
    active: computed(() => ui.activeOverlay),
    /** Open the `appOverlays`-slot overlay with this id, optionally passing it a subject. */
    open: (id: string, subject?: unknown) => ui.openOverlay(id, subject),
    /** Close the active consumer overlay. */
    close: () => ui.closeOverlay(),
  }
}
