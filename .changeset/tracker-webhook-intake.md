---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': patch
---

Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
from the ticket.

Two asymmetries in the task-source layer close together, because they share a transport.

**1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
`tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

**2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
`docs/initiatives/headless-clarification-loop.md`.

**A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
tempting shape — "the event names an issue, so import and link it" — forks a second intake path
that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
omits: a false positive costs one no-op run, a false negative costs silent intake latency.

**The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
path, never the only path.

**Ticket replies use an explicit grammar, never natural-language guessing:**

```
@cat-factory answer <itemId> <free text to end of line>
@cat-factory dismiss <itemId>
@cat-factory proceed | stop | extra-round
```

Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
one comment; an `answer` continues onto following lines until the next trigger. A comment with no
trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
`executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
rejected and why.

**Configuration is per connection and needs no new table.** The webhook secret rides the
connection's existing sealed credential bag, minted / rotated / cleared through
`GET|POST|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`) and
returned exactly once. The workspace rides the URL path because a tracker delivery carries no
installation id to resolve one from, and scanning every workspace's connections for one whose
secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
secret fails closed** — an empty HMAC key is one an attacker also has.

Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
bots are refused first (the platform's own acknowledgement comes back as a delivery, so without
that check the ack feeds itself), then the connection's optional `webhookReplyAllow` list — an
unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
the PR verification report.

Idempotency is an atomic claim on a new `tracker_comment_ingests` table
(`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
— every tracker redelivers and every queue retries, so without it one reporter comment would answer
the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
`pending` one is re-claimable once abandoned. Both stores are pinned by a new cross-runtime parity
suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
each facade.

Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
(Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
never receives deliveries. Design, decisions and the per-slice checklist:
`docs/initiatives/tracker-webhook-intake.md`.
