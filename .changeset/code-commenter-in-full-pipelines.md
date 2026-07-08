---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
---

Code Commenter is now a business-as-usual step in the full build pipelines, keeping in-source
comments relevant and up to date on every task instead of only on a dedicated standalone run.

- **Full pipelines gain a `code-commenter` step** (`pl_full` and `pl_fullstack`, versions bumped
  for the reseed): it runs right after the `reviewer` clears the implementation and edits comments
  only — adding why-not-what comments, updating ones that have drifted from the code, and deleting
  noise comments that merely restate what the code already says — with no behaviour change. The
  existing `ci` step is the backstop that proves the comment-only diff is behaviour-neutral before
  `merger` ships it.
- **One parametrized agent serves both use-cases.** A new adaptive clone mode `pr-or-work`
  (`AgentCloneSpec.branch`) makes the Code Commenter amend the block's existing PR in place when
  there is one (the BAU pipeline case — the well-commented code ships in the coder's own PR) and
  fall back to branching off base and opening its own PR when there is none (a standalone
  `pl_code_comments` run or an initiative-framed sweep of a legacy codebase). It is
  `noChangesTolerated`, so a run that finds the comments already in good shape is a clean
  non-event rather than a failure. No new agent kind, no executor-harness image change.
- The Code Commenter's prompt now actively **maintains** existing comments (fix/remove stale ones,
  strip redundant ones) rather than only adding new ones, and scopes a BAU run to the files the
  pull request changes.
- **Hardening:** `agentPresentationSchema.description` is now required and non-empty
  (`minLength(1)`, like `label`/`icon`/`color`). The SPA renders a registered kind's description
  verbatim in the pipeline builder palette with no fallback, so a blank one would have surfaced as
  an empty description on a first-class palette block; this makes that impossible at the wire
  boundary. Every existing agent kind already ships a description, so nothing changes for them.
