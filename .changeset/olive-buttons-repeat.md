---
'@cat-factory/app': minor
---

Size SPA text through named type steps instead of pixel literals.

The app declares two steps below Tailwind's `text-xs` in `app/assets/css/type.css`, `text-2xs`
(0.6875rem) and `text-3xs` (0.625rem), and every `text-[Npx]` literal in the layer moves onto a named
step. All steps are rem, so a theme document's `fontSize` now scales the app's own text the way it
already scaled Nuxt UI's components. The 11px and 10px sites are exact on the two new steps and
render unchanged. The four sizes with no step of their own move by a pixel (9px up to 10px, 12px and
12.5px to 12px, 13px up to 14px). Those four also take the LINE HEIGHT that `text-xs` and `text-sm`
pair with their size, where the literal paired none, so a 12px block with no `leading-*` tightens
from 18px lines to 16px.

`common/SectionLabel.vue` becomes the one section eyebrow, replacing six hand-written recipes. The
recipe is visible wherever a label was not already on it: labels at 9px or 10px grow to 11px, labels
at `text-xs` or `text-sm` shrink to 11px, labels with no weight gain `font-semibold`, and labels on
`text-dimmed` render one step darker on `text-muted`.

The colour is a deliberate departure from the most common value. At 11px `text-dimmed` measures
2.63:1 against a light surface, under WCAG AA's 4.5:1 and under the 3:1 large-text floor;
`text-muted` is 4.76:1. The SPA's wider use of `text-dimmed` outside this component is unchanged.

`scripts/check-frontend-type-scale.mjs` keeps font-size literals from returning: utilities, CSS
declarations including the `font:` shorthand, and JS style properties.
