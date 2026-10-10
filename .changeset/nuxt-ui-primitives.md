---
'@cat-factory/app': minor
---

Render every SPA control as its Nuxt UI component instead of a raw HTML element.

Every raw `<button>`, `<input>`, `<select>`, `<textarea>`, hand-built `<table>`, `<details>`,
`<form>`, `<a href>` and `<datalist>` in the layer, each with its own border, background, hover and
focus recipe, moves onto `UButton`, `UInput` /
`UInputNumber` / `UCheckbox` / `URadioGroup` / `USlider` / `UFileUpload`, `USelect`, `UTextarea`,
`UTable`, `UCollapsible`, `UForm`, `ULink` and `UInputMenu`, so each now follows the theme, the
focus ring, the disabled state and the size scale.

Four changes go beyond a swap and are visible:

The four hand-built segmented switchers (the observability views, the reports window and
dimension rows, the operator window row) become `UTabs`, which adds arrow-key navigation and the
tab ARIA they had none of.

The fork-decision cards were one choice rendered as N independent radios; they become a single
`URadioGroup variant="card"`, the custom-approach entry included, so the single-selection rule and
keyboard navigation come from the primitive.

`ImageCompare` hand-rolled a drop zone, a hidden shared file input and its own drag state.
`UFileUpload` owns all three. The PNG/JPEG guard stays in the component, because `accept` filters
the picker and a dropped file arrives regardless.

`IconButton` and `CopyButton` wrap their button in a `UTooltip` and keep `aria-label` on the
button. A `title` never fires on touch, is unstyled and waits about a second, so every icon-only
button's hint now appears as a themed tooltip, and every icon-only button has an accessible name.
The tooltip trigger is a wrapper around the button, so it still opens on a disabled one, and
`class` on `IconButton` lands on that wrapper, the box its parent lays out. A labelled button
keeps a `title` as a hover hint beside its own name.

A Nuxt UI slot often sets more than the property a site overrides: `UButton`'s padding, text size
and hover background, `UTable`'s cell padding, colour and `whitespace-nowrap`, `ULink`'s colour.
Each converted site states the whole box it had, so where the old markup inherited a value the new
one restates it.

`scripts/check-frontend-primitives.mjs` holds the count at zero, including a raw element rendered
through `as="button"`, an `:is` binding or `h()`, and an icon-only `UButton` named only by
`title`. It has no allow-list: the two cases expected to need one (a Vue Flow gesture handle, a
full-bleed media tile) both converted.
