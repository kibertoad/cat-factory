# Initiative: tracker webhook intake + issue-comment answers

**Status:** in progress · **Owner:** core · **Started:** 2026-07-27

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the next
> slice; update the checklist at the end of each PR.

## Goal & rationale

The task-source layer is complete on the write side and on the POLLING read side (see the
"Requirements review flow" and bug-triage notes in [`CLAUDE.md`](../../CLAUDE.md), plus
[`headless-clarification-loop.md`](./headless-clarification-loop.md)). Two asymmetries remain:

1. **Intake is pull-only.** An issue enters the system when a recurring `bug-intake` schedule
   fires or a human imports it, so intake latency is the schedule interval and every idle poll
   costs a tracker API call. The GitHub VCS side already has the push pattern this needs:
   verified deliveries ack fast and ride the `githubWebhook` gateway seam onto a queue, with an
   inline fallback for queue-less containers. There was no tracker analogue.
2. **The question loop was half-duplex.** `IssueWritebackProvider.postReviewQuestions` posts a
   parked review's findings onto the linked issue, each with its **stable finding id rendered
   verbatim so an answer can name it**, but answers could only arrive in-app or over
   `/api/v1/runs/:runId/decisions`. The reporter who lives in Jira had to switch surfaces. The ids
   were designed for exactly this reply path (slice 2b of the clarification-loop tracker); it was
   never built.

**End state.** A labelled issue starts intake within seconds of the webhook delivery on both
runtimes (with the polling sweep still covering missed deliveries), and a reporter's
finding-addressed comment lands as a reply on the parked review so the loop re-reviews exactly as
if answered in-app. Replays and duplicate deliveries provably apply once.

This initiative COMPLETES slice 2b of
[`headless-clarification-loop.md`](./headless-clarification-loop.md): that tracker's D4 (reply
grammar), D5 (per-provider ingest), D6 (loop policy) and D7 (threat model) are the design of record
for the reply half and are not restated here, only refined where reality differed.

## The target pattern

The reference implementation is the GitHub VCS webhook path, copied step for step:

| Concern         | GitHub VCS (the model)                              | Tracker (this initiative)                                             |
| --------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Receiver        | `githubWebhookController` (`POST /github/webhooks`) | `taskWebhookController` (`POST /webhooks/tasks/:source/:workspaceId`) |
| Verify          | HMAC over the RAW body, before any parse            | same, per-connection secret, per-provider header                      |
| Normalise       | GitHub-shaped payload → `WebhookService`            | `TaskSourceProvider.webhook.parse` → neutral `TrackerWebhookEvent`    |
| Hand off        | `gateways.githubWebhook.enqueueWebhook`             | `gateways.trackerWebhook.enqueueDelivery`                             |
| Async consumer  | CF queue consumer ⇄ pg-boss `github.sync` worker    | CF queue consumer ⇄ pg-boss `tracker.sync` worker                     |
| Inline fallback | `if (!queued) await …handle(…)`                     | identical                                                             |
| Reconciliation  | `reconcileStaleRepos` cron                          | the existing recurring `bug-intake` schedule (unchanged)              |

**Push is the fast path, never the only path.** The recurring schedule stays exactly as it was and
remains the sweep for missed deliveries: the same webhook + sweeper duality as GitHub sync +
`sweepStuckRuns`.

## Decisions

### D1: The delivery URL carries the workspace; the secret is per connection

A tracker delivery has no installation id to resolve a workspace from (the GitHub App's trick), and
Jira/Linear payloads carry only vendor-internal ids. Making the receiver scan every workspace's
connections to find one whose secret verifies would be an N+1 across the whole deployment on every
unauthenticated POST: a free amplification oracle.

**Decision.** The route is `POST /webhooks/tasks/:source/:workspaceId`. The workspace id is not a
secret (it is in every API path already); the per-connection `webhookSecret` is what authenticates.
One connection read, one HMAC verify, fail closed when the connection has no secret configured.

The secret lives in the connection's existing sealed `credentials` bag under `webhookSecret`, so
there is **no new table and no migration** for it. It is minted by
`POST /workspaces/:ws/task-sources/:source/webhook` and read back (with the delivery URL) by
`GET` on the same path, so an operator can paste both into the vendor's webhook form. Rotation is a
re-POST; the old secret stops verifying immediately (backwards compatibility is a non-goal).

Because rotation is destructive on return, **editing the reply allow-list has its own `PATCH`** on
the same path rather than riding the mint. Tightening that list is exactly what an operator does
when a tracker turns out to be more public than they thought, and answering that with a silently
rotated secret would take deliveries down until they re-pasted it into the vendor: a security
control that costs an outage is one people learn not to touch. `POST` still accepts an optional
`replyAllow` so first-time setup stays one round trip.

### D2: One neutral event shape; providers own their vendor parsing

`TrackerWebhookEvent` is `issue` | `comment`, keyed `(source, externalId)`: the task projection's
natural key, so every downstream lookup is the one the projection already indexes. Providers own
verification AND parsing (`TaskSourceProvider.webhook`), exactly as VCS providers own theirs; a
provider without the capability simply never receives deliveries (404 at the receiver, so an
operator misconfiguring the URL learns immediately rather than into a silent void).

All three vendors sign HMAC-SHA256 over the raw body and differ only in header + encoding
(`x-hub-signature-256: sha256=<hex>` / `x-hub-signature: sha256=<hex>` / `linear-signature: <hex>`),
so the crypto is one shared helper and each adapter supplies its header name and prefix.

### D3: Event-driven intake FIRES THE SCHEDULE; it does not re-implement intake

The tempting shape ("the event names an issue, so import and link that issue") forks a second
intake path that would drift from `BugIntakeService` (its predicate handling, its batched dedup,
its replace-link, its pickup writeback, its block seeding, and the pipeline run the engine's
`bug-intake` step drives).

**Decision.** A qualifying issue event is a **trigger to fire the matching schedule now**. The pure
`issueEventMatchesIntake` predicate (labels ⊇ config labels, title fragment, issue type) decides
whether an event qualifies for a given schedule's `issueIntake` config; a match calls the same
`fire` the cron sweeper calls. The `bug-intake` step then runs the unchanged
`BugIntakeService.pickForBlock`, which searches, dedups, imports, links and claims exactly as
before. Consequences, all deliberate:

- **Zero new intake code paths.** Dedup, replace-link and the pickup mark are literally the same
  calls.
- **The fired run may pick a DIFFERENT (older) issue than the one that triggered it.** That is
  correct, not a bug: intake is oldest-first fair queueing, and the trigger's job is to remove the
  latency, not to jump the queue. The webhook makes the queue drain promptly; it does not reorder it.
- **Overlap protection is inherited.** `fire` refuses while a prior run is `running`/`paused`/
  `blocked`, so a burst of deliveries cannot start a second run over a parked one: the event for an
  already-being-worked board is a no-op with no extra bookkeeping.
- **On-demand schedules are not webhook-fired** and an individual-usage model still refuses an
  unattended fire, because the trigger is non-forced: a webhook has no human present to unlock a
  personal credential, which is exactly the cadence-fire situation those guards exist for.

### D4: Reply ingest reuses the SPA's service methods, and is claimed before it is applied

The grammar is D4 of the clarification-loop tracker, unchanged:

```
@cat-factory answer <itemId> <free text to end of line>
@cat-factory dismiss <itemId>
@cat-factory proceed
@cat-factory stop
@cat-factory extra-round
```

Only lines whose first non-space token is the trigger are interpreted; everything else is ignored, so
a human can answer and discuss in one comment. An `answer`'s text continues onto following lines
until the next trigger line. **A comment with no trigger line is ignored entirely, no guessing.**

Every mutation goes through the SAME service methods the SPA and `PublicDecisionController` call
(`RequirementReviewService.replyToItem` / `setItemStatus`, then
`executionService.requirementsReview.incorporate` / `proceed` / `resolveExceeded`), so the park's
CAS/approval-id arbitration and the task's preset knobs apply identically. **There is never a
parallel mutation path into the engine.**

Idempotency is a `tracker_comment_ingests` claim per `(workspace, source, externalId, commentId)`,
taken BEFORE anything is applied, copied verbatim from the `review_question_posts` design:
including its answer to "what if the claimer dies" (a `failed` row is re-claimable; a `pending` one
is re-claimable once older than `TRACKER_COMMENT_INGEST_CLAIM_TTL_MS`).

### D5: What a comment may do, and what it may never do

Comment text is untrusted third-party input; on a public repo anyone can write one. Three layers,
matching D7 of the clarification-loop tracker:

1. **Identity.** A reply is ingested only when its author resolves to an allowed identity: the
   connection's `webhookReplyAllow` list (handles/emails/ids, comma-separated) when configured, else
   any non-bot author. An unauthorized reply is dropped silently: logged, no state change, **no
   follow-up comment**, because replying would confirm the hook exists and hand an attacker an
   oracle. The platform's OWN comments are dropped first (a bot author), or the ack comment would
   feed itself.
2. **Data, not instructions.** Reply text becomes `item.reply` (the same field the SPA writes) and
   reaches a model only through the existing incorporation prompt, which already renders answers as
   delimited untrusted input. Lengths are capped and `redactSecrets` runs before anything persists
   or is re-rendered. The grammar has no verb that can reach outside the review: no model selection,
   no pipeline choice, no repo write, no scope change.
3. **Budget.** The per-review iteration cap already bounds how many LLM cycles a chatty thread can
   drive; the ingest claim bounds replay.

### D6: Loop policy in ticket mode

Per D6 of the clarification-loop tracker: a reply that leaves **no open finding** auto-triggers
incorporation (the durable driver re-reviews as it already does); a reply that leaves findings open
records the answers and posts a follow-up naming what is still outstanding; on `exceeded` the
follow-up states the three options and the run **stays parked** (there is deliberately no timed
auto-proceed; there is no decision timeout to hang one off, and inventing one would ship
requirements nobody approved); a reply landing after the park settled gets a "the review has already
moved on" follow-up rather than a silent drop.

### D7: `taskSourceKindSchema` widens to `builtin ∪ <ns>:<name>` (slice 4)

Closed at first, on the grounds that widening was separable. It was, and slice 4 did it the way
`taskTypeSchema` was widened: a union of the shipped picklist and `namespacedIdSchema`, so a
deployment registers its own provider (webhook adapter included) on the app-owned
`TaskSourceRegistry` and every registry-reading surface serves it.

Three properties carried the decision:

- **The built-ins keep their BARE ids**, so no persisted `source` column, stored connection or
  imported issue row changed. The widening needed no migration because it added no encoding.
- **A bare non-built-in id still fails validation.** `servicenow` is a typo; `acme:servicenow` is a
  registration. Keeping the namespace mandatory is what tells them apart, so widening did not turn
  every misspelled `:source` segment into a plausible-looking miss.
- **The schema is the GRAMMAR, never the authority on what exists.** A namespaced id passes the
  schema and is then resolved on the registry, which is what refuses an unregistered one. The two
  failures stay distinct because they have different fixes.

The one place the old closed union was load-bearing beyond a type was
`IssueIntakeQuery.board`: three vendor-named string fields with a fall-through default. A
registered source would have had its board id delivered to `githubRepo` and failed as "no matching
issues". It gains an opaque `boardId` leg, and the default is now keyed on the source being a
BUILT-IN rather than on it being un-matched.

### D8: Per-ticket dispatch is a MODE on the intake config, not a second entity (slice 5)

D3 settled that a pushed event fires the schedule and the `bug-intake` step decides what to work.
That is right for a bug BACKLOG and wrong for a ticket a human already triaged: a feature request
filed in Jira could only enter the platform through an API call, because the queue mode's whole
point is that the platform picks what is next.

**Decision.** `issueIntake.dispatch` selects between the two, absent ⇒ `queue` (so every existing
schedule is unchanged). `per-ticket` imports the pushed ticket, materialises it as its own task
under the schedule's frame, and starts the schedule's pipeline on it.

It is a mode on the existing config rather than a new `tracker_triggers` entity because a schedule
already IS "a workspace-scoped, frame-anchored, pipeline-bound, predicate-carrying, enable-able
rule", and `onDemand` already models the one thing a trigger lacks: a cadence. A parallel entity
would have duplicated all of that plus its repository on both runtimes, its controller, its RBAC
mount and its SPA surface, to express one extra field. `issue_intake` is a JSON column on both
runtimes, so the mode needed no migration either.

What the modes do NOT share is the reason they stay exclusive rather than becoming a knob:

- **`queue` reuses ONE block and competes for it; `per-ticket` creates a block per ticket and never
  queues.** A cadence tick carries no triggering ticket, so a per-ticket schedule that could also
  fire on cadence would silently fall back to draining the queue: the `queue` behaviour under a
  config saying `per-ticket`. Hence `per-ticket` REQUIRES `onDemand`, which removes the fallback
  rather than documenting it.
- **A `bug-intake` step and per-ticket dispatch are two ways to pick work, and a pipeline may use
  only one.** The pushed ticket is already the work, so an intake step would search the board and
  adopt a DIFFERENT issue onto the block created for this one. Refused at save; and `origin:
'manual'` at start makes `assertPipelineLaunchable` refuse it again at run time, because a
  per-ticket run IS a one-off task run.
- **Idempotency is the issue's existing single `linkedBlockId`**, not a new claim table. A
  redelivery (or the `updated` event that follows a `created` one) finds the issue already linked
  and is read as "already dispatched". The link already guarantees what a claim would have bought.
- **The unattended-fire guard is the same one `fire` applies**, checked against the CREATED block
  rather than the schedule's reused one. A refusal still leaves the ticket on the board as a task a
  human can start, with the reason recorded in the run history rather than a task that mysteriously
  never ran.

The SPA DERIVES the mode from the pipeline instead of offering it: a `bug-intake` pipeline can only
mean `queue`, anything else can only mean `per-ticket`. That makes the refused combination
unrepresentable in the form rather than reported after a save.

## Slices

| #   | Slice                                                                      | Status  | PR      |
| --- | -------------------------------------------------------------------------- | ------- | ------- |
| 1   | Tracker event ingestion (provider webhook capability, receiver, queue seam | 🟡 this | this PR |
| 2   | Event-driven intake) qualifying issue events fire the matching schedule    | 🟡 this | this PR |
| 3   | Issue-comment answers to a parked review: grammar, ingest claim, follow-up | 🟡 this | this PR |
| 4   | Deployment-registered tracker kinds (`taskSourceKindSchema` widening)      | ✅ done | #1628   |
| 5   | Per-ticket dispatch: a pushed ticket runs as its own task                  | ✅ done | #1628   |

### Slice 1 checklist

| #   | Item                                                                              | Status  |
| --- | --------------------------------------------------------------------------------- | ------- |
| 1.1 | `TrackerWebhookEvent` + `TaskSourceWebhookAdapter` kernel port                    | ✅ done |
| 1.2 | GitHub / Jira / Linear adapters (shared HMAC helper, per-vendor header + parse)   | ✅ done |
| 1.3 | Per-connection webhook secret: mint/read/patch/clear + sealed credential storage  | ✅ done |
| 1.4 | `TrackerWebhookIngest` gateway seam + `taskWebhookController`                     | ✅ done |
| 1.5 | CF queue consumer ⇄ pg-boss `tracker.sync` worker + inline fallback, both facades | ✅ done |

### Slice 2 checklist

| #   | Item                                                                      | Status  |
| --- | ------------------------------------------------------------------------- | ------- |
| 2.1 | `issueEventMatchesIntake` pure predicate                                  | ✅ done |
| 2.2 | `RecurringPipelineService.triggerForIssueEvent` (fires, never re-imports) | ✅ done |
| 2.3 | Conformance: a qualifying event fires; a non-qualifying one does not      | ✅ done |

### Slice 4 checklist

| #   | Item                                                                             | Status  |
| --- | -------------------------------------------------------------------------------- | ------- |
| 4.1 | `taskSourceKindSchema` widened to `builtin picklist ∪ <ns>:<name>`               | ✅ done |
| 4.2 | Grammar guard in contracts; the REGISTRY stays the authority on what exists      | ✅ done |
| 4.3 | Opaque `board.boardId` leg, so a registered board id cannot land on `githubRepo` | ✅ done |
| 4.4 | Conformance: a registered source connects/imports/round-trips; typo vs unknown   | ✅ done |

### Slice 5 checklist

| #   | Item                                                                           | Status  |
| --- | ------------------------------------------------------------------------------ | ------- |
| 5.1 | `issueIntake.dispatch` (`queue` \| `per-ticket`), absent ⇒ `queue`             | ✅ done |
| 5.2 | `assertValidIssueIntake` pure rules + unit tests                               | ✅ done |
| 5.3 | `firePerTicket`: adopt → guard individual-usage → start, `origin: 'manual'`    | ✅ done |
| 5.4 | Conformance: dispatch creates task+run; redelivery once; cadence combo refused | ✅ done |

### Slice 3 checklist

| #   | Item                                                                            | Status  |
| --- | ------------------------------------------------------------------------------- | ------- |
| 3.1 | `parseReviewReplyCommands`: the D4 grammar, pure + unit-tested                  | ✅ done |
| 3.2 | `tracker_comment_ingests` claim, D1 ⇄ Drizzle + parity conformance              | ✅ done |
| 3.3 | `TrackerWebhookService` reply path, through the SPA's service methods only      | ✅ done |
| 3.4 | `postReviewReplyAck` follow-up comment (outstanding / rejected / moved-on)      | ✅ done |
| 3.5 | Conformance: reply → resume; replay applies once; unauthorized dropped silently | ✅ done |

## Deferred, deliberately

- **No SPA panel for the webhook secret.** It is managed over
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind
  `integrations.manage`),
  exactly as slice 1 of the clarification-loop initiative left the notification webhook. Setting it
  up is a one-time operator action that ALSO requires pasting into the vendor's own webhook form
  ( a surface the SPA cannot cover) so a panel saves half a round trip. Worth adding when a
  human-facing deployment asks; the read route already returns everything a panel would render
  (`supported` / `configured` / `deliveryPath` / `replyAllow`).
- **No `taskType` on a per-ticket config.** The created task inherits the board's default type,
  exactly as the SPA's own "create task from issue" does, and the schedule's `pipelineId` already
  carries the behavioural half. A configurable type would have been a contract field with no
  surface able to set it.
- **No reply path for the CLARITY gate.** Its questions carry no stable ids, so a comment could not
  name one and the parser would have to guess, which the grammar exists to avoid. The clarity echo
  stays an echo; only the id-addressed requirements findings are answerable from a ticket.
- **No per-provider comment formatting.** The ack is markdown through the existing per-provider
  comment paths, like the question comment before it. Worth a Jira-ADF variant only if a reader
  complains.
- **A `pending` ingest claim is not swept.** It self-heals on the next delivery once abandoned,
  which is the same guarantee `review_question_posts` gives; a proactive sweeper would be a second
  runtime-symmetric cron for a row that costs nothing while it sits.

## Conventions & gotchas carried between iterations

- **The receiver must verify against the RAW bytes before any parse**, like both existing webhook
  receivers. Parsing first and verifying the re-serialised body is a classic signature bypass.
- **Fail closed on an unconfigured secret.** An empty HMAC key lets an attacker forge a signature
  over their own body. The connection with no `webhookSecret` 503s rather than accepting.
- **A claim-before-apply MUST answer "what if the claimer dies"**: carried verbatim from
  `review_question_posts`. A `pending` row needs an abandonment window or a killed ingester silences
  that comment forever, trading a double-apply for a never-apply (the harder failure to notice).
- **Commit the state, THEN talk to the tracker.** The reply is applied and settled before the
  follow-up comment is attempted; a failed ack must never roll back an applied answer.
- **A tracker comment is as exposed as a PR body.** Everything the ack renders crosses kernel's
  `hostMarkdown` (`inline`/`prose`) plus `redactSecrets`, exactly as `renderReviewQuestionsComment`
  does, and it renders the SAME finding ids, by importing that module rather than re-deriving them.
- **Never let the ack feed itself.** The platform's own comments come back as deliveries; they are
  dropped by the bot-author check before any parsing. Adding a new outbound comment means checking it
  cannot be parsed as a command (the grammar's trigger is never emitted verbatim by the renderer).
- **Adding a workspace-scoped table means one line in `WORKSPACE_SCOPED_TABLES`** (kernel
  `domain/workspace-cascade.ts`): both facades' delete cascade is driven from it, and a completeness
  test fails the build if a `workspace_id` table is missing.
- **The intake trigger is non-forced on purpose.** `force` is the human run-now lever: it throws
  `ConflictError` on overlap and bypasses the on-demand guard. A webhook has no human, so it must
  behave like a cadence fire.
- **`TaskConnectionService.store` REPLACES the credential bag**, and a provider's
  `normalizeConnection` legitimately returns only the VENDOR credentials it validated. Any
  PLATFORM-owned key kept in that bag must be listed in `preservedPlatformCredentials`, or rotating
  an API token silently drops it: for the webhook secret that means every later delivery 503s with
  nothing pointing at the cause. Exactly the class of bug the clarification-loop tracker recorded
  for `TrackerSettingsService.put`.
- **A conformance case must not answer the LAST open finding.** Doing so correctly triggers
  incorporation, which calls a real reviewer model no harness has: seed a review with two findings
  (`seedReadyReview(ws, block, 2)`) and leave one open. The auto-incorporate decision belongs to
  `TrackerWebhookService`'s unit tests, where it has no runtime dimension.
- **`crypto.subtle.importKey` THROWS on a zero-length key**, so the empty-secret guard has to come
  BEFORE it. The port requires `verify` to RESOLVE false for every rejection; a throw would surface
  to the tracker as a 500 and a redelivery loop instead of the terse 401 the receiver intends.
