---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
pickup writeback, and the replace-link that keeps a recurring block's issue context from
accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
and persistence only.

- **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
  vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
  deduped against the already-worked exclusion list. Predicates are pushed into the vendor
  query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
  `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
  against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
  (`repo:` `is:open` `type:` `label:` `in:title`) with the API's `created-asc` sort (a new
  `order` param on `GitHubClient.searchIssues`) and filters the exclusion list from a bounded
  overscan, Linear compiles a GraphQL `IssueFilter` (team, state type not completed/canceled,
  per-label `labels.some`, `title.containsIgnoreCase`) asked for oldest-created-first.
- **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
  schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
  `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
  `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
  by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
  schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
  by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
  `bug-intake` step is Phase E's schedule validation.
- **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
  on the block's linked issue(s) and marks them in-progress — Jira transitions into the
  `indeterminate` status category (`pickDoneTransition` generalized into
  `pickTransitionByCategory`), Linear transitions to the team's `started` state (new
  `pickStartedStateId`), GitHub applies the schedule's `inProgressLabel` (default
  `in-progress`) via a new `GitHubClient.applyIssueLabel` that creates the label when absent.
  Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
  writeback settings — claiming the issue is intake semantics. Wired in both facades.
- **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
  issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
  picked issue — so linked context never accumulates across recurring fires.
