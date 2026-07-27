# Initiative: headless clarification loop

**Status:** in progress (slice 1 landed; slice 2 next) · **Owner:** core · **Started:** 2026-07-26

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The requirements-review loop is the platform's clarification machinery: the reviewer raises
findings, the run parks on a durable decision-wait, a human answers/dismisses, an
incorporation pass folds the answers in, and the run advances (see the "Requirements review
flow" section of [`CLAUDE.md`](../../CLAUDE.md)). Today that loop is reachable ONLY through
the SPA:

- `PublicApiController` refuses **at admission** any pipeline containing an
  inline-and-parking kind (`PARKING_INLINE_KINDS` — the two review gates plus the two
  brainstorm dialogues), because a public run is headless: there is no way to answer, so a
  parked run would sit `blocked` forever while its anchor holds a concurrency slot.
- `IssueWritebackService` writes back to a task's linked tracker issue only at PR-opened and
  PR-merged. It never posts the reviewer's questions, and nothing ingests a reply.

**Scope boundary (load-bearing).** Tasks created or imported through the SPA are
human-overseen by design — the SPA loop remains their clarification surface, and this work
must not change their behaviour by default. The gap is runs started HEADLESSLY via the
public API: those currently cannot include clarification at all.

**End state.** A headless run parks, its open findings reach the caller and/or the linked
ticket, an answer arriving by API call or ticket reply resumes the run, and the loop
converges — with the SPA flow completely unchanged.

## Slices

| #   | Slice                                                                                | Status         | PR      |
| --- | ------------------------------------------------------------------------------------ | -------------- | ------- |
| 1   | Parked decisions over the public API (surface, admission, intake origin, park-out)   | 🟡 in progress | this PR |
| 2   | Questions out to the linked tracker issue, replies back in (headless-origin, opt-in) | ⬜ todo        |         |

Detailed per-item checklists live at the end of each slice section.

---

## Decisions

These are the decisions the task brief asked to be settled HERE rather than in a PR
description. Each records the reasoning, so a later slice extends rather than re-derives it.

### D1 — The admission guard relaxes behind a new `decide` scope, not for every key

**The guard's real reasoning** (worth restating, because it is easy to read as paranoia):
`isHeadlessInlinePipeline` rejects a parking kind not because parking is unsafe, but because
a parked headless run **never resolves**. Its anchor block stays `in_progress`, so
`countActiveInternalTasks` keeps counting it against `MAX_ACTIVE_INITIATIVE_RUNS` — five
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
   task or performing a real merge — which is exactly the gap between `write` and `admin`.
2. **Parking kinds are admitted only for a key that satisfies `decide`.** A plain `write` key
   sees exactly today's behaviour, including today's `pipeline_not_inline` refusal. Minting a
   `decide` key is the operator asserting "this integration is the headless overseer for these
   runs" — the guard becomes a deliberate opt-in rather than a blanket refusal.
3. **The caller can always free a slot**: `POST /api/v1/jobs/:id/cancel` stops a headless
   initiative run (the board surface already had `POST /api/v1/tasks/:taskId/stop`). Without
   it the concurrency cap is a wall with no door — bounded, but unrecoverable without SPA
   access. With it, an abandoned park is a bounded, visible, self-serviceable `429`.

The `PARKING_INLINE_KINDS` set itself stays exactly where it is, with its reasoning updated
in place — it is still the right list, it is now a _scope_ question rather than a flat ban.

**Deliberately NOT done:** no automatic reaping of parked headless runs. Re-introducing a
run-killing timeout would regress the deliberate "wait indefinitely" behaviour for every run,
not just public ones. The cap plus `cancel` bounds the blast radius without that regression.

### D2 — Intake origin is a persisted run field, in the `detail` JSON

Slice 2 keys off _how a run entered the system_ (question writeback fires for headless-origin
runs only). `initiatedBy` cannot answer this: it is `null` for a public-API run AND for a
recurring-schedule fire AND for auth-disabled local dev. `RunStartOptions.origin`
(`'manual' | 'recurring'`) is about pipeline _availability_ gating and is not persisted.

**Decision.** Add `ExecutionInstance.intakeOrigin: 'ui' | 'public-api'` (absent ⇒ `ui`, which
is what every legacy run is). It rides the `agent_runs.detail` JSON through the SHARED
`@cat-factory/server` mappers, so both runtimes gain it in one edit with **no migration** —
the same seam `initiatedBy` / `createdAt` / `diagnostics` already use. `RunStartOptions`
grows a matching optional field, set by the two public-API start paths (`POST /initiatives`
and `POST /tasks/:taskId/start`) and nowhere else. `retry` / `restart` carry the previous
run's value forward, exactly like `initiatedBy`.

Naming: `intakeOrigin`, not `origin` — `RunOrigin` is taken and means something else.

### D3 — Park notification out: SSE frames plus a webhook `NotificationChannel`

A caller should not have to poll to learn its run parked. Both shapes ride existing seams:

- **SSE.** Both public streams already re-read the persisted run each tick. A parked run now
  emits an explicit `decision` frame (rather than the jobs stream's terminal-looking `stopped`)
  and the jobs stream **keeps polling** through `blocked`, because `blocked` is no longer a
  dead end for a decide-scoped caller.
- **Webhook.** A new `WebhookNotificationChannel` in `@cat-factory/integrations`, composed
  into the existing `CompositeNotificationChannel` beside the in-app and Slack channels — the
  seam that exists for exactly this. Endpoint + secret are a persisted per-workspace setting
  (`notification_webhooks`, D1 ⇄ Drizzle), and delivery is best-effort.

The channel is type-filtered per workspace (default: the parking types), so enabling it does
not fire-hose every notification at an integration that only cares about parks.

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
  Widened only by the webhook's OWN config slice (`NOTIFICATION_WEBHOOK_ALLOW_*`) — never another
  integration's, since this is the one target URL a _workspace_, not the operator, chooses.
- **The retry budget is a wall-clock deadline, not an attempt count.** `NotificationService.raise`
  AWAITS the channel fan-out, so this time is latency on the engine step that parks the run.
  Three 5s attempts plus backoff would let a dead receiver add ~15.8s to a park, which no other
  channel does. Attempts stop when the total budget is gone, and each attempt's timeout is clamped
  to what remains.

**The webhook is an EXTERNAL channel** (everything that is not the in-app push), so it composes
into that set on both facades rather than only into the local fan-out — the set the mothership
delivers on a node's behalf. Its secret is sealed with the deployment key, so the deployment
holding that key is the only side that can decrypt and deliver it; keeping it out of the external
set would leave a mothership-mode laptop failing every delivery on a decrypt it cannot perform
while the mothership never attempted one.

### D4 — Ticket reply grammar (slice 2): explicit commands, never natural-language guessing

A comment is scanned line by line; only lines whose first non-space token is the trigger are
interpreted. Everything else is ignored — including prose in the same comment, so a human can
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

### D5 — Per-provider ingest transport (slice 2)

| Provider | Transport                                                                                                | Rationale                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GitHub   | The existing webhook ingest gateway (`issue_comment` delivery) → the same async queue the sync path uses | GitHub App webhooks are already received, verified and queued; adding an event type is a handler, not a transport |
| Jira     | Polling sweep                                                                                            | Jira Cloud webhooks require per-site app registration the platform does not perform today                         |
| Linear   | Polling sweep                                                                                            | Linear webhooks need per-workspace registration; the GraphQL comment read batches cleanly by issue id             |

The sweep is one runtime-symmetric job (Worker `scheduled` cron ⇄ Node timer/pg-boss, per
"Keep the runtimes symmetric"), and it reads **in batches**: collect every parked
headless-origin review's linked issues via `TaskRepository.listByRefs`, then one batched
comment read per provider — never a point-read per parked run.

Dedup state is a `tracker_comment_cursors` row per `(workspace, provider, externalId)`
carrying the last ingested comment id/timestamp, so a re-delivered webhook or an overlapping
sweep window applies each reply exactly once.

### D6 — Loop policy for ticket mode (slice 2)

The SPA loop has a human clicking incorporate / re-review / the three-way exceeded choice.
Ticket mode needs defaults:

- A reply that leaves **no `open` finding** auto-triggers incorporation; the durable driver
  re-reviews as it already does on the async path.
- A reply that leaves findings open records the answers and posts a follow-up naming what is
  still outstanding. No incorporation.
- On `exceeded`, the follow-up comment states the three options and the run **stays parked**.
  There is deliberately **no timed auto-proceed** — per D1 there is no decision timeout to
  hang one off, and inventing one here would silently ship requirements nobody approved. An
  operator-configurable auto-choice is a possible follow-up, not a default.
- A reply landing after the park already settled gets a "the review has already moved on"
  follow-up comment rather than a silent drop.

### D7 — Threat model for ticket replies (slice 2)

Ticket replies are **external content that resumes a run**, and on a public GitHub repo
anyone can write one. Three layers:

1. **Identity.** A reply is only ingested when its author resolves to an allowed identity:
   the tracker connection's configured allow-list where present, else a workspace member
   matched on the provider identity the platform already stores (GitHub login / Jira
   accountId / Linear email). An unauthorized reply is ignored — logged, no state change, no
   follow-up comment (replying would confirm the hook exists and hand an attacker an oracle).
2. **Data, not instructions.** Reply text becomes `item.reply` — the same field the SPA
   writes — and reaches the model only through the existing incorporation prompt, which
   already renders answers as delimited untrusted input. No reply text is ever interpreted as
   a command outside the D4 grammar, and the grammar has no verb that can reach outside the
   review (no model selection, no pipeline choice, no repo write).
3. **Budget.** The per-review iteration cap (`maxRequirementIterations`) already bounds how
   many LLM cycles a chatty issue thread can drive; the cursor dedup bounds replay.

### D8 — Reliability of the question-out (slice 2)

Writeback today is fire-and-forget best-effort. That is acceptable for a courtesy PR comment
and NOT acceptable for the question comment: a silently failed post leaves a run parked with
nobody told. A failed question post raises the existing in-app `requirement_review`
notification (the same card the SPA park raises), so the park is never invisible even when the
tracker is unreachable.

Idempotency: a `review_question_posts` marker per `(workspace, review, iteration, issue ref)`
is written INSERT-OR-IGNORE style before the comment is considered done, so the durable
driver's replays cannot double-post.

---

## Slice 1 — parked decisions on the public API

### What lands

- **`decide` scope** (`PUBLIC_API_SCOPES`), between `write` and `admin`.
- **`ExecutionInstance.intakeOrigin`**, persisted in the `detail` JSON via the shared mappers.
- **Admission relaxation** in `PublicApiController`: parking pipelines admitted for a key that
  satisfies `decide`; `POST /api/v1/jobs/:id/cancel` so a park is always recoverable.
- **The public decision surface**, keyed by RUN id so it serves both a headless initiative job
  and a board task run:
  - `GET /api/v1/runs/:runId/decisions` — the run's open decisions.
  - `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply`
  - `PATCH /api/v1/runs/:runId/decisions/requirements/items/:itemId`
  - `POST /api/v1/runs/:runId/decisions/requirements/incorporate`
  - `POST /api/v1/runs/:runId/decisions/requirements/re-review`
  - `POST /api/v1/runs/:runId/decisions/requirements/proceed`
  - `POST /api/v1/runs/:runId/decisions/requirements/resolve-exceeded`
  - `POST /api/v1/runs/:runId/decisions/fork/choose`

  Every one delegates to the SAME service method the SPA controller calls
  (`RequirementReviewService` via `executionService.requirementsReview`,
  `executionService.chooseFork`) — no parallel logic, so the CAS/approval-id arbitration and
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
| 1.10 | Individual-usage runs across a park — see the note below                                 | ✅ done |
| 1.11 | Docs sweep (OpenAPI, CLAUDE.md, AGENTS.md) + changeset                                   | ✅ done |

**On 1.10 (individual-usage models).** The brief asked to verify the resume path needs nothing
new and add a conformance case. Verified: `personalGateForBlock` / `personalGateForRun` refuse an
individual-usage model at the public START and RETRY boundaries, so a headless run on such a model
never exists — there is no parked run of that shape for a resume to break. The run-scoped
activation is cleared only when the run reaches a TERMINAL state (`emitInstance` →
`deleteByExecution`), and a park is not terminal, so an activation would outlive a park regardless.
A conformance case asserting "an individual-usage run resumes across a park" would therefore have
to construct a state the public surface refuses to create — it would assert the fake, not the
product. The existing refusal is covered by the public-API integration specs; the honest outcome is
that this needs nothing, recorded here rather than papered over with a vacuous test.

**On the admission guard's coverage.** The relaxation is exercised as a unit test
(`publicApiAdmission.test.ts`) rather than over the wire, because the ONLY public pipeline is the
built-in one and built-ins are read-only — there is no way to construct a public-and-parking
pipeline through the API. The policy is pure logic in the SHARED controller layer, so it cannot
drift between facades; what conformance asserts instead is that each facade wires the agent-kind
registry the `headlessStartable` flag is computed against.

**Deferred from slice 1 (deliberately, not forgotten).**

- No SPA UI for the notification webhook: it is managed over
  `GET|PUT|DELETE /workspaces/:ws/notification-webhook` (behind `integrations.manage`). The
  consumer of this feature is a headless integration whose operator is already using the API; a
  settings panel is worth adding when a human-facing deployment wants it.
- The fork-decision CHAT is not exposed publicly — it is an interactive deliberation affordance,
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
  A non-SPA surface has no acting user — but "so skip the scope" is WRONG, because these routes
  are keyed by run id and deliberately accept a BOARD task run, which was very likely started in
  the SPA and does carry a `usr_*` initiator. Pass `execution.initiatedBy`: correct for both, and
  a no-op on a genuinely headless run (`null`). Slice 2's ticket surface must do the same.
- **`intakeOrigin` rides `detail`.** Adding a run field there is free (no migration) but it is
  parsed tolerantly — an unknown value must degrade to `ui`, never throw the snapshot.
- **The scope ladder is index-ordered.** `PUBLIC_API_SCOPES` order IS the ladder;
  inserting a tier shifts `admin`'s index, which is fine (stored values are strings) but any
  code comparing raw indices across a version boundary is not.

---

## Slice 2 — questions out to the ticket, replies back in

Design settled in D4–D8 above. Implementation notes to carry in:

- Fires ONLY for `intakeOrigin === 'public-api'` runs whose workspace enables the new
  `writebackQuestionsOnPark` tracker setting (workspace default + per-task override, resolved
  through the existing `resolveWritebackFlag` — the same shape as the PR-open/PR-merge flags).
  A UI-started task posts no question comments regardless of linked issues.
- The comment renders each finding with its stable item id (D4) through the tracker module's
  existing per-provider comment paths (Jira ADF / Linear GraphQL / GitHub comment) that
  `IssueWritebackService` already uses.
- New persistence, both runtimes: `review_question_posts` (idempotency marker, D8) and
  `tracker_comment_cursors` (ingest dedup, D5).
- Conformance: a fake tracker connection drives park → question posted exactly once across
  replays → simulated reply → resume; plus the unauthorized-reply and settled-review cases.
