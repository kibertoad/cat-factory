---
'@cat-factory/app': patch
---

Modals and slideovers darken the page behind them with a black scrim. Before, the overlay was Nuxt UI's `bg-elevated/75`, which in light mode is the same neutral-100 as the overlay panel, so the panel blended into the page behind it.
