---
'@cat-factory/app': patch
---

Extend the SPA colour-token guard (`scripts/check-frontend-palette.mjs`) with three rules from the
#2242 review: a fixed `white` / `black` utility, `text-white` / `text-highlighted` over a
`bg-primary` or alias fill, and a `hover:` colour utility equal to its resting value. The one
in-tree offender the new rules find, the difference-composite canvas in `ImageCompare.vue`, moves
its class to a named const carrying the `fixed-colour-ok:` marker (black is the correct blend base
in either mode). No behaviour change.
