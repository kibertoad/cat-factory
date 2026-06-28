---
"@cat-factory/app": patch
---

Fix infinite recursion in the UI store's `resetHubReturn` (it called itself instead of clearing the `cameFromIntegrations` marker), which crashed with `Maximum call stack size exceeded` when opening hub-spawned panels (e.g. "configure environment provider").
