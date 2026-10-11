---
'@cat-factory/app': patch
---

Modals and slideovers use Nuxt UI's default surfaces again: a `bg-default` panel over a `bg-elevated/75` overlay. The app had painted the panel `bg-app-950`, which in the default light theme is the same neutral-100 as the overlay, so the panel blended into the page behind it. The three hand-rolled backdrops (the mobile sidebar, the result window and the failed-chunk notice) follow the same rule.
