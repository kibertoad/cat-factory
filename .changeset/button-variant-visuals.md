---
'@cat-factory/app': patch
---

Bring the SPA's buttons in line with the variant policy, and guard "one solid per view".

The three gate windows that offered a solid "send back" action beside a solid "approve" (the
judge result, human testing, visual confirmation) now render send-back as `warning soft`, so the
approve stays the one primary. Fourteen labelled destructive actions (disconnect, clear, delete,
discard, reset, remove) move from `ghost` or `subtle` to `error soft`, and two cancel buttons that
rendered in the primary colour now render neutral like the rest.

`scripts/check-frontend-variants.mjs` also refuses two solid buttons under one parent element. A
`v-if` chain and a `v-for` list count as one button, and a slot `<template #name>` is its own
region, so a file holding several forms that each end in a Save still passes.
