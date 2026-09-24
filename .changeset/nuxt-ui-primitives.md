---
'@cat-factory/app': minor
---

Render every SPA control as its Nuxt UI component instead of a raw HTML element.

The layer carried 152 raw `<button>`, 24 `<input>`, six `<select>`, nine `<textarea>`, five
hand-built `<table>`, six `<details>`, ten `<form>`, 24 `<a href>` and two `<datalist>`, each with
its own border, background, hover and focus recipe. All of them move onto `UButton`, `UInput` /
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
button's hint now appears as a themed tooltip. The 52 icon-only buttons that carried both an icon
and a `title` move onto `IconButton`; 153 labelled buttons keep a `title` as a hover hint beside
their own name.

Each converted site keeps its own layout classes, which tailwind-merge lets win over the variant,
so the pixels stay where they were.

`scripts/check-frontend-primitives.mjs` holds the count at zero. It has no allow-list: the two
cases expected to need one (a Vue Flow gesture handle, a full-bleed media tile) both converted.
