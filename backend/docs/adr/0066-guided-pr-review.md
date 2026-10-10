# ADR 0066: Guided PR review

- **Status:** Accepted (implemented)
- **Date:** 2026-10-08
- **Context layer:** contracts and kernel ports (`guided-review*`), `@cat-factory/orchestration`'s
  `modules/guidedReview`, the server's workspace and `/api/v1` controllers and
  `ContainerGuidedReviewInvestigator`, the three facades' persistence and durable drivers, the four
  `sdk/*` clients and MCP, and the SPA's guided review window. User-facing page:
  [Explore a pull request with guided review](https://www.catfactory.ai/guide/guided-review.html).

## Context

The `pr-reviewer` run ([ADR 0023](./0023-pr-deep-review.md)) produces findings: what an agent
believes is wrong with a pull request. A person reviewing an unfamiliar pull request needs something
else first: what the change is for, which parts of the diff carry its meaning, what it affects beyond
itself and where to spend attention. Then they want to ask questions, several at once, and turn what
they conclude into review comments on the right lines.

That experience has to be reachable from other UIs too (an IDE plugin, a browser extension on the
host's pull request page), so its whole surface is on `/api/v1` beside the SPA's own routes.

## Decision

A **guided review** is a standalone session of one user over one pull request, holding an
**overview**, any number of independent **threads** of questions answered by a model with read access
to the pull request, and **comment drafts** the human edits and posts.

### Persistence

Four tables (migrations 0104 to 0106, mirrored in Drizzle): sessions, threads, messages, comment
drafts, one row per message and per draft. The session row carries only the PR identity, the
reviewed commit (`reviewedHeadSha`), the target branch (`baseRef`) and the overview.

- One session per creator per pull request is a unique index, so two concurrent opens converge.
- A thread admits one live answer: a partial unique index over non-terminal assistant messages,
  targeted by the placeholder insert, refuses a second question as `409 thread_busy` and leaves other
  threads untouched. On Postgres the insert first locks the thread row; without it, two writers read
  the same `MAX(seq)` and the loser fails on the `seq` index before the live-answer conflict resolves.
- A thread that is missing, or belongs to another session, is refused as `thread_not_found` by the
  store on both runtimes, so the lock never silently locks nothing.
- The store writes the queued states itself: opening queues overview generation 1 and an exchange
  writes its placeholder `pending`. A claim requires `pending` or an expired claim, so a row created
  any other way would never be driven.
- Asking for comment drafts is a message `kind`, so the same index covers it, and the drafts land in
  one atomic write with the message that produced them.
- Every state transition a driver or a second writer can race on is a conditional write that reports
  whether it won: overview and message claims (with a lease, so a dead claimer is re-claimable),
  settles, overview generations (a refresh bumps the generation, so a superseded result cannot land),
  rev-guarded draft edits, and the `posting` claim taken before a host call.
- Failures carry `failure: { reason, detail }` with a closed reason vocabulary the SPA translates; a
  comment-drafts message carries a `draftReport` naming every refused proposal and why.

### Background work

A request persists work and returns at once; a `GuidedReviewRunner` drives it: a Cloudflare Workflow,
a pg-boss queue on Node and standard local, and a `node:sqlite` queue on a mothership-mode node, plus a
stale-job sweeper. `GuidedReviewService.runJob` claims its row before any model call, so a duplicate
delivery is a no-op, and returns whether to poll again (`GuidedReviewJobProgress`).

Queued work records which host drives it (`deployment`, or `node:<nodeId>`), and each sweeper
re-drives only its own jobs: a hosted sweeper answering a laptop's question would use the deployment's
model credentials instead of the developer's. A mothership-mode node never scans the mothership; its
local queue is its recovery, and a job it gives up on is settled failed (`abandonJob`) so the thread
does not read as busy forever.

### Answers

An **inline** answer comes from a tool-using model reading the pull request through the VCS API at the
reviewed commit (`list_changed_files`, `read_diff`, `read_file` on either side, `list_directory`).
`PrExplorer` owns the per-job read budget, line and character caps, and secret scrubbing, and states
every refusal to the model as text. The loop's final step forbids tools, so a capped loop still ends
on a reply.

A **deep** answer (`depth: "deep"`) runs a `guided-review-investigator` container: a read-only clone of
the target branch with the PR head fetched, told to check out the reviewed commit. It is dispatched
standalone like the environment dry run's prober, through one dispatch builder per facade shared by
both flows, and its spend is filed like a pipeline step's. It is driven as a state machine on its
message (claim, dispatch, record the dispatch, poll). Each poll refreshes the claim and the answer
settles under the refreshed one, so of two racing pollers only the latest lands; a container still
working after 45 minutes is stopped.

The host lists a pull request's changed files at its current head only, so a job reads the files
and then the head, and fails as `head_moved` when the head is no longer `reviewedHeadSha`: an answer
or a draft anchor never mixes the reviewed commit with a later push. A refresh re-points the session.

Every model call and VCS read runs as the session's creator: `resolveInlineScope` with a `user` subject,
and `runInitiatorScope` around each read, so the initiator-PAT policy applies.

### Drafts and posting

The model drafts; the human posts. A draft survives only on a line inside a diff hunk on its side
(`computeCommentableLines`, the PR-review post's rule). Posting publishes plain review comments under
the caller's credential scope, never an approval or a change request, with each body passed through
`redactSecrets` and `hostMarkdown.prose`. Each draft is claimed before the host call and settled with
the host's per-comment answer, so a retried post never publishes a comment twice and a partial post is
reported per draft. The optional summary comment posts only alongside a claimed draft, so a retry
never repeats it. A post, or a move of a draft, after the pull request moved past `reviewedHeadSha`
is refused as `409 session_stale`.

### Surfaces

- `/workspaces/:workspaceId/guided-reviews` for the SPA, member tier; only a session's creator may
  change it, any member may read it.
- `/api/v1/guided-reviews` (`read` to follow, `write` to open, ask, draft and post), with an SSE stream
  of the session view, documented in `backend/docs/public-api.md` and generated into the four SDKs and
  MCP. The session list is a keyset page, newest created first. A session records whether a person
  or an API key owns it (`createdByKind`): a key bound to a person acts as that person, and an
  unbound key owns its own sessions and runs on the workspace's scope rather than any person's.
- A `guidedReview` workspace event carrying ids only; the SPA store refetches what it has loaded.

## Rationale

- **A standalone session, not a run step.** Exploring a pull request must not need a board task, and
  concurrent threads riding one step's JSON blob would queue every thread behind one rev-guarded write.
- **Background work, not a held request.** A tool-using answer takes up to a minute and a deep one
  several; an API client should not hold a connection per question, and a closed tab should not lose
  the answer.
- **A `node:sqlite` queue on mothership nodes, not pg-boss.** pg-boss needs the Postgres that
  mothership mode exists to remove, and the queue only has to hold the wake-up intent: the job's state
  lives in the mothership through the `remote` repository.
- **The human posts.** The platform does not speak on a pull request under a person's identity without
  that person choosing to; the model's judgement arrives as drafts with their reasoning.
- **Ids-only events.** Workspace events reach every subscriber, so a member who is not viewing a review
  learns only that it moved.

## Consequences

- A password-gated personal subscription cannot serve a guided-review call: the work runs after the
  request returned, with no moment to unlock the credential.
- `CreateReviewComment` carries no start line, so a multi-line draft posts on its last line.
- If the repository fails between the host accepting comments and the settle that records it, a post
  after the claim's lease can publish those comments again. Claiming first bounds that to a repository
  outage at exactly that moment.
- Three enum value sets the guided-review shapes share with earlier operations are pinned to their
  published SDK type names in `scripts/sdk/ir.mjs`, so adding them renamed no released type.
- The local guided-review queue wakes at its earliest due job rather than per re-queue, because a timer
  on the monotonic clock can fire before a wall-clock due time and strand the job until the sweep.
