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

The report payload gains an optional `scope` (`PR_VERIFICATION_REPORT_VERSION` 7, OpenAPI 1.15.0),
which is additive: absent means the own-service PR, exactly as before. `GET /api/v1/runs/:runId/report`
keeps answering the complete own-service copy.

Publishing to N pull requests costs what publishing to one did. `resolveTargets` is the only
addressing step a settlement runs, the run-scoped evidence is read once and layered per pull request,
and a resolved target carries its own repo and connection so the write reads nothing. The multi-repo
repo resolver also reads the workspace's repo projection through the same per-workspace cache as the
singular one, which it did not before (harmless while its only caller was dispatch, a full uncached
re-list once the report started calling it on every settled step).

`hostMarkdown` gains `link`/`cellLink`, the boundary for a link TARGET: an unusable or non-`http(s)`
URL renders as plain text instead of a link. The existing helpers only ever covered link text, and a
peer report links to a pull-request URL the harness reported.

Internal break: the `PrVerificationReportPublisher` port replaces `resolveTarget` with `resolveTargets`,
`publish` takes `(workspaceId, target, section)` (no block id, since it no longer resolves anything),
and `PrReportTarget` gains a required `connection`. The `no_pull_request` / `no_repo` skip reasons are
gone with the resolution they described: nowhere to publish is an empty `resolveTargets`.
