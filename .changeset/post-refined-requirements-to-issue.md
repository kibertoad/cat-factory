---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/gitlab': minor
'@cat-factory/observability-otel': minor
---

A task's refined requirements can be written into the description of the tracker issue(s) it came from, replacing it; every tracker keeps the previous description in its history. The requirements review window has an "Update linked issues" button, and a new workspace writeback setting, `writebackRequirementsToDescription` (off by default), does the same automatically when a requirements review settles and the run moves on. The write is idempotent by content: an issue already holding the document is left alone and reported `already_current`. The last outcome per issue is recorded on the review (`issueWriteback`) and listed in the window, and counted on `writeback.requirements_description`. Jira receives ADF, now with nested lists, code blocks, quotes, emphasis and links, sized against Jira's 32,767-character field limit; that converter also improves the Jira tickets the platform files and every Jira comment it writes.

New internal route `POST /workspaces/:workspaceId/blocks/:blockId/requirement-review/update-linked-issues`, two conflict reasons (`refined_requirements_unavailable`, `no_linked_issues`), a new `IssueWritebackProvider.writeRefinedRequirements` port method, an optional `TaskSourceWritebackAdapter.replaceDescription` (implemented for Jira, Linear, GitHub Issues and GitLab Issues) and an optional `replaceIssueBody` on the GitHub and VCS client ports. `RequirementReviewRepository` gains `recordIssueWriteback`.

The tracker writeback's exactly-once marker for comments is now one generic table, `writeback_posts`, replacing `review_question_posts`: the migration (D1 `0111`, a Drizzle migration on Node) copies the parked-review question markers over and drops the old table, and `reviewQuestionPostRepository` becomes `writebackPostRepository` on `IssueWritebackService` and the persistence RPC. Its claim answers `claimed`, `posted` or `held` in one statement. The same migration adds `tracker_settings.writeback_requirements_to_description` and `requirement_reviews.issue_writeback`.
