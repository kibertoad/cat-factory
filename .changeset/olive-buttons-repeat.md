---
'@cat-factory/app': minor
---

Size SPA text through named type steps instead of pixel literals.

The app declares two steps below Tailwind's `text-xs` in `app/assets/css/type.css`, `text-2xs`
(0.6875rem) and `text-3xs` (0.625rem), and the 1653 `text-[Npx]` literals across the layer move onto
them. Both are rem, so a theme document's `fontSize` now scales the app's own text the way it
already scaled Nuxt UI's components. The 11px and 10px sites, 1284 of the 1653, are exact on the two
steps and render unchanged; the four sizes with no step of their own move by a pixel (9px up to
10px, 12px and 12.5px to 12px, 13px up to 14px).

`common/SectionLabel.vue` becomes the one section eyebrow, replacing the six hand-written recipes
across 316 call sites. Adopting one recipe is visible wherever a label was not already on it: the
ones that were `text-muted` render a step fainter, the ones that were 9px or 10px grow to 11px, and
the ones that carried no weight gain `font-semibold`. `scripts/check-frontend-type-scale.mjs` keeps
every spelling of a font-size literal from returning.
