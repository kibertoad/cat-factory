---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Issue-tracker writeback: comment on a task's linked tracker issue when its PR
opens, and comment + close the issue as resolved when the PR merges.

Two independent toggles configured at the **workspace** level (on the existing
tracker settings) and overridable **per task** in the inspector
(`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
The linked issue(s) come from the existing task projection (`linkedBlockId`), so
writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
is best-effort — a tracker outage never fails a run.

GitHub issues close natively (`state_reason: completed`); Jira issues transition to
the first status in their standard **Done** category (no manual status mapping). The
new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
`closeIssue` method.

**Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
`writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
unaffected.
