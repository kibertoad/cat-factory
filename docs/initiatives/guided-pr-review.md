# Initiative: guided PR review

## Goal & rationale

The `pr-reviewer` run (ADR 0023) produces findings: a list of things it believes are wrong. A human
reviewer facing an unfamiliar PR needs something different first: what the change is for, which
parts of the diff carry the meaning, what it affects beyond itself, and where to spend attention.
Then they need to ask questions of it, several at once, and turn what they conclude into review
comments that land on the right lines.

This initiative adds that surface. A **guided review** of one pull request holds:

- an **overview**: what the PR is about, its meaningful changes, consequences, risks, the areas worth
  reviewing, and suggested questions;
- any number of **exploration threads**, each a tab of questions and follow-ups answered by a model
  with read access to the PR. A thread waiting on an answer never blocks another thread;
- **comment drafts** a thread can produce on request: the model formulates review comments from the
  thread's conclusions and picks the anchor (path, line, side). The human edits, re-anchors or drops
  each one and posts the survivors as a single review.

The cat-factory SPA is one client. The full surface is on `/api/v1` so another UI (an IDE plugin, a
browser extension over the host's PR page) can build the same experience.

## Decisions

| Question                 | Decision                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does it live       | A standalone session keyed by workspace, repo and PR number, owned by its creator. No task, no run.                                                                                                                | Exploring a PR must not require a board task. Threads are concurrent writers; riding one run step's JSON blob would put every thread behind one rev-guarded write.                                                                                                                                                              |
| Persistence shape        | Four tables: sessions, threads, messages, comment drafts. One row per message and per draft.                                                                                                                       | Concurrent threads write disjoint rows, so no compare-and-swap loop is shared between them. The session row carries only the overview.                                                                                                                                                                                          |
| One answer per thread    | A partial UNIQUE index on messages admits one non-terminal assistant message per thread. A second question while one is pending is a `ConflictError` with `reason: 'thread_busy'`.                                 | "One live row per X" is a unique index, never a read-then-insert (AGENTS.md, concurrency). Other threads are unaffected.                                                                                                                                                                                                        |
| How answers are produced | Durable background work: the request persists a `pending` assistant message and returns at once; a driver answers it.                                                                                              | A tool-using answer can take a minute. An API client must not hold a connection per question, and a dropped tab must not lose the answer.                                                                                                                                                                                       |
| Durable driver           | A `GuidedReviewRunner` port: Cloudflare Workflows ⇄ a pg-boss queue on Node and standard local ⇄ a `node:sqlite` queue on a mothership-mode node (the `SqliteWorkRunner` shape), plus a stale-job sweeper on each. | Copies `EnvironmentTestRunner`. `waitUntil` is capped at 30s after the response on the Worker. A mothership-mode node has no Postgres, so pg-boss would reintroduce the database that mode removes; the local queue only holds the wake-up intent, while the job state lives in the mothership through the `remote` repository. |
| Claiming a job           | `pending → running` is an atomic conditional update taken before the model call; `running` past its lease is re-claimable; terminal states are not.                                                                | A replaying driver must not answer twice, and a dead claimer must not strand the message.                                                                                                                                                                                                                                       |
| Code access              | Inline model with read tools over the VCS API pinned to the reviewed head SHA: changed files and patches, file contents (head or base), tree listing, code search where the host has it.                           | Answers arrive in seconds with no runner slot. The tools read through `VcsClient`, so GitHub and GitLab behave the same.                                                                                                                                                                                                        |
| Deep dives               | A question can be escalated to a read-only container investigator (a `container-explore` kind, like the challenge investigator).                                                                                   | Some questions need a checkout: grep across the tree, running a script. That costs minutes and a slot, so it is opt-in per question.                                                                                                                                                                                            |
| Posting comments         | The model drafts; the human posts. Drafts are validated against the commentable lines of the diff before they are offered, and the post records a per-draft outcome.                                               | "LLM argues, human audits". The platform does not speak on a PR under someone's identity unchecked. Anchor validation reuses `computeCommentableLines` from the PR-review engine.                                                                                                                                               |
| Head drift               | The session records `reviewedHeadSha`. A push to the PR marks the session stale; `refresh` regenerates the overview at the new head and keeps threads. Posting refuses a stale head.                               | An anchor computed against one head can land on the wrong line at another (the same rule as `detectStaleHead` in the PR-review engine).                                                                                                                                                                                         |
| Realtime                 | One `guidedReviewChanged` publisher method carrying a discriminated delta (session, thread, message, draft). The public API exposes the same deltas as an SSE stream per session.                                  | The SPA patches one tab without refetching the session; an external UI gets the same stream without a WebSocket.                                                                                                                                                                                                                |
| Mothership               | Every repository method is `remote` except `listStaleJobs`.                                                                                                                                                        | Sessions are org state that teammates can read. The stale scan is cross-workspace, so it is a sweeper read.                                                                                                                                                                                                                     |
| Who drives a job         | Queuing work records its `driver`: `deployment`, or `node:<nodeId>` for a mothership-mode node. A sweeper lists only its own driver's stale jobs.                                                                  | The job must run where the engine that queued it runs. A hosted sweeper re-driving a laptop's job would answer with the deployment's model credentials instead of the developer's.                                                                                                                                              |

## Wire model (contracts, valibot)

- `GuidedReviewSession`: `id`, `repoId`, `provider`, `prNumber`, `prTitle`, `reviewedHeadSha`,
  `baseRef`, `createdBy`, `overview: { status: 'pending' | 'running' | 'ready' | 'failed', content?,
error?, model? }`, `stale`, timestamps.
- Overview content: `summary`, `intent`, `meaningfulChanges[] { title, detail, paths[] }`,
  `consequences[] { title, detail }`, `risks[] { title, detail, severity, paths[] }`,
  `focusAreas[] { title, why, anchors[] { path, startLine?, endLine? } }`,
  `suggestedQuestions[] { id, question }`.
- `GuidedReviewThread`: `id`, `sessionId`, `title`, `createdBy`, timestamps.
- `GuidedReviewMessage`: `id`, `threadId`, `role: 'user' | 'assistant'`, `content`, `status:
'pending' | 'running' | 'complete' | 'failed'`, `depth: 'inline' | 'deep'`, `citations[] { path,
startLine, endLine, side }`, `error?`, `model?`, timestamps.
- `GuidedReviewCommentDraft`: `id`, `threadId`, `path`, `line`, `startLine?`, `side`, `body`,
  `rationale`, `status: 'proposed' | 'posted' | 'discarded' | 'failed'`, `postOutcome?`, timestamps.

## Public API surface (`/api/v1`, scope `read` for GET, `write` otherwise)

Every write answers `200` with the persisted state at once; the work it queued completes later.

| Method | Path                                                     | Effect                                            |
| ------ | -------------------------------------------------------- | ------------------------------------------------- |
| POST   | `/guided-reviews`                                        | Open (or return the caller's) session for a PR    |
| GET    | `/guided-reviews`                                        | List sessions, filterable by repo and PR          |
| GET    | `/guided-reviews/{id}`                                   | Session, overview, threads, drafts                |
| POST   | `/guided-reviews/{id}/refresh`                           | Regenerate the overview at the current head       |
| POST   | `/guided-reviews/{id}/threads`                           | Open a thread, optionally with its first question |
| GET    | `/guided-reviews/{id}/threads/{threadId}`                | Thread with its messages                          |
| POST   | `/guided-reviews/{id}/threads/{threadId}/messages`       | Ask a question (`depth` optional)                 |
| POST   | `/guided-reviews/{id}/threads/{threadId}/comment-drafts` | Ask the model to draft comments from the thread   |
| PATCH  | `/guided-reviews/{id}/comment-drafts/{draftId}`          | Edit, re-anchor or discard a draft                |
| POST   | `/guided-reviews/{id}/comment-drafts/post`               | Post the selected drafts as one review            |
| GET    | `/guided-reviews/{id}/events`                            | SSE stream of session deltas                      |

## Slices

| #   | Slice                                                                                                                                 | Status      | PR                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| 1   | Contracts, kernel domain and repository port, D1 migration ⇄ Drizzle schema, both repositories, mothership buckets, conformance suite | in review   | [#2287](https://github.com/kibertoad/cat-factory/pull/2287) |
| 2   | `GuidedReviewService`, overview generation, inline answering with VCS read tools, `GuidedReviewRunner` on all three runtimes, sweeper | in progress |                                                             |
| 3   | Workspace routes for the SPA, `guidedReviewChanged` realtime delta, RBAC                                                              | in progress |                                                             |
| 4   | Public API, OpenAPI, `surface.mjs`, the four SDKs and MCP, SSE stream                                                                 | in progress |                                                             |
| 5   | SPA: guided review window, overview, tabbed threads, suggested questions, drafts panel, i18n in every locale                          | not started |                                                             |
| 6   | Comment drafting and posting (anchor validation, stale-head refusal, per-draft outcomes)                                              | not started |                                                             |
| 7   | Deep-dive escalation to a read-only container investigator                                                                            | not started |                                                             |
| 8   | Website page (opened and merged first), then this tracker becomes an ADR                                                              | not started |                                                             |

## Gotchas

- Model-authored comment bodies reach a rendered host surface. They go through `hostMarkdown`
  (`prose`) and `redactSecrets` at compose time, the same as the PR-review post.
- The overview and every answer are model output shown to a human as data. Suggested questions are
  clicked back into the API verbatim, so they are stored, never re-generated on click.
- `appendExchange` on Postgres locks the thread row first. Without the lock two concurrent questions
  read the same `MAX(seq)`, and the loser trips the `seq` index before the live-answer conflict
  target can resolve, so it errors instead of returning `thread_busy`. SQLite serializes writers and
  cannot show this; the store conformance suite's concurrent-question case does.
- Comment drafting is a message `kind` on its thread, so the busy index covers it and the driver
  has two job types (overview, message). The drafts and the message settle in one atomic write.
- Every model call runs as the SESSION CREATOR (`resolveInlineScope` with a `user` subject, and
  `runInitiatorScope` around each VCS read), because a background driver has no request user.
  Only the creator may change a session; any workspace member may read it.
- A model or VCS failure is settled onto the row with a `failure.reason`; only a repository fault
  propagates, so the driver retries and the claim lease lets the retry take the job back over.
- A password-gated personal subscription cannot serve a guided-review call: the work runs in a
  background driver with no request to unlock the credential from, so such a preset settles the
  job as `model_unavailable` or `generation_failed`. A preset on a deployment or account key works.
- The `guidedReview` event carries ids only (`GuidedReviewChange`) and the SPA store refetches what
  it has loaded, taking a ticket per fetch so a reply overtaken by a newer fetch never lands.
- A per-thread answer budget (turns and tool steps) is recorded on the message when it cuts an answer
  short, never silently truncated.
