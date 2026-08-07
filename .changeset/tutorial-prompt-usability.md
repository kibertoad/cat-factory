---
'@cat-factory/app': patch
---

Three tutorial usability fixes, all found by walking the board-basics tour on a real deployment.

Coach-mark text was unselectable exactly on the steps that point into an open modal, which
includes the one string a user reliably tries to copy: the sample repo slug in the add-service
tour. The card is click-focusable (`tabindex="-1"` for `focusCard`), so a press on its text moved
focus out of the modal, the modal's focus trap yanked it back, and Chromium abandoned the
selection it was starting before `selectstart` ever fired. `preventDefault` on the press cannot
fix that (cancelling pointerdown or mousedown cancels the selection itself), so the attribute is
no longer standing: the card is focusable only across the window where it actually holds focus,
applied just before `focusCard` focuses it and dropped again when focus leaves. Outside that
window a press moves focus nowhere, on every input type, with no timing window to lose.

The command-palette step told the user they "can restart this tutorial from there at any time"
without saying how. It now names the palette entry to pick, via a linked i18n message
(`@:{'nav.tutorials'}`) so the copy tracks the entry's real label in each locale; the delimited
form matters because a bare `@:key` link swallows the closing quotation mark into the key in
every quoting convention the catalogs use except French's spaced guillemets.

The board's top overlay surfaces now have a single owner, `BoardTopOverlays`. The toolbar, the
compact-viewport nav trigger, the connection/spend/GitHub-PAT banners and the four advisory
banners each used to anchor themselves at the top of the board with their own z-index, so which
one you could see came down to who picked the higher number: any standing advisory covered the
zoom and fit controls outright, and the toolbar tour step then ringed a control nobody could
see. They now render as members of one flex column that owns placement and stacking, which makes
the overlap unrepresentable rather than tuned, and leaves no offset constant to go stale when the
toolbar pill wraps or grows a scrollbar. The translation-warning strip moves into normal flow at
the top of the shell for the same reason: page chrome that takes its own height cannot cover the
app beneath it.

Two visible consequences beyond the fix. The advisory cards now centre over the board rather than
over the whole window, so on a wide viewport they sit right of centre by half the sidebar. The
local-mode GitHub PAT prompt renders with the board rather than during the brief probe that
precedes it.
