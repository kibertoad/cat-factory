# ADR 0047: Headless clarification loop

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/orchestration`,
  `@cat-factory/integrations`, `@cat-factory/server`, both runtime facades) + the SPA
  (`@cat-factory/app`)

Supersedes the `headless-clarification-loop` initiative tracker, whose committed scope is complete
(the reply-ingest half was delivered by the tracker-webhook work,
[ADR 0032](./0032-tracker-webhook-intake.md)). The decision letters D1 to D8 cited from source
comments across the engine, contracts and conformance refer to the sections below.

## Context

The requirements-review loop is the platform's clarification machinery: the reviewer raises
findings, the run parks on a durable decision-wait, a human answers or dismisses, an incorporation
pass folds the answers in, and the run advances. That loop was reachable only through the SPA:

- `PublicApiController` refused **at admission** any pipeline containing an inline-and-parking kind
  (`PARKING_INLINE_KINDS`: the two review gates plus the two brainstorm dialogues), because a public
  run is headless. There was no way to answer, so a parked run would sit `blocked` forever while its
  anchor held a concurrency slot.
- `IssueWritebackService` wrote back to a task's linked tracker issue only at PR-opened and
  PR-merged. It never posted the reviewer's questions, and nothing ingested a reply.

**Scope boundary, load-bearing:** tasks created or imported through the SPA are human-overseen by
design. The SPA loop stays their clarification surface and this work does not change their behaviour
by default. The gap was runs started headlessly.

## Decision

A headless run parks, its open findings reach the caller and/or the linked ticket, an answer
arriving by API call or ticket reply resumes the run, and the loop converges, with the SPA flow
unchanged.

### D1: the admission guard relaxes behind a new `decide` scope, not for every key

The guard rejected a parking kind not because parking is unsafe but because a parked headless run
never resolves: its anchor block stays `in_progress`, so `countActiveInternalTasks` keeps counting
it against `MAX_ACTIVE_INITIATIVE_RUNS`, and five abandoned parks permanently wedge a workspace's
initiative surface. **There is no decision timeout to lean on as a backstop.**
`ExecutionWorkflow` waits for a human indefinitely by design; the hard timeout that used to fail a
parked run was removed on purpose, and `ExecutionConfig.decisionTimeout` survives only as the chunk
length of Cloudflare's `waitForEvent`, re-arming the wait on expiry.

So: a new `decide` tier on the public-API scope ladder, between `write` and `admin`
(`read ⊂ write ⊂ decide ⊂ admin`, so `scopeSatisfies` is unchanged); parking kinds admitted only
for a key that satisfies `decide`; and `POST /api/v1/jobs/:id/cancel` so a caller can always free a
slot. A plain `write` key sees exactly the previous behaviour including the `pipeline_not_inline`
refusal. `PARKING_INLINE_KINDS` stays where it is: it is still the right list, and it is now a scope
question rather than a flat ban.

### D2: intake origin is a persisted run field in the `detail` JSON

`initiatedBy` cannot say how a run entered the system (it is null for a public-API run, a recurring
fire, and auth-disabled local dev alike), and `RunStartOptions.origin` is about pipeline
availability and is not persisted. `ExecutionInstance.intakeOrigin` rides the `agent_runs.detail`
JSON through the shared `@cat-factory/server` mappers, so both runtimes gain it in one edit with no
migration; `retry` / `restart` carry the previous run's value forward.

The vocabulary later gained `tracker` and `schedule`, and the writeback gate now asks the
CLASSIFICATION (`isHeadlessIntake` in `@cat-factory/contracts`, a `Record` over the picklist so a
new member has to answer it) rather than `=== 'public-api'`. The equality test was the defect, not a
simplification that aged: per-ticket dispatch is headless by construction and its reply channel was
already ungated, so a ticket-driven trial parked and told nobody while the loop looked wired.

### D3: park notification out is SSE frames plus a webhook `NotificationChannel`

A caller should not poll to learn its run parked. A parked run emits an explicit `decision` SSE
frame (rather than the jobs stream's terminal-looking `stopped`) and the jobs stream keeps polling
through `blocked`. `WebhookNotificationChannel` composes into the existing
`CompositeNotificationChannel` beside the in-app and Slack channels, with endpoint and secret a
persisted per-workspace setting (`notification_webhooks`, D1 ⇄ Drizzle) and best-effort delivery,
type-filtered per workspace so enabling it does not fire-hose an integration that only cares about
parks.

The same endpoint later grew run-lifecycle events through the kernel `RunLifecycleSink` port over
the shared `signedDelivery.ts` core; its `runEvents` filter is opt-in and empty means NONE,
deliberately the opposite of the `types` filter. See [ADR 0030](./0030-public-api-surface.md).

### D4 to D8: the ticket channel

- **D4, grammar.** A comment is scanned line by line and only lines whose first non-space token is
  the trigger are interpreted, so a human can answer and discuss in one message:
  `@cat-factory answer <itemId> <text>`, `dismiss <itemId>`, `proceed`, `stop`, `extra-round`. An
  `answer` continues onto following lines until the next trigger line. An unknown command, unknown
  item id, or a command for a settled review is reported in the follow-up comment, never silently
  dropped. There is no natural-language guessing.
- **D5, transport per provider.** GitHub rides the existing webhook ingest gateway
  (`issue_comment`), Jira and Linear ride a polling sweep, because their webhooks need
  per-site/per-workspace registration the platform does not perform. The sweep is one
  runtime-symmetric job reading in batches (collect parked headless-origin reviews' linked issues via
  `TaskRepository.listByRefs`, then one batched comment read per provider), never a point-read per
  parked run. A `tracker_comment_cursors` row per `(workspace, provider, externalId)` makes a
  re-delivered webhook or an overlapping sweep window apply each reply exactly once.
- **D6, loop policy.** A reply leaving no `open` finding auto-triggers incorporation; a reply
  leaving findings open records the answers and posts a follow-up naming what is outstanding. On
  `exceeded` the follow-up states the three options and the run stays parked: there is deliberately
  no timed auto-proceed, because per D1 there is no timeout to hang one off and inventing one would
  ship requirements nobody approved. A reply landing after the park settled gets a "the review has
  already moved on" comment rather than a silent drop.
- **D7, threat model.** A reply is ingested only when its author resolves to an allowed identity
  (the connection's allow-list where present, else a workspace member matched on the stored provider
  identity); an unauthorized reply is logged and ignored with no follow-up, because replying would
  confirm the hook exists and hand an attacker an oracle. Reply text becomes `item.reply` and reaches
  the model only through the incorporation prompt's delimited untrusted-input rendering, and the
  grammar has no verb reaching outside the review. The per-review iteration cap bounds LLM cycles a
  chatty thread can drive; the cursor dedup bounds replay.
- **D8, reliability of the question-out.** A silently failed post leaves a run parked with nobody
  told, so a failed question post raises the in-app `requirement_review` card the SPA park raises. A
  `review_question_posts` marker per `(workspace, review, iteration, issue ref)` is written
  insert-or-ignore before the comment counts as done, so replays cannot double-post.

## Rationale

- **Answering a decision is more consequential than starting a task and less than deleting one.** It
  injects caller-supplied prose into the requirements every downstream agent implements, and it
  un-parks a run. That is exactly the gap between `write` and `admin`, which is why `decide` is a
  ladder rung rather than an orthogonal flag.
- **A cap with no door is unrecoverable.** Bounding abandoned parks by concurrency alone leaves a
  headless caller wedged with no SPA access; `cancel` turns that into a bounded, visible,
  self-serviceable `429`.
- **Automatic reaping of parked headless runs was rejected.** Re-introducing a run-killing timeout
  would regress the deliberate wait-indefinitely behaviour for every run, not just public ones.

## Consequences

- **`ui` is a POSITIVE claim that a human is watching in the app**, never a catch-all for "nothing
  said". Every unattended start path states its origin and only the in-app start takes the default.
  The field stays optional for that one caller, so the rule cannot be a typecheck:
  `intakeOrigin.coverage.spec.ts` classifies each start path, and a new one fails there until
  someone answers it.
- **The classification asks whether there is a STABLE place to hold a conversation**, not whether
  anyone was present. `schedule` is `false` despite being unattended, because a fire works the
  schedule's reused block and queue mode replace-links each pick onto it, so a question posted there
  loses its reply channel on the next fire. Making queue mode clarify on its ticket is a change to
  the LINKAGE (a per-run link, or a block per pick), never a flip of the flag: the flip alone would
  post the question and discard the answer.
- **The initiative spawn is the classification to revisit first.** `InitiativeLoopService` starts a
  child run unattended and takes the `ui` default, which is right only while a spawned block carries
  no linked ticket. Giving initiative children a linked ticket means reclassifying that start path
  in the same change.
- **No operator-configurable auto-choice on `exceeded`.** Possible follow-up, never a default.
