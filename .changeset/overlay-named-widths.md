---
'@cat-factory/app': patch
---

Modals open at one of three named widths instead of a width picked per dialog.

A new `AppModal` wraps `UModal` with a required `size` from `utils/overlaySize.ts`: `prompt` (448px)
for confirmations, decisions and one- or two-field dialogs, `form` (576px) for forms, lists and
hubs, and `wide` (672px) for card lists with an action beside each paragraph, tabbed forms and three
pickers in a row. 46 modals move onto it. 13 keep their width, 31 move by one Tailwind step, and two
short dialogs (review friction, AI preset mismatch) narrow from 576px to 448px. The ten workbench
surfaces keep their own widths until #2359 decides their shell, each with a `workbench-width-ok:`
comment. `scripts/check-frontend-geometry.mjs` refuses a raw `UModal` or `USlideover` without that
waiver, and an `AppModal` that names its own width utility or binds `:ui` to a variable.
