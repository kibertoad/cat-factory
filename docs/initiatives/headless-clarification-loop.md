# Initiative: headless clarification loop

**Status:** complete (slices 1 + 2a landed here; slice 2b delivered by the tracker-webhook initiative) · **Owner:** core · **Started:** 2026-07-26

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The requirements-review loop is the platform's clarification machinery: the reviewer raises
findings, the run parks on a durable decision-wait, a human answers/dismisses, an
incorporation pass folds the answers in, and the run advances (see the "Requirements review
flow" section of [`CLAUDE.md`](../../CLAUDE.md)). Today that loop is reachable ONLY through
the SPA:

- `PublicApiController` refuses **at admission** any pipeline containing an
  inline-and-parking kind (`PARKING_INLINE_KINDS`: the two review gates plus the two
  brainstorm dialogues), because a public run is headless: there is no way to answer, so a
  parked run would sit `blocked` forever while its anchor holds a concurrency slot.
- `IssueWritebackService` writes back to a task's linked tracker issue only at PR-opened and
  PR-merged. It never posts the reviewer's questions, and nothing ingests a reply.

**Scope boundary (load-bearing).** Tasks created or imported through the SPA are
human-overseen by design: the SPA loop remains their clarification surface, and this work
must not change their behaviour by default. The gap is runs started HEADLESSLY via the
public API: those currently cannot include clarification at all.

**End state.** A headless run parks, its open findings reach the caller and/or the linked
ticket, an answer arriving by API call or ticket reply resumes the run, and the loop
converges: with the SPA flow completely unchanged.

## Slices

| #   | Slice                                                                              | Status         | PR        |
| --- | ---------------------------------------------------------------------------------- | -------------- | --------- |
| 1   | Parked decisions over the public API (surface, admission, intake origin, park-out) | ✅ done        | #1368     |
| 2a  | Questions OUT to the linked tracker issue (headless-origin, opt-in, idempotent)    | 🟡 in progress | this PR   |
| 2b  | Replies back IN (the D4 grammar, per-provider ingest, identity, loop policy)       | ✅ done        | see below |

Detailed per-item checklists live at the end of each slice section.

**Why slice 2 is split.** As designed in D4–D8 it is two independent halves with a clean seam
between them: the question comment (persistence + the engine park hook) and the reply ingest (a
grammar, two ingest transports, an identity allow-list, cursor dedup, follow-up comments). 2a is
useful on its own: the comment renders each finding's stable id, which is exactly what
`POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` from slice 1 takes, so the
loop already closes over the API. 2b then upgrades the answer channel from "the API, using the ids
we posted" to "reply in the ticket". Landing them together would have made one PR roughly three
times the size of slice 1 with no reviewable seam in the middle.

---

## Decisions

These are the decisions the task brief asked to be settled HERE rather than in a PR
description. Each records the reasoning, so a later slice extends rather than re-derives it.

### D1: The admission guard relaxes behind a new `decide` scope, not for every key

**The guard's real reasoning** (worth restating, because it is easy to read as paranoia):
`isHeadlessInlinePipeline` rejects a parking kind not because parking is unsafe, but because
a parked headless run **never resolves**. Its anchor block stays `in_progress`, so
`countActiveInternalTasks` keeps counting it against `MAX_ACTIVE_INITIATIVE_RUNS`: five
abandoned parks permanently wedge a workspace's initiative surface.

**The brief suggested leaning on "the existing decision timeout" as the backstop. There
isn't one.** `ExecutionWorkflow` deliberately waits for a human INDEFINITELY: the hard
decision timeout that used to fail a parked run was removed on purpose (a run may legitimately
wait as long as it takes; urgency is surfaced by the notification escalating, not by killing
the run). `ExecutionConfig.decisionTimeout` survives only as the chunk length of
Cloudflare's `waitForEvent`, and on expiry the workflow **re-loops and re-arms the wait**. So
"the decision timeout will eventually reap it" is not an available backstop, and a design
that assumed it would leak slots forever.

**Decision.** Three parts, all in slice 1:

1. **A new `decide` tier on the public-API scope ladder**, between `write` and `admin`
   (`read ⊂ write ⊂ decide ⊂ admin`). The ladder stays linear and inclusive, so
   `scopeSatisfies` is unchanged. Answering a decision is strictly more consequential than
   creating/starting a task (it injects caller-supplied prose into the requirements every
   downstream agent then implements, and it un-parks a run) and strictly less than deleting a
   task or performing a real merge, which is exactly the gap between `write` and `admin`.
2. **Parking kinds are admitted only for a key that satisfies `decide`.** A plain `write` key
   sees exactly today's behaviour, including today's `pipeline_not_inline` refusal. Minting a
   `decide` key is the operator asserting "this integration is the headless overseer for these
   runs": the guard becomes a deliberate opt-in rather than a blanket refusal.
3. **The caller can always free a slot**: `POST /api/v1/jobs/:id/cancel` stops a headless
   initiative run (the board surface already had `POST /api/v1/tasks/:taskId/stop`). Without
   it the concurrency cap is a wall with no door: bounded, but unrecoverable without SPA
   access. With it, an abandoned park is a bounded, visible, self-serviceable `429`.

The `PARKING_INLINE_KINDS` set itself stays exactly where it is, with its reasoning updated
in place: it is still the right list, it is now a _scope_ question rather than a flat ban.

**Deliberately NOT done:** no automatic reaping of parked headless runs. Re-introducing a
run-killing timeout would regress the deliberate "wait indefinitely" behaviour for every run,
not just public ones. The cap plus `cancel` bounds the blast radius without that regression.

### D2: Intake origin is a persisted run field, in the `detail` JSON

Slice 2 keys off _how a run entered the system_ (question writeback fires for headless-origin
runs only). `initiatedBy` cannot answer this: it is `null` for a public-API run AND for a
recurring-schedule fire AND for auth-disabled local dev. `RunStartOptions.origin`
(`'manual' | 'recurring'`) is about pipeline _availability_ gating and is not persisted.

**Decision.** Add `ExecutionInstance.intakeOrigin: 'ui' | 'public-api'` (absent ⇒ `ui`, which
is what every legacy run is). It rides the `agent_runs.detail` JSON through the SHARED
`@cat-factory/server` mappers, so both runtimes gain it in one edit with **no migration**:
the same seam `initiatedBy` / `createdAt` / `diagnostics` already use. `RunStartOptions`
grows a matching optional field, set by the two public-API start paths (`POST /jobs`
and `POST /tasks/:taskId/start`) and nowhere else. `retry` / `restart` carry the previous
run's value forward, exactly like `initiatedBy`.

Naming: `intakeOrigin`, not `origin`; `RunOrigin` is taken and means something else.

**Amended after the tracker-webhook initiative landed** (ADR 0032). The vocabulary gained two
members, `tracker` (a run a per-ticket intake schedule dispatched from a pushed ticket) and
`schedule` (a cadence fire, or the queue-drain push that only makes the tick happen sooner). The
writeback gate now asks the CLASSIFICATION (`isHeadlessIntake` in `@cat-factory/contracts`, a
`Record` over the picklist so a new member has to answer it) rather than `=== 'public-api'`.

The equality test was the actual defect, not a simplification that aged: per-ticket dispatch is
headless by construction, its questions have exactly one place to go, and its reply channel was
already ungated, so a ticket-driven trial parked and told nobody while the loop looked wired.

Two rules carry forward from that.

- **`ui` is a POSITIVE claim that a human is watching in the app**, never a catch-all for "nothing
  said". Every unattended start path states its origin; only the in-app start may take the
  default. The field has to stay optional for that one caller, so the rule cannot be a typecheck:
  `intakeOrigin.coverage.spec.ts` classifies each start path instead, and a new one fails there
  until someone answers it.
- **The classification is not "was anyone present" but "is there a STABLE place to hold a
  conversation."** That is why `schedule` is `false` despite being unattended: a fire works the
  schedule's REUSED block, and queue mode's `BugIntakeService` replace-links each pick onto it, so
  a question posted there loses its reply channel on the next fire (the reply resolves to no block
  and is dropped). Making queue mode clarify on its ticket is a change to the LINKAGE (a per-run
  link, or a block per pick, which is what per-ticket dispatch already is), never a flip of the
  flag: the flip alone would post the question and discard the answer, which is worse than the
  silence it replaces.

### D3: Park notification out: SSE frames plus a webhook `NotificationChannel`

A caller should not have to poll to learn its run parked. Both shapes ride existing seams:

- **SSE.** Both public streams already re-read the persisted run each tick. A parked run now
  emits an explicit `decision` frame (rather than the jobs stream's terminal-looking `stopped`)
  and the jobs stream **keeps polling** through `blocked`, because `blocked` is no longer a
  dead end for a decide-scoped caller.
- **Webhook.** A new `WebhookNotificationChannel` in `@cat-factory/integrations`, composed
  into the existing `CompositeNotificationChannel` beside the in-app and Slack channels: the
  seam that exists for exactly this. Endpoint + secret are a persisted per-workspace setting
  (`notification_webhooks`, D1 ⇄ Drizzle), and delivery is best-effort.

The channel is type-filtered per workspace (default: the parking types), so enabling it does
not fire-hose every notification at an integration that only cares about parks.

**The same endpoint later grew a second event family**: run-lifecycle events (`run.started` /
`run.completed` / `run.failed`), delivered through the kernel `RunLifecycleSink` port over the
shared `signedDelivery.ts` core. That closes the other half of the polling problem: a parked run is
what a notification announces, but the HAPPY path raises no card at all (a pipeline whose `merger`
merges its own PR settles with an empty inbox). Its `runEvents` filter is opt-in: empty means NONE,
deliberately the opposite of the `types` filter above, so an endpoint registered for parked
decisions never starts receiving an event per run. See
[ADR 0030](../../backend/docs/adr/0030-public-api-surface.md).

Three properties of the delivery path are load-bearing and easy to regress:

- **Signing is a DETACHED HMAC, not the server's `HmacSigner`.** That primitive mints
  self-contained tokens whose payload travels inside the signed string and is audience-keyed;
  a webhook needs a signature detached from a body the receiver already has. Decisively,
  `@cat-factory/server` sits ABOVE `integrations`, so importing it here would invert the
  layering. `webhookSignature.ts` is the plain Web Crypto HMAC-SHA256 both use underneath, over
  `<timestamp>.<body>` so the timestamp is bound into the MAC and a replay window is meaningful.
- **The endpoint rides the shared SSRF seam, at BOTH boundaries.** The URL is operator-supplied
  and the body carries the workspace's work descriptions, so `NotificationWebhookService.put`
  rejects a private/internal/metadata host up front AND delivery goes through `safeFetch`, which
  re-runs the guard on every redirect hop. Validating only the stored URL vouches for the FIRST
  hop; a receiver is free to 302 the delivery at `169.254.169.254`, and the signature headers are
  custom so the platform's own cross-origin `Authorization` stripping would not cover them.
  Widened only by the webhook's OWN config slice (`NOTIFICATION_WEBHOOK_ALLOW_*`), never another
  integration's, since this is the one target URL a _workspace_, not the operator, chooses.
- **The retry budget is a wall-clock deadline, not an attempt count.** `NotificationService.raise`
  AWAITS the channel fan-out, so this time is latency on the engine step that parks the run.
  Three 5s attempts plus backoff would let a dead receiver add ~15.8s to a park, which no other
  channel does. Attempts stop when the total budget is gone, and each attempt's timeout is clamped
  to what remains.

**The webhook is an EXTERNAL channel** (everything that is not the in-app push), so it composes
into that set on both facades rather than only into the local fan-out: the set the mothership
delivers on a node's behalf. Its secret is sealed with the deployment key, so the deployment
holding that key is the only side that can decrypt and deliver it; keeping it out of the external
set would leave a mothership-mode laptop failing every delivery on a decrypt it cannot perform
while the mothership never attempted one.

### D4: Ticket reply grammar (slice 2): explicit commands, never natural-language guessing

A comment is scanned line by line; only lines whose first non-space token is the trigger are
interpreted. Everything else is ignored: including prose in the same comment, so a human can
answer and discuss in one message.

```
@cat-factory answer <itemId> <free text to end of line>
@cat-factory dismiss <itemId>
@cat-factory proceed
@cat-factory stop
@cat-factory extra-round
```

- `<itemId>` is the review item's stable id, rendered verbatim beside each finding in the
  question comment.
- Multi-line answers: a `answer` command's text continues onto following lines until the next
  trigger line or the end of the comment.
- An unknown command, an unknown item id, or a command for a review that has already settled
  is **reported in the follow-up comment**, never silently dropped (see D6).
- `proceed` / `stop` / `extra-round` map onto the same three `resolveExceeded` choices the SPA
  offers; `proceed` outside the `exceeded` state maps to the ordinary proceed action.

### D5: Per-provider ingest transport (slice 2)

| Provider | Transport                                                                                                | Rationale                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GitHub   | The existing webhook ingest gateway (`issue_comment` delivery) → the same async queue the sync path uses | GitHub App webhooks are already received, verified and queued; adding an event type is a handler, not a transport |
| Jira     | Polling sweep                                                                                            | Jira Cloud webhooks require per-site app registration the platform does not perform today                         |
| Linear   | Polling sweep                                                                                            | Linear webhooks need per-workspace registration; the GraphQL comment read batches cleanly by issue id             |

The sweep is one runtime-symmetric job (Worker `scheduled` cron ⇄ Node timer/pg-boss, per
"Keep the runtimes symmetric"), and it reads **in batches**: collect every parked
headless-origin review's linked issues via `TaskRepository.listByRefs`, then one batched
comment read per provider, never a point-read per parked run.

Dedup state is a `tracker_comment_cursors` row per `(workspace, provider, externalId)`
carrying the last ingested comment id/timestamp, so a re-delivered webhook or an overlapping
sweep window applies each reply exactly once.

### D6: Loop policy for ticket mode (slice 2)

The SPA loop has a human clicking incorporate / re-review / the three-way exceeded choice.
Ticket mode needs defaults:

- A reply that leaves **no `open` finding** auto-triggers incorporation; the durable driver
  re-reviews as it already does on the async path.
- A reply that leaves findings open records the answers and posts a follow-up naming what is
  still outstanding. No incorporation.
- On `exceeded`, the follow-up comment states the three options and the run **stays parked**.
  There is deliberately **no timed auto-proceed**: per D1 there is no decision timeout to
  hang one off, and inventing one here would silently ship requirements nobody approved. An
  operator-configurable auto-choice is a possible follow-up, not a default.
- A reply landing after the park already settled gets a "the review has already moved on"
  follow-up comment rather than a silent drop.

### D7: Threat model for ticket replies (slice 2)

Ticket replies are **external content that resumes a run**, and on a public GitHub repo
anyone can write one. Three layers:

1. **Identity.** A reply is only ingested when its author resolves to an allowed identity:
   the tracker connection's configured allow-list where present, else a workspace member
   matched on the provider identity the platform already stores (GitHub login / Jira
   accountId / Linear email). An unauthorized reply is ignored: logged, no state change, no
   follow-up comment (replying would confirm the hook exists and hand an attacker an oracle).
2. **Data, not instructions.** Reply text becomes `item.reply` (the same field the SPA
   writes) and reaches the model only through the existing incorporation prompt, which
   already renders answers as delimited untrusted input. No reply text is ever interpreted as
   a command outside the D4 grammar, and the grammar has no verb that can reach outside the
   review (no model selection, no pipeline choice, no repo write).
3. **Budget.** The per-review iteration cap (`maxRequirementIterations`) already bounds how
   many LLM cycles a chatty issue thread can drive; the cursor dedup bounds replay.

### D8: Reliability of the question-out (slice 2)

Writeback today is fire-and-forget best-effort. That is acceptable for a courtesy PR comment
and NOT acceptable for the question comment: a silently failed post leaves a run parked with
nobody told. A failed question post raises the existing in-app `requirement_review`
notification (the same card the SPA park raises), so the park is never invisible even when the
tracker is unreachable.

Idempotency: a `review_question_posts` marker per `(workspace, review, iteration, issue ref)`
is written INSERT-OR-IGNORE style before the comment is considered done, so the durable
driver's replays cannot double-post.

---

## Slice 1: parked decisions on the public API

### What lands

- **`decide` scope** (`PUBLIC_API_SCOPES`), between `write` and `admin`.
- **`ExecutionInstance.intakeOrigin`**, persisted in the `detail` JSON via the shared mappers.
- **Admission relaxation** in `PublicApiController`: parking pipelines admitted for a key that
  satisfies `decide`; `POST /api/v1/jobs/:id/cancel` so a park is always recoverable.
- **The public decision surface**, keyed by RUN id so it serves both a headless initiative job
  and a board task run:
  - `GET /api/v1/runs/:runId/decisions`; the run's open decisions.
  - `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply`
  - `PATCH /api/v1/runs/:runId/decisions/requirements/items/:itemId`
  - `POST /api/v1/runs/:runId/decisions/requirements/incorporate`
  - `POST /api/v1/runs/:runId/decisions/requirements/re-review`
  - `POST /api/v1/runs/:runId/decisions/requirements/proceed`
  - `POST /api/v1/runs/:runId/decisions/requirements/resolve-exceeded`
  - `POST /api/v1/runs/:runId/decisions/fork/choose`

  Every one delegates to the SAME service method the SPA controller calls
  (`RequirementReviewService` via `executionService.requirementsReview`,
  `executionService.chooseFork`), no parallel logic, so the CAS/approval-id arbitration and
  the preset knobs apply identically.

- **Park out**: the `decision` SSE frame on both streams, and the workspace-configurable
  HMAC-signed webhook `NotificationChannel`.

### Checklist

| #    | Item                                                                                     | Status  |
| ---- | ---------------------------------------------------------------------------------------- | ------- |
| 1.1  | `decide` scope on the ladder (+ the SPA token picker + all 10 locales)                   | ✅ done |
| 1.2  | `intakeOrigin` on `ExecutionInstance` + `RunStartOptions` + shared mappers               | ✅ done |
| 1.3  | Admission relaxation + `POST /api/v1/jobs/:id/cancel`                                    | ✅ done |
| 1.4  | Public decision contracts (`@cat-factory/contracts`)                                     | ✅ done |
| 1.5  | `PublicDecisionController` (delegating, no parallel logic)                               | ✅ done |
| 1.6  | `decision` SSE frames on both public streams (which now stay open across a park)         | ✅ done |
| 1.7  | `notification_webhooks` persistence, D1 ⇄ Drizzle + a repository-parity suite            | ✅ done |
| 1.8  | `WebhookNotificationChannel` + HMAC signing + bounded retry, wired in both facades       | ✅ done |
| 1.9  | Conformance: list → answer a park over `/api/v1`, scoping + scope refusal, both runtimes | ✅ done |
| 1.10 | Individual-usage runs across a park; see the note below                                  | ✅ done |
| 1.11 | Docs sweep (OpenAPI, CLAUDE.md, AGENTS.md) + changeset                                   | ✅ done |

**On 1.10 (individual-usage models).** The brief asked to verify the resume path needs nothing
new and add a conformance case. Verified: `personalGateForBlock` / `personalGateForRun` refuse an
individual-usage model at the public START and RETRY boundaries, so a headless run on such a model
never exists; there is no parked run of that shape for a resume to break. The run-scoped
activation is cleared only when the run reaches a TERMINAL state (`emitInstance` →
`deleteByExecution`), and a park is not terminal, so an activation would outlive a park regardless.
A conformance case asserting "an individual-usage run resumes across a park" would therefore have
to construct a state the public surface refuses to create: it would assert the fake, not the
product. The existing refusal is covered by the public-API integration specs; the honest outcome is
that this needs nothing, recorded here rather than papered over with a vacuous test.

**On the admission guard's coverage.** The relaxation is exercised as a unit test
(`publicApiAdmission.test.ts`) rather than over the wire, because the ONLY public pipeline is the
built-in one and built-ins are read-only: there is no way to construct a public-and-parking
pipeline through the API. The policy is pure logic in the SHARED controller layer, so it cannot
drift between facades; what conformance asserts instead is that each facade wires the agent-kind
registry the `headlessStartable` flag is computed against.

**Deferred from slice 1 (deliberately, not forgotten).**

- No SPA UI for the notification webhook: it is managed over
  `GET|PUT|DELETE /workspaces/:ws/notification-webhook` (behind `integrations.manage`). The
  consumer of this feature is a headless integration whose operator is already using the API; a
  settings panel is worth adding when a human-facing deployment wants it (it would now carry the
  `runEvents` selector too).
- The fork-decision CHAT is not exposed publicly: it is an interactive deliberation affordance,
  and a headless caller already receives each fork's full approach/trade-offs/risk text.

### Conventions & gotchas carried forward

- **A parked run waits forever.** Do not design anything on the assumption that a decision
  wait expires (see D1). It does not.
- **The park is arbitrated by CAS/approval id already.** Slice 1 adds a second answer surface
  and slice 2 a third; none of them may invent arbitration. Verify the loser is REJECTED
  cleanly rather than adding a lock.
- **An answer surface must carry the RUN's initiator, not the caller's.** The SPA controllers
  wrap the run-resuming actions in `runWithInitiator(c.get('user')?.id, …)` so the resumed run's
  container work uses that user's PAT (`PatPreferringAppRegistry` reads `currentInitiator()`).
  A non-SPA surface has no acting user, but "so skip the scope" is WRONG, because these routes
  are keyed by run id and deliberately accept a BOARD task run, which was very likely started in
  the SPA and does carry a `usr_*` initiator. Pass `execution.initiatedBy`: correct for both, and
  a no-op on a genuinely headless run (`null`). Slice 2's ticket surface must do the same.
- **`intakeOrigin` rides `detail`.** Adding a run field there is free (no migration) but it is
  parsed tolerantly: an unknown value must degrade to `ui`, never throw the snapshot.
- **The scope ladder is index-ordered.** `PUBLIC_API_SCOPES` order IS the ladder;
  inserting a tier shifts `admin`'s index, which is fine (stored values are strings) but any
  code comparing raw indices across a version boundary is not.
- **A tracker-writeback surface runs in the DURABLE driver, so it must be idempotent by a
  CLAIM, not by a post-hoc marker.** The gate step replays; writing the marker after a
  successful post still double-posts when the process dies in between. Both facades therefore
  express `claim` as ONE atomic insert-or-conditionally-update that reports ownership, and the
  parity suite exists specifically because the two dialects express it very differently
  (`ON CONFLICT … DO UPDATE … WHERE … RETURNING` vs Drizzle's `setWhere`). Slice 2b's cursor
  dedup is the same shape: copy the marker repo, don't invent a read-then-write.
- **…and a claim-before-post MUST answer "what if the claimer dies".** The first cut of 2a made a
  `pending` row terminal, which silently converted every mid-post death (an evicted isolate, a
  killed durable step) into questions that were never posted and never retried: a never-post
  traded for the double-post, and the harder failure to notice of the two. A `pending` claim is
  therefore stealable once older than `REVIEW_QUESTION_POST_CLAIM_TTL_MS`, pinned in the parity
  suite from BOTH sides (fresh claim held, abandoned claim taken over, `posted` never stolen).
  Carry this into 2b's cursor: any "I own this now" row needs an abandonment window.
- **Do NOT bound such a post with a wall-clock deadline.** It looks like the obvious hardening,
  but a timeout cannot distinguish "the comment never landed" from "it landed, slowly": settling
  `failed` on that guess makes the next replay post a second copy onto a customer's issue. Cut a
  hung transport off with the driver's own step limit and let the abandonment window recover it.
- **Order the park BEFORE the outbound call.** A run that failed to park answers nobody, so the
  durable state change must never queue behind a third party's HTTP. Same rule for 2b's ingest:
  commit the state, then talk to the tracker.
- **A tracker comment is as exposed as a PR body: render through the same boundary.** The
  findings are model-authored prose derived from a customer's task description, landing on a
  frequently PUBLIC issue that the host parses: `@name` pages a real account, `#123` cross-links
  an unrelated issue, an unbalanced fence swallows the answer instructions the comment exists to
  deliver, and a pasted token is republished. Everything interpolated crosses kernel's
  `hostMarkdown` (`inline`/`cell`/`prose`) plus `redactSecrets`: the boundary was lifted out of
  the PR report into kernel for exactly this second consumer. 2b renders replies/acks the same way.
- **`TrackerSettingsService.put` REPLACES the row.** Any new setting must be added to the SPA's
  save payload in the same change, or an operator saving the tracker panel silently resets it.
- **Adding a workspace-scoped table means one line in `WORKSPACE_SCOPED_TABLES`** (kernel
  `domain/workspace-cascade.ts`): both facades' delete cascade is driven from it, and a
  completeness test fails the build if a `workspace_id` table is missing.

---

## Slice 2a: questions out to the ticket

### What lands

- **`writebackQuestionsOnPark`** on `TrackerSettings` + the per-task `Block.trackerQuestionsOnPark`
  override, resolved through the existing `resolveWritebackFlag` (the same shape as the
  PR-open/PR-merge flags), with both surfaced in the SPA beside their siblings.
- **`IssueWritebackProvider.postReviewQuestions`**: the provider half: the workspace opt-in, the
  linked-issue lookup, the rendered comment, and the per-issue idempotency marker. It reuses the
  existing per-provider comment paths (GitHub comment / Jira ADF / Linear GraphQL) unchanged.
- **The engine half**: `shouldPostReviewQuestions` / `buildReviewQuestionPost`
  (`reviewQuestionWriteback.logic.ts`) plus a single `ReviewGateController.park()` that EVERY
  requirements park funnels through, so a future branch cannot forget the echo.
- **`review_question_posts`**, D1 ⇄ Drizzle + a repository-parity conformance suite.

### Checklist

| #    | Item                                                                             | Status  |
| ---- | -------------------------------------------------------------------------------- | ------- |
| 2a.1 | `writebackQuestionsOnPark` setting + `trackerQuestionsOnPark` block override     | ✅ done |
| 2a.2 | `postReviewQuestions` port + `IssueWritebackService` implementation              | ✅ done |
| 2a.3 | Comment renderer (stable ids, iteration, the answer channel, capped + declared)  | ✅ done |
| 2a.4 | Engine park hook, gated on a HEADLESS `intakeOrigin` (see the D2 amendment)      | ✅ done |
| 2a.5 | `review_question_posts` persistence, D1 ⇄ Drizzle, wired in both facades         | ✅ done |
| 2a.6 | Conformance: marker parity (the atomic claim) + the settings/override round-trip | ✅ done |
| 2a.7 | SPA: the workspace toggle + the per-task override, all 10 locales                | ✅ done |
| 2a.8 | Docs sweep + changeset                                                           | ✅ done |

**On the subject scope.** The echo rides the REQUIREMENTS subject only (`ReviewKind.questionsOnPark`).
The clarity gate already echoes its questions from its own `review()` closure as INTAKE semantics
(every run, UI or headless, ungated by the workspace writeback settings) so opting it in here would
post the same questions twice. A brainstorm dialogue has no linked-issue surface at all.

**On D8's in-app fallback.** The design asked for a failed question post to raise the in-app
`requirement_review` card so the park is never invisible. That card is already raised
unconditionally by `IterativeReviewService.notifyFindings` on every reviewer pass that yields
findings (on the review path, entirely independent of any tracker) so the fallback holds by
construction and a second card would only duplicate it. What the writeback adds instead is that the
failure is not SILENT: the provider returns a `{ posted, skipped, failed }` outcome, the gate logs
a failure through the facade logger, and the marker row keeps the last error and stays re-claimable
so the next driver replay retries it. Recorded here rather than papered over with a redundant card.

**Deferred from slice 2a (deliberately).**

- The comment is markdown rendered through the existing per-provider paths; no per-provider
  formatting variant (a Jira ADF table, a Linear-native block): worth it only if a reader complains.
- No follow-up comment when the review settles. That belongs with 2b, where a reply can settle it.

## Slice 2b (replies back in) DELIVERED BY THE TRACKER-WEBHOOK INITIATIVE

Slice 2b landed as part of
[`0032-tracker-webhook-intake.md`](./tracker-webhook-intake.md), which is its durable source of truth
(its D4–D7 supersede the notes here). It was folded into that initiative rather than built
standalone because the two share their entire transport: 2b needs a verified, parsed inbound
tracker event keyed `(source, externalId)`, and that ingestion seam is exactly what push-driven
intake needed as well. Building 2b alone would have meant building that seam for ONE consumer and
then reworking it for the second.

What actually shipped, against the design above:

- **The grammar is D4 verbatim** (`parseReviewReplyCommands`, `@cat-factory/integrations`
  `writeback/reviewReplies.logic.ts`), parsing against the SAME finding ids
  `renderReviewQuestionsComment` renders: the two are deliberate SIBLINGS in one directory so a
  change to either cannot silently desync them.
- **Ingest is WEBHOOK-only for all three providers**, not the per-provider split D5 proposed. D5
  routed Jira and Linear to a polling sweep on the grounds that their webhooks need per-site /
  per-workspace registration the platform does not perform. That is still true, but registration
  turns out to be an OPERATOR paste (a delivery URL + a minted secret), not something the platform
  must automate, and a sweep would have added a second runtime-symmetric cron, a second dedup
  story, and a per-provider comment-listing read for a latency strictly worse than push. So all
  three ride one receiver, and the operator pastes.
- **Dedup is `tracker_comment_ingests`, not `tracker_comment_cursors`.** With no polling sweep
  there is no window to advance a cursor over; what remains is "did we already apply THIS comment",
  which is the `review_question_posts` claim shape: carried across verbatim, abandonment window
  included, per the convention that tracker did well to record.
- **The identity allow-list (D7) and the loop policy (D6) shipped as designed**, including the
  follow-up comment 2a deliberately left out (`IssueWritebackProvider.postReviewReplyAck`).
- **Conformance** covers the receiver's guards, an applied reply, and a redelivery applying once,
  on both runtimes; the marker parity has its own suite alongside 2a's.
