---
'@cat-factory/app': minor
---

Tester run details now show an explicit "Test environment is up — the tester is starting its work" line once all of a tester step's infrastructure is ready (its container is up, the ephemeral environment is `ready`, and any in-container dependency stand-up succeeded), so the details no longer jump silently from "provisioning" into a blank working state.
