---
'@cat-factory/app': patch
---

The tab bars in the GitHub panel, the prompt-fragment library and guided review are now Nuxt UI `UTabs` (the default pill style) instead of rows of buttons. They now have the tab roles and keyboard support: one tab stop for the row, and Left, Right, Home and End move between tabs. Guided review's thread tabs had `role="tab"` before, but the arrow keys did nothing. There the arrow keys now move focus and Enter or Space opens the thread, because opening one loads it, and a review with many threads scrolls its tab row instead of wrapping it. A new CI guard, `scripts/check-frontend-tabs.mjs`, refuses a template that states `role="tablist"`, `role="tab"` or `role="tabpanel"` itself.
