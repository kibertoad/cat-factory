---
'@cat-factory/app': patch
---

Route every SPA colour through the Nuxt UI theme so `app.config.ts` actually drives the UI, and
make the theme light-capable. Greys move from raw Tailwind palette classes (`bg-slate-900`,
`text-slate-400`) onto Nuxt UI role tokens (`bg-default`, `text-muted`, `border-default`, ...) that
flip with the colour mode; the five grey shades with no role token use hand-defined `app-*` flipping
tokens; `text-white` becomes `text-highlighted`; brand accents use the `primary` alias.

Dark mode is unchanged (every role/`app-*` token resolves to the exact shade it replaced; verified
by pixel-diff against the prior build, with one sub-perceptual `backdrop-blur` toolbar artifact
noted). Light mode now renders coherently from the same markup, but `colorMode` stays pinned dark:
light is one config line away, not enabled here. A new e2e `palette-token-parity` dark-identity test
and `scripts/check-frontend-palette.mjs` guard against regressions.
