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
---

The requirements review window can post the refined requirements back to the tracker issue(s) the task came from. Each linked issue gets the document as a comment, so the issue description is never rewritten, and a repeated click posts the same document at most once per issue (a revised document posts again). GitHub, GitLab and Linear receive the Markdown as written; Jira receives it converted to ADF, now with nested lists, code blocks, quotes, emphasis and links, which also improves Jira tickets the platform files and every other Jira comment it writes.

New internal route `POST /workspaces/:workspaceId/blocks/:blockId/requirement-review/post-to-issues`, two conflict reasons (`refined_requirements_unavailable`, `no_linked_issues`), a new `IssueWritebackProvider.postRefinedRequirements` port method, and a new `refined_requirements_posts` table on both facades (D1 migration `0111`, a Drizzle migration on Node), reached by a mothership-mode node over the persistence RPC.
