---
'@cat-factory/app': patch
---

The tab bars in the GitHub panel, the prompt-fragment library and guided review are now Nuxt UI `UTabs` (the default pill style) instead of rows of buttons. They now have the tab roles and keyboard support: one tab stop for the row, and Left, Right, Home and End move between tabs. Guided review's thread tabs had `role="tab"` before, but the arrow keys did nothing. A new CI guard, `scripts/check-frontend-tabs.mjs`, refuses a template that states `role="tablist"`, `role="tab"` or `role="tabpanel"` itself.
