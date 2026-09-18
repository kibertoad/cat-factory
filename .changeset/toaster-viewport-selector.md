---
'@cat-factory/app': patch
---

Stop the toaster's safe-area rule from clipping every menu in the app.

`main.css` offset the bottom-anchored toaster past the phone home indicator with a bare
`[data-slot='viewport']` selector. Eleven Nuxt UI components render that attribute —
`Select`, `SelectMenu`, `InputMenu`, `CommandPalette`, `DropdownMenu`, `ContextMenu`,
`NavigationMenu`, `ScrollArea`, `ChatMessages`, `Carousel` and the `Toaster` — and each menu
viewport is `position: relative` inside an `overflow-hidden` content box, so `bottom: 1rem`
shifted its item list up by 16px: the first row was cut in half and an equal band of dead
space appeared at the foot of the panel.

The selector is now `ol[data-slot='viewport']`. Only the Toaster's viewport is an `<ol>`
(Reka's `ToastViewport`); every other viewport is a `div`, so the toaster keeps its
safe-area offset and the menus render unshifted.
