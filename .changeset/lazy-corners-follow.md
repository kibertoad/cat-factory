---
'@cat-factory/app': patch
---

Make every corner radius in the SPA follow the theme.

Nuxt UI rebuilds seven of Tailwind's radius steps on top of `--ui-radius`, so `rounded-xs` through
`rounded-3xl` already tracked a theme document's `radius`. Two spellings sat outside that scale:
bare `rounded` (and its side and corner forms), which resolves through Tailwind's `--radius`, and
`rounded-4xl`, which keeps Tailwind's own 2rem. `main.css` now binds both onto `--ui-radius`, so
every `rounded-*` utility in the SPA follows the theme with no per-site change. Both are declared
`@theme default` upstream, so the app's own `@theme inline` block wins, and `inline` is what makes
the utility compile to `var(--ui-radius)` rather than to a value frozen at build time.

Nothing moves on the default `Cat Factory` theme: `--ui-radius` is the same 0.25rem the bare alias
was inlined as, and 8x it is the 2rem `--radius-4xl` already held. On a theme with a different
radius the boxes now move with the buttons and cards around them. On the built-in `Mono`
(`radius: 0.5`) the affected boxes go from 4px to 8px, where before the theme rounded the Nuxt UI
components and left the app's own boxes behind. Every preset the Nuxt UI theme editor ships carries
a non-default radius, from 0 to 0.75rem, so an imported theme hit this too.

The raw `border-radius` declarations in the reader-prose styles move onto `var(--ui-radius)`, which
the `--radius-*` scale cannot be used for: Tailwind emits those variables only where the compiled
stylesheet graph references them, so one is correct until the last other reference is deleted.

`radius` is now stated on the `Cat Factory` document. It equals the default and writes no CSS,
which is the point: the number has one visible home.

`scripts/check-frontend-radius.mjs` keeps out what the rebind cannot reach: an arbitrary value
(`rounded-[10px]`, `rounded-(--x)`) and a raw `border-radius` literal.
