---
'@cat-factory/app': patch
---

Delete the SPA's button and badge props that restate Nuxt UI's defaults, and guard against them.

246 `color="primary"`, `variant="solid"` and `size="md"` props on `UButton`, `IconButton` and `UBadge`
restated Nuxt UI's own default. The defaults are now stated once in `app.config.ts`, where
`scripts/check-frontend-variants.mjs` (CI) reads them to refuse a value that repeats them.

Nothing changes on screen with the built-in themes (Cat Factory and Mono), which set no button
defaults. An imported theme whose `style.defaults` sets a button size, variant or colour now reaches
the controls that used to pin Nuxt UI's value: for example, with `size: 'lg'` the buttons and badges
that said `size="md"` grow with the rest. That is the intent: a restated default was a value the
theme could not change.

The defaults stay Nuxt UI's on purpose. A theme document's `style.defaults` replaces the default for
every control that does not state the prop, so the unstyled group is the one a theme restyles. Keeping
the primary actions unstyled means a theme with a larger size or a different button variant restyles
the actions, not every toolbar and icon button. The variant policy (one solid primary per view, the
secondary, destructive, chrome and size rules) is written down in `frontend/app/README.md`.
