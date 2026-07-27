---
'@cat-factory/orchestration': patch
---

Make environment self-test failures debuggable. A provisioning-dispatch failure (e.g. a provider rejecting the create) is no longer mislabeled `creating branch`: the run's stage now advances to `provisioning` before `startProvision` is dispatched, so `failedStage` reflects where it actually broke (and the SPA shows "provisioning environment" while a slow dispatch runs). The terminal failure is also logged server-side (stage + message + cause stack) through the container logger — previously a provider throw was only persisted on the run record and surfaced in the SPA, never logged.
