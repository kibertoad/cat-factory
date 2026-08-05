---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Publish the verification report onto a multi-repo run's PEER pull requests, scoped per repo

A cross-service run opens one pull request per repo it changed; only the own-service one carried a
report, so a reviewer on a connected service's PR saw none of the run's evidence. Every pull request
now gets one, and each is composed for the pull request it lands on.

The reports are deliberately not identical. Run-scoped evidence (the CI gate's aggregate verdict, the
tester, the judges, the environments, the merge decision) is reported on all of them, because it
governs the whole set. The three sections that are statements about the own-service repo (pre-PR
validation, the bugfix reproduction proof and the `spec/` requirement join) are withheld from a peer's
copy, with a note naming the own-service PR where they live: restating them would attribute one repo's
evidence to another repo's diff.

The report payload gains an optional `scope` (`PR_VERIFICATION_REPORT_VERSION` 7, OpenAPI 1.12.0),
which is additive: absent means the own-service PR, exactly as before. `GET /api/v1/runs/:runId/report`
keeps answering the complete own-service copy.

Internal break: the `PrVerificationReportPublisher` port replaces `resolveTarget` with `resolveTargets`
and `publish` now takes the resolved target it was composed for.
