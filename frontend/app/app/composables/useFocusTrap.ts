import { nextTick, onScopeDispose, watch, type Ref } from 'vue'

/**
 * Lightweight focus management for a modal surface (the screenshot review windows + the
 * shared lightbox). While `active`, it:
 *   · moves focus into the container on open (so keyboard / screen-reader users land inside
 *     the dialog instead of staying on the background),
 *   · traps Tab / Shift+Tab within the container's focusable elements, and
 *   · restores focus to whatever was focused before, on close.
 *
 * Nested surfaces (a lightbox opened over a review window) hand off cleanly because each
 * caller scopes its own `active` — the window passes `open && !lightboxOpen`, so exactly one
 * trap is live at a time and they never fight over Tab.
 */
export function useFocusTrap(container: Ref<HTMLElement | null>, active: Ref<boolean>): void {
  let previouslyFocused: HTMLElement | null = null

  function focusables(): HTMLElement[] {
    const root = container.value
    if (!root) return []
    const nodes = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    // Skip elements that aren't actually rendered (e.g. inside a `v-if`/`hidden` branch).
    return Array.from(nodes).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!active.value || e.key !== 'Tab') return
    const els = focusables()
    if (!els.length) {
      e.preventDefault()
      container.value?.focus()
      return
    }
    const first = els[0]!
    const last = els[els.length - 1]!
    const current = document.activeElement as HTMLElement | null
    const inside = !!container.value?.contains(current)
    if (e.shiftKey) {
      if (!inside || current === first) {
        e.preventDefault()
        last.focus()
      }
    } else if (!inside || current === last) {
      e.preventDefault()
      first.focus()
    }
  }

  watch(
    active,
    (on) => {
      if (on) {
        previouslyFocused = document.activeElement as HTMLElement | null
        window.addEventListener('keydown', onKeydown, true)
        void nextTick(() => {
          ;(focusables()[0] ?? container.value)?.focus()
        })
      } else {
        window.removeEventListener('keydown', onKeydown, true)
        previouslyFocused?.focus?.()
        previouslyFocused = null
      }
    },
    { immediate: true },
  )

  onScopeDispose(() => window.removeEventListener('keydown', onKeydown, true))
}
