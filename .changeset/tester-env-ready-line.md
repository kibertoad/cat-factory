---
'@cat-factory/app': minor
---

Tester run details now show an explicit "Test environment is up. The tester is starting its work." line while a still-running tester step has all of its infrastructure ready (its container is up, the ephemeral environment is `ready`, and any in-container dependency stand-up succeeded) and has not yet produced a report, so the details no longer jump silently from "provisioning" into a blank working state. The line clears once the step finishes, fails, or a report lands.
