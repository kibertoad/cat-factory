# Initiative: public API additions (completing the parked-decision surface)

**Status:** investigation complete; A0, D1 and C1 landed, the start-path scope question settled by
[ADR 0034](../../backend/docs/adr/0034-public-api-stability.md), A1–B2 and C2 not started ·
**Owner:** core · **Started:** 2026-08-02

> Durable source of truth for a multi-PR initiative. Read it FIRST before picking up the
> next slice; update the checklist at the end of each PR.

**Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/server`)
**Builds on:** [ADR 0030](../../backend/docs/adr/0030-public-api-surface.md) (the `/api/v1` surface)
and [`headless-clarification-loop.md`](./headless-clarification-loop.md) (the `decide` scope and the
first answer surface).

## Goal & rationale

`/api/v1` covers the task lifecycle end to end **except when a run parks on a human**. The public
decision surface answers four park surfaces and the engine has at least the eight below that it does
not. Enumerated rather than counted, because "the engine has N parks" is the kind of claim that
quietly goes stale: this is what the investigation found, not a proof of exhaustiveness, and a
surface discovered later belongs in this table rather than in a revised number:

| Park surface              | Lives on             | Public answer path                         |
| ------------------------- | -------------------- | ------------------------------------------ |
| `requirements-review`     | review module        | ✅ `/runs/:runId/decisions/requirements/*` |
| implementation fork       | `step.forkDecision`  | ✅ `/runs/:runId/decisions/fork/choose`    |
| judge verdict             | `step.judge`         | ✅ `/runs/:runId/decisions/judge/resolve`  |
| pre-token input gate      | `instance.inputGate` | ✅ `/runs/:runId/decisions/input-gate/…`   |
| approval gate             | `step.approval`      | ❌ none (slice **A1**                      |
| agent-raised decision     | `step.decision`      | ❌ none) slice **A2**                      |
| `clarity-review`          | clarity module       | ❌ none (slice **A3**                      |
| `requirements-brainstorm` | brainstorm module    | ❌ none) slice **A4**                      |
| `architecture-brainstorm` | brainstorm module    | ❌ none (slice **A4**                      |
| PR deep-review selection  | `step.prReview`      | ❌ none) slice **A5**                      |
| human-test window         | `step.humanTest`     | ❌ none (slice **A6**                      |
| visual-confirmation gate  | `step.visualConfirm` | ❌ none) slice **A6**                      |
| `human-review` gate       | `step.gate`          | ❌ none, unranked (see below)              |

**The pre-token input gate is the odd row**, and worth reading before adding another: every other
entry is a park a PIPELINE can carry, so `parkSurfacesOf` sees it in the step chain and admission
can refuse a `write` key up front. The gate parks on the shape of the TASK, so it holds runs under
pipelines that park nowhere and was invisible to that enumeration entirely. It is composed in at
the START surfaces instead (`publicRunParkSurfaces`, whose `inputGateBlocks` argument is required),
which is the pattern any future task-shaped park should copy rather than trying to squeeze into
`parkSurfacesOf`.

Which start path can reach which differs, and that difference matters when ranking:
`POST /api/v1/jobs` is inline-only, so it reaches the review, brainstorm, approval-gate,
judge and agent-decision rows; `POST /api/v1/tasks/:taskId/start` admits container pipelines
(behind the same parking scope rule; see §2 below, since resolved), so it reaches **every** row,
container-backed ones included, for a `decide`-scope key.

**`human-review` was missing from this table until ADR 0032**, which is how it also came to be
missing from `canParkOnHuman`. It is a polling GATE rather than a step-state park, so it lives on
`step.gate` alongside the CI and conflicts gates and does not look like the other rows; what makes
it a park is its `pollExhaustion: 'rearm'`, which says there is no deadline because a person is the
gate. It is deliberately UNRANKED here: unlike the other ❌ rows there is nothing to build, because
the answer is a human approving the PR on GitHub, not an API call this surface could offer. Its
`fixer` dispatch is already reachable in the app. So the admission rule refuses it and the refusal
says so, which is the whole of the fix.

This tracker records what is missing, ranks it, and records what was considered and rejected so the
next iteration does not re-propose it.

The headline finding is not "an endpoint is missing" but an **asymmetry between what admission lets a
key start and what the decision surface lets it answer**. A caller can put a run into a state only
the SPA can get it out of.

**What gates the first slice:** nothing technical: A1 is ready to pick up. The former [open
question](#open-question-for-the-maintainer-settled) about the `POST /tasks/:taskId/start` scope
rule is settled (tightened, with [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)).
When the committed scope completes, this tracker converts to a numbered ADR under
`backend/docs/adr/` (per CLAUDE.md); if it is instead abandoned, say so here rather than deleting
it, so the investigation is not redone.

## The gap, precisely

`buildDecisionList` (`PublicDecisionController.ts`) enumerates exactly three decisions:
`requirements-review`, `fork`, `judge`. Its own closing comment names the hole:

> a run parked on a surface this projection doesn't model yet (a plain approval gate, a human-test
> window) still reports `parked: true` with an empty list rather than silently claiming all is well.

That is honest reporting of an incomplete surface, not a bug, but the reporting is all a caller
gets. Two independent paths lead into it:

**1. The initiative surface admits parks it cannot answer.** `PARKING_INLINE_KINDS`
(`publicApiAdmission.ts`) lists four kinds (`requirements-review`, `clarity-review` and the two
brainstorms) and admitting any of them is what the `decide` scope buys. Only `requirements-review`
is answerable (see the table above). Clarity and brainstorm are separate orchestration modules with
their own repositories, deliberately mirroring requirements, so `buildDecisionList`'s single
`container.requirements` read cannot see them, and a `decide` key that starts such a pipeline gets a
run it can only cancel.

**…and the refusal used to ADVERTISE the parks it cannot answer**: fixed as A0 below. The
`pipeline_requires_decide_scope` body a `write` key got named all four kinds plus the approval gate
and told the operator a `decide` key "can answer the park through /api/v1/runs/:runId/decisions".
For four of those five that was false, so the refusal was selling a scope upgrade that buys a run
whose only exit is cancel. That is the platform's degrade-loudly rule inverted: not an incomplete
surface reporting itself honestly, but one describing a capability it does not have.

**2. `POST /api/v1/tasks/:taskId/start` gates parking pipelines on `decide` (RESOLVED with
[ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)).** It used to apply no pipeline
admission at all, so a plain `write` key (one deliberately NOT granted `decide`) could start any
board pipeline, including one carrying an approval gate on an enabled step, and park it. It now
applies the same `canParkOnHuman` scope rule as the jobs surface (the inline-only rule stays
jobs-only on purpose: it exists to keep headless jobs off GitHub, not to constrain board work).
The refusal names this surface's exit route, `POST /api/v1/tasks/:taskId/stop`. What the rule can
see is the STATIC parks: approval gates, the four inline kinds, and the unbounded human-wait gates
(`human-review`). A park raised dynamically mid-run (an agent-raised decision, a judge `park`) is
not knowable at start time, which is one more reason the answer paths below still matter.

The human-wait gates were the late addition, and the lesson generalises past this tracker: the rule
had been written against the two park mechanisms anyone would think of (a flag on a step, a kind
that blocks) and missed the third (a gate that never stops polling), which is exactly the one
carried by `pl_full`, the preset most board tasks run. Whenever a mechanism is enumerated by hand,
ask what the enumeration is derived FROM; `HUMAN_WAIT_GATE_KINDS` now has a drift guard deriving
its expectation from the gate registry, and that is why a future built-in cannot repeat this.

**The notification inbox is not the escape hatch.** `notificationActEffect` handles `merge_review`,
`pipeline_complete`, `merge_tag_request`, `ci_failed`, `test_failed` and `key_drift`. None of them
resolves an approval gate, a clarity review or a brainstorm round.

**Recovery exists, so nothing is stuck forever**: `POST /api/v1/jobs/:id/cancel` and
`POST /api/v1/tasks/:taskId/stop` both clear a park. The cost is the run's work, not the workspace.

## Slices, in priority order

Each is the external counterpart of a service method the SPA already calls: the shape ADR 0030
established. None needs new engine machinery.

### A0: Stop the refusal advertising unanswerable parks ✅ (this PR)

Not an addition: the honesty fix that makes the gap above safe to leave open while A1–A4 are
scheduled. `parkingRefusalMessage` (`publicApiAdmission.ts`) now builds the
`pipeline_requires_decide_scope` body from the pipeline's ACTUAL park surfaces, naming the ones the
public decision surface cannot answer and pointing at `POST /api/v1/jobs/:id/cancel` as their only
exit.

The design point worth keeping: `PUBLICLY_ANSWERABLE_PARK_SURFACES` is a set held DELIBERATELY apart
from `PARKING_INLINE_KINDS`, so the asymmetry this tracker documents is machine-readable rather than
prose-only. **Landing any of A1–A4 means adding that surface to the set**: the message and its
drift-guard test then update themselves, where a hand-written sentence would go on promising an
answer path nobody built. (What is admitted was unchanged by A0; the board-start scope rule was
later tightened by ADR 0032, see the settled question below.)

### A1: Approval gates (highest value, lowest cost) ⬜

The internal pair already exists: `POST /executions/:executionId/steps/:approvalId/approve` and
`…/request-changes` (plus reject, a terminal `rejected` failure the board can retry).

The state rides `step.approval` (`stepApprovalSchema`: `id`, `status`, `proposal`, `feedback`,
`comments`), so the decision projection is a **pure read off the run `buildDecisionList` already
holds**, no extra repository round-trip, exactly like the `judge` decision it sits beside. That is
what makes this the cheapest slice and the one to pilot on.

Model it on `toJudgeDecision`. The `proposal` is agent-authored text crossing a rendered surface;
project it as data, and keep the "possibly edited proposal" affordance OUT of v1 unless a consumer
asks: approve/request-changes/reject is the whole lifecycle.

### A2: Agent-raised decisions ⬜

`POST /executions/:executionId/decisions/:decisionId` (`resolveDecisionContract`). Distinct from an
approval gate: an agent raises it and resolving RE-RUNS the same step. Same projection shape.

### A3: Clarity review (bug-report triage) ⬜

Mirrors requirements exactly: same `IterativeReviewService` shape, same reply / set-status /
incorporate / re-review / proceed / resolve-exceeded verb set. The public routes should mirror
`/decisions/requirements/*` verb for verb.

Three pieces of work, not two: a second module read in `buildDecisionList`, a `clarity-review`
decision kind, and the same **item-id re-keying** the requirements twin does. The internal clarity
item routes are review-keyed (`/clarity-reviews/:reviewId/items/:itemId/reply`) while the public
requirements routes deliberately address by ITEM id and resolve the live review from the run's block
(`PublicDecisionController`, `registerRequirementsDecisionRoutes`): a headless caller reads findings
from `GET .../decisions` and never chose a review id. Copy the public shape, not the internal one.

### A4: Brainstorm dialogues ⬜

Both stages (`requirements`, `architecture`). Same verb set again, but keyed by `(block, stage)`
rather than block alone, so the decision projection carries the stage and the routes take it. A block
may hold a live session per stage: the list must be able to carry two brainstorm decisions at once.

### A5: PR deep-review finding selection ⬜

`step.prReview` parks at `awaiting_selection` for a human to curate the reviewer's findings and
resolve (post / dismiss / challenge). Reachable only through `POST /tasks/:taskId/start`, since a
`pr-reviewer` step is container-backed and the initiative surface is inline-only, which is why it
ranks below A1–A4 despite being a genuine dead end. Projection is a pure read off the run, as A1;
the findings are model-authored text crossing a rendered surface, so project them as data.

### A6: Human-verdict gates (human-test, visual confirmation) ⬜

`step.humanTest` and `step.visualConfirm` both park for a person to look at something: a live
environment, a screenshot pair. Lowest priority of the A group and the only slice where "a headless
caller cannot really do this" is a fair objection: the confirm/request-fix verbs are mechanical, but
the judgement they record is the one thing an API consumer is least able to supply. Worth exposing
for the integration that drives its OWN human through a different UI; not worth it otherwise. Listed
so the omission is a decision on the record rather than a surface nobody noticed.

### B1: `GET /api/v1/me` (key introspection) ⬜

There is no way for a caller to ask what its own key can do. Every `403 insufficient_scope` is
currently discovered by attempting the action. A two-field response (workspace id, scope) makes an
integration's startup self-check possible and costs one read. Small, and it pairs naturally with the
scope work above, since A1–A4 make scope more load-bearing.

### B2: `GET /api/v1/openapi.json` ⬜

ADR 0030 already calls this "trivial once wanted: the spec already ships as a repo file, so an
endpoint is only packaging". It becomes materially more useful once A1–A4 widen the surface.

### C1: Notification-webhook management under `/api/v1` ✅

Was managed only over the session-authed `GET|PUT|DELETE /workspaces/:ws/notification-webhook`
behind `integrations.manage`, with deliberately no SPA panel, so a deployment whose operator is
headless had NO route to register the receiver that the run-lifecycle push exists to feed: the
delivery contract was headless and its enrolment was not.

`GET|PUT|DELETE /api/v1/notification-webhook` now serve the same three verbs at `admin` scope,
delegating to the same `NotificationWebhookService` the session controller calls (so the SSRF guard,
the keep-on-omit rule per field and the one-row-per-workspace invariant cannot differ by surface).
The session routes stay: an operator with a browser keeps the surface they had.

Three decisions worth keeping:

- **`admin` on the READ too**, where `read` was arguable (the projection carries no secret). ADR 0034
  decides it: a scope can be relaxed later without breaking a live key, never tightened, so between
  two close readings the strict one is the reversible one.
- **The read is WRAPPED (`{ webhook: … | null }`), the write is not.** A bare nullable body is an
  honest wire shape and a poor generated one: Go decodes a `null` body into a zero-valued struct, so
  "nothing registered" would reach a caller as an endpoint whose URL is the empty string. The write
  always has an endpoint to describe, so wrapping its response would hand every client a null to
  check that cannot occur.
- **The secret stays write-only on this surface too.** An `admin` key can ROTATE the signing secret
  and can never read the stored one, which is what stops a leaked key from becoming the ability to
  forge deliveries a receiver would verify.

### D1: Ticket context on task creation ✅

Not a park surface, so it sits outside the A/B/C ranking, but it is the same class of gap: an input
the SPA has and the API did not. `POST /api/v1/services/:serviceId/tasks` now takes an optional
`ticket` (`{ source, ref }`, key or URL), imports the issue and ATTACHES it, producing the same
linkage the app's create-from-issue does. Before this a headless intake could only paste the issue
into `description`, keeping the words and losing the identity: no writeback of the run's
clarification questions, no reply path on the ticket, no dedupe.

Three decisions worth keeping:

- **The ticket resolves BEFORE the block is created.** The other order half-succeeds in the
  direction that matters, handing back a `201` for a task that carries no ticket and runs on its
  title alone.
- **The dedupe is a CLAIM, and the loser is rolled back.** The pre-check above is the fast path,
  not the guarantee: it has already returned by the time the block is created, so two filings of
  one ticket both pass it, and redelivery is exactly what produces two. `TaskRepository`'s
  `claimBlockLink` is the invariant (`… AND linked_block_id IS NULL`, evaluated under the row lock
  the UPDATE takes), and the filing that loses removes the task it just created before raising the
  same `409` a pre-check would have. Without the rollback the refusal is self-defeating: the
  caller retries, and the leftover is the duplicate the whole feature exists to prevent. The
  app's create-from-issue shares the claim but deliberately NOT the rollback: a person is looking
  at the board and can see the leftover, where a rollback deletes a block out from under them.

Worth stating rather than discovering: **naming a `ticket` does not work in mothership mode yet**,
and not because of anything this slice did. Importing the issue reads the workspace's task
connection and upserts the projection, and that whole write surface (`taskRepository.upsert` /
`linkBlock`, `taskConnectionRepository.getByWorkspace`) is `pending` on the persistence
allow-list, so a node with no main database answers `unknown_method`. `claimBlockLink` is
classified `pending` beside its siblings for the same reason: proxying a claim whose surrounding
import cannot be proxied buys nothing. A ticket-less create is unaffected. Moving the task-source
writes as one slice is what turns this on, and it belongs to the mothership tracker, not here.

- **The linkage is NOT projected onto `publicTask`.** A `201` already means the ticket is attached
  and the `409` (`ticket_already_linked`, `details.taskId`) already names the task holding it, so
  the projection would buy only "which ticket is this task from" on a READ. That read is the list
  endpoint too, and a per-task issue lookup there is a banned N+1: it needs a batched
  `TaskRepository` block→issue method mirrored D1 ⇄ Drizzle with a conformance assertion. Worth
  doing as its own slice if a consumer asks; not worth smuggling in behind a create.

### C2: Step output on `GET /api/v1/tasks/:taskId/run` ⬜

`publicJob` carries a `result`; `publicRun` carries step states, the PR and the error, but no step
output. A board task running an inline-only pipeline (a spec-writer, say) therefore produces a
deliverable the API cannot read. Lowest priority of the set (the container pipelines that dominate
board work deliver through the PR) but worth doing if a consumer asks for inline board work.

## Considered and NOT recommended

Recorded so these are not re-proposed:

- **`since` / incremental polling on the task list.** Still not deliverable, re-verified against the
  Drizzle schema: `blocks` carries no `created_at` or `updated_at`. ADR 0030's reasoning stands
  unchanged: a real `since` means adding a timestamp column to the hottest table in the system, and
  it stays unbundled until a consumer asks for it.
- **The fork-decision CHAT.** Deliberately excluded by `headless-clarification-loop.md`: it is an
  interactive deliberation affordance, and a headless caller already receives each fork's full
  approach / trade-offs / risk text.
- **Recurring-pipeline schedules** (`/recurring-pipelines/*`). A headless caller driving the API has
  its own scheduler; exposing ours duplicates it and adds a second place for a schedule to fire from.
- **`POST /bootstrap`.** Unchanged from ADR 0030's Tier 4: container-backed and force-pushes to
  GitHub, breaking the "public runs never touch GitHub" invariant.
- **Per-step lifecycle webhook events.** ADR 0030 rejected this as a firehose; the SSE endpoints
  already serve a caller wanting step-level detail, bounded by their own poll.

## Gotchas any slice here inherits

- **No parallel logic, ever.** Every action delegates to the SAME service method the SPA controller
  calls, so the park's CAS / approval-id arbitration applies identically whichever surface answers
  first. Racing surfaces are already arbitrated; do not add locking.
- **Every response is the run's whole decision list**, not the one entity touched: the interesting
  outcome is what the run is NOW asking. Re-read the run AFTER acting.
- **Carry the RUN's initiator, not the caller's.** These routes accept a board task run, very likely
  started by a real user whose PAT the resumed container work needs
  (`runWithInitiator` / `PatPreferringAppRegistry`). "A headless caller has no user, so skip it" is
  wrong.
- **A parked run waits forever.** There is no decision timeout; do not design against one expiring.
- **`PublicDecisionController` keeps hand-built error envelopes on purpose**: failures are DATA
  there, so the contract handlers stay typed against their declared response schemas. Follow the
  existing shape rather than throwing a `DomainError`.
- **Scope placement.** A1–A6 are `decide`. C1 is `admin`. B1/B2 are `read`.
- **Add the surface to `PUBLICLY_ANSWERABLE_PARK_SURFACES`** (`publicApiAdmission.ts`) as part of the
  slice. That set is what the A0 refusal message and its drift-guard test read, so a slice that ships
  an answer path without updating it leaves the API still telling operators the park is unanswerable.
- **Regenerate `docs/openapi.json`** (`pnpm gen:openapi`) in the same PR, with the
  `COMPONENT_SCHEMAS` + `OPERATION_DOCS` entries each new named DTO needs; CI fails on drift.
- **Update the usage guide** ([`backend/docs/public-api.md`](../../backend/docs/public-api.md)) in
  the same PR: its reference tables (routes, scopes, error codes) are hand-maintained, and a slice
  that ships without the doc leaves the API documenting itself as narrower than it is.

## Open question for the maintainer: SETTLED

Settled by [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md), against this tracker's
"land A1..A4 first" recommendation and for a reason the recommendation could not see when written:
the API-stability commitment closed the tightening window. Under that commitment, taking capability
away from a live `write` key later would itself be a breaking change needing a migration path, so
the permissive rule would have become permanent. `POST /api/v1/tasks/:taskId/start` now requires
`decide` when the resolved pipeline can park (`canParkOnHuman`), matching the jobs surface; the
stricter rule can still be RELAXED later without breaking anyone, which is the direction the
commitment permits. A1..A6 are unaffected (all additive) and still worth landing.
