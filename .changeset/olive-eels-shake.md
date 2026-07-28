---
'@cat-factory/local-server': patch
---

Carry the `phase` / `turnIndex` telemetry axes through the mothership-mode local sqlite store.
The axes and the store landed in separate PRs that were each green alone, so `main` was left
unable to build the local runtime.
