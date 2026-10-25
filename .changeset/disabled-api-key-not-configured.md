---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': patch
---

A disabled API key no longer marks its provider as configured in the SPA. A new member-readable route, `GET /workspaces/:ws/configured-providers`, serves the direct providers a run can reach, from the same resolution the model catalog and the run-start guard use, so it also counts account-scoped keys and leaves out a gateway with no base URL. The model providers hub and the OpenRouter panel read it, and show a turned-off key as "Key disabled" with a way back to the key list instead of a form to paste a second key.
