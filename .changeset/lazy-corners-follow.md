---
'@cat-factory/app': patch
---

Make every corner radius in the SPA follow the theme.

Nuxt UI rebuilds Tailwind's radius scale on top of `--ui-radius`, so `rounded-sm` through
`rounded-3xl` already tracked a theme document's `radius`. Bare `rounded` did not: it resolves
through Tailwind's deprecated `--radius`, declared `@theme default inline reference`, so the value
is inlined as a literal 0.25rem and no custom property survives for `--ui-radius` to override. All
144 uses across 64 files move to `rounded-sm`, and the six raw `border-radius` declarations in the
prose styles move onto `var(--radius-*)`.

Both spellings compute to the same 0.25rem on the default `Cat Factory` theme, so nothing moves
there. On a theme with a different radius they now move together: on the built-in `Mono`
(`radius: 0.5`) the affected boxes go from 4px to 8px and match the buttons and cards around them,
where before the theme rounded the Nuxt UI components and left the app's own boxes at 4px. Every
preset the Nuxt UI theme editor ships carries a non-default radius, from 0 to 0.75rem, so an
imported theme hit this too.

`radius` is now stated on the `Cat Factory` document. It equals the default and writes no CSS,
which is the point: the number has one visible home.

`scripts/check-frontend-radius.mjs` keeps the bare alias, a step off the seven Nuxt UI rebinds
(`rounded-4xl`, which is Tailwind's own 2rem literal), arbitrary values like `rounded-[10px]` and
raw px/rem/em `border-radius` declarations from returning. `rounded-full` and `rounded-none` stay
allowed.
