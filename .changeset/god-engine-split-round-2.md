---
'@cat-factory/orchestration': patch
---

Split the two engine god-files along cohesive seams (no behaviour change): `ExecutionService`'s start/retry/restart `assert*` admission family moved to `RunAdmission`, its requirements/clarity/brainstorm `ReviewKind` builders to `review-kinds.ts`; `RunDispatcher`'s deterministic deployer family (provision fan-out, deploy-job poll, environment projection) moved to `DeployerStepController` and the follow-up companion gate + its human-action API to `FollowUpGateController`. Adds `scripts/check-file-size.mjs`, a CI-enforced soft max-lines budget with ratcheted allowances, so the god files can't silently regrow.
