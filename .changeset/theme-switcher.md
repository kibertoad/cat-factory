---
'@cat-factory/app': minor
---

Light mode and a colour-mode switcher.

Colour mode now follows the visitor's system preference and the new Appearance picker at the
sidebar bottom (system / light / dark), instead of being pinned dark; the browser chrome follows
the app's pick, not the OS.

Every colour in the SPA is now a theme token. Status surfaces move from fixed palette shades
(`text-amber-300`, `bg-rose-950/40`) onto the app's mirrored `app-<alias>-<n>` tokens, whose dark
value is the exact shade the raw class used and whose light value is the mirrored shade; brand
accents move from numbered indigo shades onto Nuxt UI's bare `primary` alias (a few shades collapse
to one per mode); the per-kind identity colours (agent kinds, task types, step kinds) move from hex
onto mode-adaptive `app-hue-<h>` tokens, while task status, step state and
verdict colours take the semantic aliases directly (`done` is now the muted grey of a finished
state rather than a second green one shade from `pr_ready`); the board canvas, the dot grid, the
prose reader and the status halos ride tokens too. Dark mode is unchanged; light mode renders coherently. `red` and `rose` unify on
the `error` alias (rose), a small hue shift on the few `red` sites. `scripts/check-frontend-palette.mjs`
now bans every fixed-palette colour utility, not only slate/indigo.
