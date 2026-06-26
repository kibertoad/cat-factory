---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/gates': minor
'@cat-factory/server': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
"Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
existing `fixer` agent to address feedback:

- Advances once the PR meets GitHub's required approvals (read from branch protection) with no
  unresolved review threads.
- Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
  per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
  review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
- Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
  notification while it waits.
- A human can request a freeform fix at any time from the gate window
  (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
`GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

**Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
`@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
table gains a non-null `human_review_grace_minutes` column.
