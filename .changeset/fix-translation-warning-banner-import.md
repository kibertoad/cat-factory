---
'@cat-factory/app': patch
---

Fix `Failed to resolve component: TranslationWarningBanner` console error on the board page.

The banner lives in `components/layout/`, so its auto-import name is `LayoutTranslationWarningBanner`; the bare `<TranslationWarningBanner />` in `index.vue` never resolved. Added the explicit import to match the sibling layout banners.
