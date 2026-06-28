---
"@cat-factory/app": patch
---

Add a language switcher (sidebar) for the supported locales and persist the explicit
choice across reloads (the app still defaults to English; no browser auto-detect). When
a non-English locale is active, a slim top banner warns that the translation is
unofficial and may be inaccurate, with a link to the cat-factory repository for reporting
mistakes or opening fix PRs.
