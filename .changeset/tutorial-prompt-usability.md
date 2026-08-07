---
'@cat-factory/app': patch
---

Three tutorial usability fixes, all found by walking the board-basics tour on a real deployment.

Coach-mark text was unselectable exactly on the steps that point into an open modal, which
includes the one string a user reliably tries to copy: the sample repo slug in the add-service
tour. The card is click-focusable (`tabindex="-1"` for `focusCard`), so a press on its text moved
focus out of the modal, the modal's focus trap yanked it back, and Chromium abandoned the
selection it was starting before `selectstart` ever fired. `preventDefault` on the press cannot
fix that (cancelling pointerdown or mousedown cancels the selection itself), so the card now
lifts its `tabindex` for the duration of a pointer gesture: focus never moves, the trap stays
silent, and selection proceeds. Programmatic focus (tour start, Next/Back) is unaffected.

The command-palette step told the user they "can restart this tutorial from there at any time"
without saying how. It now names the palette entry to pick, via a linked i18n message
(`@:{'nav.tutorials'}`) so the copy tracks the entry's real label in each locale; the delimited
form matters because a bare `@:key` link swallows the closing quotation mark into the key in
every quoting convention the catalogs use except French's spaced guillemets.

The stacked advisory banners (AI providers, provider config, infra setup, default test env)
were anchored at `top-0`, the same spot as the centered board toolbar, and drew over it
(z-40 vs z-20). Any standing advisory therefore hid the zoom/fit controls, and the toolbar tour
step highlighted a control buried under the banner. The column now starts at `top-16`, below
the toolbar.
