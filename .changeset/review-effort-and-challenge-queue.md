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
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Review effort levels and a challenge queue for the PR deep review.

- A review task takes an effort level (`low`, `medium`, `high`, `xhigh`, `max`; `high` by default) on `taskTypeFields.reviewEffort`. A risk policy carries `postImplementationReviewEffort` (default `high`) for the post-implementation reviewer. The level sets the findings cap, whether unconfirmed findings are reported, whether each finding gets a verification pass, and the pr-reviewer's slice fan-out. The default `high` now runs a verification pass, so a default review spends more than before.
- Challenged findings queue: at most three investigators run at once, the rest read `queued`, and selection stays editable while they run. Resolve and dismiss wait for the queue to drain. Public API: `queued` joins the PR review finding challenge status (OpenAPI 1.92.0, SDKs regenerated).
- Internal break: the step field `pendingChallenge` is replaced by `challengeJobs`. A challenge in flight on an existing run when this deploys is dropped: the review returns to awaiting selection with that finding still marked `investigating`, so it cannot be challenged again, while the rest of the review resolves normally.
