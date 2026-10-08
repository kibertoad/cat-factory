---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': patch
'@cat-factory/mcp-server': patch
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/app': minor
---

Guided review questions asked with `depth: "deep"` are answered from a read-only checkout of the repository (surface version 1.78.0). A new `guided-review-investigator` container-explore kind runs per question, with its own preset model; `ContainerGuidedReviewInvestigator` dispatches it standalone, the way the environment dry run's prober is dispatched, and files its spend through the same accounting a pipeline step uses. The job clones the target branch with full history, fetches the PR head and checks out the reviewed commit.

A deep answer is driven as a state machine on its message: claim, dispatch, record the dispatch, poll. `GuidedReviewService.runJob` now returns `GuidedReviewJobProgress`, and the Workflow, pg-boss and local `node:sqlite` drivers loop on it within `GUIDED_REVIEW_MAX_PASSES`. Each poll refreshes the claim, so the stale scan never mistakes a live investigation for a dead one; a container still working after 45 minutes is stopped and its question reported failed. `GuidedReviewRepository` gains `recordInvestigation`, `getInvestigation` and `heartbeatMessage` (migration 0106 and its Drizzle mirror).

The two standalone container flows now share one dispatch builder per facade. The single-kind model resolver accepts a job with no board frame, which resolves on the workspace's default preset. The local guided-review queue now wakes at its earliest due job, so a re-queued job can no longer wait for the periodic sweep when a timer fires early. The review window gains a "Deep dive" switch.
