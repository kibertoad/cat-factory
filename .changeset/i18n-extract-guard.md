---
'@cat-factory/app': patch
---

Add a `vue-i18n-extract` CI guard (`i18n:check`) that fails when an i18n key is used in
code but missing from the catalog, and reports unused catalog keys as non-blocking
warnings. Closes the planned tier-3 i18n drift guard.
