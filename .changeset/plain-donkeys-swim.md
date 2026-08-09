---
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/conformance': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/mcp-server': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
---

Attribute a cross-service run's pull request to every involved service frame whose changes ride
it, not just the first.

The multi-repo fan-out checks out one repo per REPO, so several involved services living in one
monorepo already shared a checkout, a work branch and a single pull request. Only the RECORD was
singular, which left every frame but the first looking like a service the run had opened no pull
request for. The attribution is now a set (`frameIds`) from the dispatch through the harness echo
to `block.peerPullRequests`, the merge order, and the verification report. The own-service report
carries it too, naming the involved services co-located in the task's own repo: those open no pull
request of their own, so that report is the only place their change is reported. A peer checkout
also stops inheriting one co-located service's `serviceDirectory`: it is whole-repo, as the primary
already was, so the services that resolved second are reachable.

A recorded peer pull request is now ADDRESSED by its repo rather than by its frames, which is what
a checkout is identified by, and one the platform cannot resolve is named to the merger instead of
being dropped from the combined diff it scores.

Internal break: `peerPullRequestSchema.frameId`, `allPullRequests`, `MergePrEntry.frameId`,
`PrReportTarget.frameId` and the harness `peerRepos`/`peerPullRequests` wire fields are replaced
by `frameIds`. Peer PRs recorded on a block before this ship lose their frame attribution (the
pull requests themselves are untouched). Public `/api/v1` is additive only: `PrReportScope` gains
`frameIds` and keeps `frameId` as its head (surface version 1.40.0). `frameId` is no longer always
null on an own-service report: it names a co-located involved service when there is one.

The runner image moves to `cat-factory-executor:1.109.0`.
