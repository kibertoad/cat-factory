---
'@cat-factory/app': patch
---

Persist dismissal of the unofficial-translation warning banner. Dismissing the banner now
sticks across reloads (stored per-locale in localStorage) instead of reappearing on every
page load; switching to a different non-English locale still shows it, since each catalog is
an independently-translated context.
