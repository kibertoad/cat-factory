---
'@cat-factory/app': patch
---

Delete the SPA's button and badge props that restate Nuxt UI's defaults, and guard against them.

246 `color="primary"`, `variant="solid"` and `size="md"` props on `UButton`, `IconButton` and `UBadge`
restated Nuxt UI's own default, so nothing changes on screen. The defaults are now stated once in
`app.config.ts`, where `scripts/check-frontend-variants.mjs` (CI) reads them to refuse a literal that
repeats them.

The defaults stay Nuxt UI's on purpose. A theme document's `style.defaults` replaces the default for
every control that does not state the prop, so the unstyled group is the one a theme restyles. Keeping
the primary actions unstyled means a theme with a larger size or a different button variant restyles
the actions, not every toolbar and icon button. The variant policy (one solid primary per view, the
secondary, destructive, chrome and size rules) is written down in `frontend/app/README.md`.
