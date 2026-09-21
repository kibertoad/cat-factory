---
'@cat-factory/app': patch
---

Add a fixed white/black rule to the SPA colour-token guard
(`scripts/check-frontend-palette.mjs`), the lexical half of the #2242 review
follow-up: `bg-white`, `text-black`, `border-white/5` and the like are invisible
or wrong in light mode, so they join the existing raw-palette, numbered-alias and
colour-literal bans. A deliberate exception says why with a `fixed-colour-ok:`
comment, on the line or the one above. The one in-tree offender, the
difference-composite canvas in `ImageCompare.vue`, carries that marker. No
behaviour change.
