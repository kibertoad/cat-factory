---
'@cat-factory/app': patch
---

Stop the toaster's safe-area rule from slicing the first option off every dropdown.

The inspector's pickers (service connections, and every other menu in the SPA) drew their first
option half outside the popover's top edge. The cause is not in any of those components: `main.css`
carried `[data-slot='viewport'] { bottom: calc(1rem + env(safe-area-inset-bottom)) }`, written to
keep the toaster clear of a phone's home indicator. Nuxt UI names the scroll region of eleven
components `viewport`, and the item list of every menu one (Select, SelectMenu, InputMenu,
CommandPalette, DropdownMenu, ContextMenu, NavigationMenu) is `position: relative`, so that rule
offset all of them a rem upward while the popover box stayed put.

The toaster's viewport now carries an `app-toaster` marker class from `app.config.ts` and both
app-level toaster rules hang on that instead, so nothing app-side names a `data-slot` value the
component library shares. A new e2e spec opens a picker and asserts no option is drawn above its
own popover: this class of defect needs the assembled product to be visible at all, since a
component unit test renders without the app stylesheet and with no layout engine.
