---
'@cat-factory/app': minor
---

Size SPA text through named type steps instead of pixel literals.

The app declares two steps below Tailwind's `text-xs` in `app/assets/css/type.css`, `text-2xs`
(0.6875rem) and `text-3xs` (0.625rem), and the 1653 `text-[Npx]` literals across the layer move onto
them. Both are rem, so a theme document's `fontSize` now scales the app's own text the way it
already scaled Nuxt UI's components. `common/SectionLabel.vue` is the one section eyebrow, and
`scripts/check-frontend-type-scale.mjs` keeps the literal form from returning.
