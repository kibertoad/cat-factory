---
'@cat-factory/app': patch
---

Bring the SPA's buttons in line with the variant policy, and guard "one solid per view".

The three gate windows that offered a solid "send back" action beside a solid "approve" (the
judge result, human testing, visual confirmation) now render send-back as `warning soft`, so the
approve stays the one primary.

Twenty labelled destructive actions move to `error soft`: the ones that disconnect, clear, delete,
discard, reset or remove stored state, including the four confirm-gated Clear buttons on the
deployment credentials, Discard on a guided-review draft and Destroy environment in human testing.
The icon-only Delete pipeline button is now `error ghost`. Removing a row or chip from a form that
is not saved yet stays neutral: it is not destructive.

Twenty-six inline and chrome actions that rendered as primary-coloured ghost buttons (Edit,
Resync, Refresh, show/hide toggles, file-tree rows) now render neutral, and two cancel buttons
that rendered in the primary colour now render neutral like the rest.

`scripts/check-frontend-variants.mjs` also refuses two solid buttons under one parent element. A
`v-if` chain and a `v-for` list count as one button, a renderless component (`UTooltip`,
`UPopover`, `ClientOnly`, a plain `<template>`) adds no element, and a slot `<template #name>` is
its own region, so a file holding several forms that each end in a Save still passes.
