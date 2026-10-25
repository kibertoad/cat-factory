---
'@cat-factory/contracts': minor
'@cat-factory/app': patch
---

A disabled API key no longer marks its provider as configured in the SPA. The rule now lives in `@cat-factory/contracts` as `apiKeyConfiguresProvider`, so the model picker and the model providers hub agree with the backend, which already ignored disabled keys.
