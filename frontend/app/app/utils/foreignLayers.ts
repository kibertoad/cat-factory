// Nuxt UI layers on the shared overlay stack.
//
// Two layer stacks run in this app. `useModalBehavior` (`TakeoverShell`, `ResultWindowShell`, the
// modular overlays) keeps `sharedOverlayStack`; Reka, under every Nuxt UI menu, select, popover
// and modal, keeps its own. Each one only knows its own layers, so a dropdown opened inside a
// takeover lost Escape: the shell handles the key first, in the capture phase, and calls
// `preventDefault()`, and Reka then leaves a prevented Escape alone. The takeover closed and the
// dropdown stayed.
//
// The fix is ONE stack. While a Reka layer is open it holds a ticket, pushed in open order, so
// it is the top overlay and `useModalBehavior` stands down: no Escape, no Tab trap. Reka then
// handles its own keys. Only the stack's own API is used here (`push`, `release`); what is
// Reka-specific is the selector.

import type { OverlayStack, OverlayStackTicket } from '@modular-vue/core'

/**
 * An open Reka layer that takes focus and owns its keys. Reka marks every layer with
 * `data-dismissable-layer`, and the role is on the same element: `menu` (dropdown menu), `listbox`
 * (select), `dialog` (popover, modal), `alertdialog`. A tooltip is a layer too, but it has no
 * role, so it never takes a ticket: focus stays on its trigger, and a ticket would switch off the
 * Tab trap under it. `data-state="closed"` is a layer playing its exit animation.
 */
export const FOREIGN_LAYER_SELECTOR =
  '[data-dismissable-layer]:is([role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"]):not([data-state="closed"])'

const ANY_LAYER = '[data-dismissable-layer]'

/**
 * Hold one `stack` ticket for each open layer under `root`, for as long as it is open. Returns the
 * function that stops tracking and releases every ticket.
 *
 * What is observed is kept narrow, because `root` is `<body>` and the board re-renders under it
 * constantly. Reka teleports each layer to `<body>`, so an opening or a closing is a change to
 * `root`'s DIRECT children, which a non-subtree `childList` observer sees without ever being
 * told about a board patch. A layer's own exit animation is its `data-state` flipping to
 * `closed`, which the attribute observer sees; it is filtered to that one attribute and then to
 * records whose target is a layer. Only those records trigger the one `sync` query.
 */
export function trackForeignLayers(root: HTMLElement, stack: OverlayStack): () => void {
  const tickets = new Map<Element, OverlayStackTicket>()

  function sync(): void {
    const open = new Set(root.querySelectorAll(FOREIGN_LAYER_SELECTOR))
    for (const [layer, ticket] of tickets) {
      if (open.has(layer)) continue
      ticket.release()
      tickets.delete(layer)
    }
    // Document order is open order: Reka appends each layer's portal to the end of `<body>`.
    for (const layer of open) {
      if (!tickets.has(layer)) tickets.set(layer, stack.push())
    }
  }

  const portals = new MutationObserver(sync)
  portals.observe(root, { childList: true })

  const layerState = new MutationObserver((records) => {
    if (records.some((r) => r.target instanceof Element && r.target.matches(ANY_LAYER))) sync()
  })
  layerState.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
  sync()

  return () => {
    portals.disconnect()
    layerState.disconnect()
    for (const ticket of tickets.values()) ticket.release()
    tickets.clear()
  }
}
