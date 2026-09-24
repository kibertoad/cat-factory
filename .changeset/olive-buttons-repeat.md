---
'@cat-factory/app': minor
---

Size SPA text through named type steps instead of pixel literals.

The app declares two steps below Tailwind's `text-xs` in `app/assets/css/type.css`, `text-2xs`
(0.6875rem) and `text-3xs` (0.625rem), and the 1653 `text-[Npx]` literals across the layer move onto
them. Both are rem, so a theme document's `fontSize` now scales the app's own text the way it
already scaled Nuxt UI's components. The 11px and 10px sites, 1284 of the 1653, are exact on the two
steps and render unchanged; the four sizes with no step of their own move by a pixel (9px up to
10px, 12px and 12.5px to 12px, 13px up to 14px). Those four also take the LINE HEIGHT that
`text-xs` and `text-sm` pair with their size, where the literal paired none, so a 12px block
carrying no `leading-*` tightens from 18px lines to 16px.

`common/SectionLabel.vue` becomes the one section eyebrow, replacing the six hand-written recipes
across 313 call sites. Adopting one recipe is visible wherever a label was not already on it: 66
grow from 9px or 10px to 11px, 28 shrink to 11px (27 from `text-xs`, one from `text-sm`), 109 that
carried no weight gain `font-semibold`, and the 211 that were `text-dimmed` render one step DARKER
on `text-muted`.

That last one is a deliberate departure from the plurality. At 11px `text-dimmed` measures 2.63:1
against a light surface, under WCAG AA's 4.5:1 for text this size and under even the 3:1 large-text
floor; `text-muted` is 4.76:1. Standardising on the more common token would have moved 102 labels
below AA, so the recipe standardises on the legible one and moves 211 above it instead. The SPA's
wider use of `text-dimmed` outside this component is unchanged and remains a separate problem.

`scripts/check-frontend-type-scale.mjs` keeps every spelling of a font-size literal from returning.
