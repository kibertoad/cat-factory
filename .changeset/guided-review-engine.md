---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

Guided PR review gets its engine. `GuidedReviewService` opens a session for a linked repository's pull request, generates a structured overview of it, answers questions in independent threads and turns a thread's conclusions into comment drafts. Each of those is background work: the request persists a pending row and returns, and a `GuidedReviewRunner` drives it (a Cloudflare Workflow, a pg-boss queue on Node and standard local, a `node:sqlite` queue on a mothership-mode node), with a sweeper re-waking work whose claim lapsed.

Answers come from an inline model with read tools over the PR pinned to the reviewed commit (`list_changed_files`, `read_diff`, `read_file` on either side, `list_directory`), under a per-job read budget, with file contents scrubbed of secrets. Drafts are kept only where the host could place them (a line inside a diff hunk on that side), and every refused proposal is recorded in the message's `draftReport`. A failure is settled with a reason from a closed vocabulary, which gains `head_moved`: once the PR moves past the reviewed commit, its changed files no longer describe that commit, so the job fails until the session is refreshed.

`ConflictError` gains the `thread_busy` reason, translated in every locale. `fenceVerbatim` is extracted into `@cat-factory/agents`' shared prompt helpers. No routes expose the service yet; they land in the next slice.
