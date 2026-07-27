---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/app': minor
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
started through `/api/v1` parks its requirements review on open findings, its questions can now
be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
can see.

Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
`public-api`, and their clarification surface remains the in-app review window.

The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
`(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
recorded with its error and retried on the next replay rather than being swallowed, and a claim
abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
so that iteration's questions are not silently lost. The park is committed before the outbound
call, so a slow or unavailable tracker can never delay the state change that makes the run
answerable.

The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
rendered through the same untrusted-text boundary as the PR verification report — auto-link
triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
`@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
THROW when it cannot resolve the target issue instead of returning quietly (returning is the
seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
migration `0062` and the generated Node Drizzle migration.
