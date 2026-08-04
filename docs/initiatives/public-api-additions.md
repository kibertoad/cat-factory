# Initiative: public API additions (completing the parked-decision surface)

**Status:** A0, C1, D1 and D2 landed; **A1–A6 landed together**; the start-path scope question settled
by [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md); B1, B2 and C2 not started ·
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

| Park surface              | Lives on             | Public answer path                               |
| ------------------------- | -------------------- | ------------------------------------------------ |
| `requirements-review`     | review module        | ✅ `/runs/:runId/decisions/requirements/*`       |
| implementation fork       | `step.forkDecision`  | ✅ `/runs/:runId/decisions/fork/choose`          |
| judge verdict             | `step.judge`         | ✅ `/runs/:runId/decisions/judge/resolve`        |
| pre-dispatch input gate   | `instance.inputGate` | ✅ `/runs/:runId/decisions/input-gate/…`         |
| approval gate             | `step.approval`      | ✅ `/runs/:runId/decisions/approvals/:id/*`      |
| companion iteration cap   | `step.companion`     | ✅ `…/approvals/:id/resolve-exceeded`            |
| agent-raised decision     | `step.decision`      | ✅ `/runs/:runId/decisions/questions/:id/answer` |
| `clarity-review`          | clarity module       | ✅ `/runs/:runId/decisions/clarity/*`            |
| `requirements-brainstorm` | brainstorm module    | ✅ `…/brainstorm/requirements/*`                 |
| `architecture-brainstorm` | brainstorm module    | ✅ `…/brainstorm/architecture/*`                 |
| PR deep-review selection  | `step.prReview`      | ✅ `/runs/:runId/decisions/pr-review/*`          |
| human-test window         | `step.humanTest`     | ✅ `/runs/:runId/decisions/human-test/*`         |
| visual-confirmation gate  | `step.visualConfirm` | ✅ `…/visual-confirmation/*`                     |
| `human-review` gate       | `step.gate`          | ❌ none, unranked (see below)                    |
| follow-up triage          | `step.followUps`     | ❌ none, **found during A1–A6** (see below)      |
| interview gate            | interview modules    | ❌ none, **found during A1–A6** (see below)      |

**The last two rows were not in the original investigation**, and the table's own warning is why
they are here rather than in a revised count: this enumeration is what was found, not a proof of
exhaustiveness. Both surfaced from the same place, `assertNotIterativeGate` — the engine's list of
parks that ride `step.approval` but refuse the generic approve. Neither has a public answer path
and neither is projected as a decision, so a run parked on one reports `parked: true` with nothing
to answer, exactly as `human-review` does. They are NOT in
`PUBLICLY_ANSWERABLE_PARK_SURFACES`, so no refusal advertises them.

Ranking them is deliberately left open. Follow-up triage is a per-item verb set (file / send back /
answer / dismiss) over items an agent streams mid-run, and an interview gate is a conversational
loop (answer / continue / proceed) whose value to a headless caller is the same open question A6
raises. Neither is reachable from `POST /jobs` (both ride container-agent steps), so both are
board-start-only, which is where A5/A6 already rank.

**The pre-dispatch input gate is the odd row**, and worth reading before adding another: every other
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

**Where this stands:** A1–A6 landed as one change, so the asymmetry the tracker was opened for is
closed: of the surfaces a pipeline can park on, `human-review` is the only one a `decide` key can
start and not answer, and it is unanswerable by construction rather than unbuilt. What remains is
B1/B2 (key introspection, spec endpoint), C1 (webhook management) and C2 (step output), none of
which is a park. The former [open question](#open-question-for-the-maintainer-settled) about the
`POST /tasks/:taskId/start` scope rule is settled (tightened, with
[ADR 0034](../../backend/docs/adr/0034-public-api-stability.md)). When the committed scope
completes, this tracker converts to a numbered ADR under `backend/docs/adr/` (per CLAUDE.md); if it
is instead abandoned, say so here rather than deleting it, so the investigation is not redone.

## The gap, precisely (as it stood before A1–A6; kept for the reasoning)

`buildDecisionList` (then in `PublicDecisionController.ts`, now `decisions/projection.ts`)
enumerated exactly three decisions: `requirements-review`, `fork`, `judge`. Its own closing comment
named the hole:

> a run parked on a surface this projection doesn't model yet (a plain approval gate, a human-test
> window) still reports `parked: true` with an empty list rather than silently claiming all is well.

That is honest reporting of an incomplete surface, not a bug, but the reporting is all a caller
got. Two independent paths led into it:

**1. The initiative surface admits parks it cannot answer.** `PARKING_INLINE_KINDS`
(`publicApiAdmission.ts`) lists four kinds (`requirements-review`, `clarity-review` and the two
brainstorms) and admitting any of them is what the `decide` scope buys. Only `requirements-review`
was answerable. Clarity and brainstorm are separate orchestration modules with their own
repositories, deliberately mirroring requirements, so `buildDecisionList`'s single
`container.requirements` read could not see them, and a `decide` key that started such a pipeline
got a run it could only cancel. **A3/A4 closed this**: the projection now reads each module too,
gated on the run's own step chain so a run that cannot park there pays for no round-trip.

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

### A1–A6: every remaining park type ✅ (landed together)

The six were sliced separately because they were expected to be six PRs' worth of engine work. They
were not: past the first one they are the SAME shape (gate the run, delegate to the service method
the SPA calls, return the re-read decision list), so splitting them would have meant six rounds of
the shared plumbing rather than six independent risks. Landed as one change, with the surface split
into `publicApi/decisions/` (scope / projection / one route module per park family) since the single
controller would otherwise have tripled.

What each turned into:

- **A1 approval gates** — `…/approvals/:approvalId/{approve,request-changes,reject,resolve-exceeded}`,
  projected as `approval-gate`. Two departures from the plan. The **edited proposal IS exposed**
  (`approve` takes an optional `proposal`): it was going to be held back as an in-app affordance,
  but without it the only way to correct an output is to bounce the whole step, and the field is one
  optional string. And `resolve-exceeded` is a FOURTH verb, not three: a companion at its rework cap
  parks on the same approval and refuses the generic approve, so the projection reports `exceeded`
  and the caller reaches for its own route.
- **A2 agent-raised decisions** — `…/questions/:decisionId/answer`, projected as `agent-decision`.
- **A3 clarity / A4 brainstorm** — the requirements verb set twice more, addressed by ITEM id with
  the entity resolved from the run's block (and, for a brainstorm, its stage), as planned.
- **A5 PR deep review** — `…/pr-review/resolve` plus per-finding `dismiss` / `challenge`. `resume`
  is deliberately absent: it nudges a review still IN FLIGHT rather than answering a park.
- **A6 human-verdict gates** — only the two VERDICT verbs per gate (`confirm`/`request-fix`,
  `approve`/`request-fix`). The app's environment-management affordances (recreate / destroy /
  pull-main / recapture) are out: they are things a person does while looking at the environment,
  not answers to the park, and each is an unbounded lever on infrastructure. The A6 caveat stands and
  is now stated in the API docs rather than only here — a caller approving a visual-confirmation gate
  off this projection is approving screenshots it has not seen, because artifact bytes are not
  readable over `/api/v1`.

**The trap this slice actually hit, and the one a future park must not re-hit:** `step.approval` is
the engine's GENERIC parking mechanism. A requirements gate, a brainstorm, a fork choice, a
human-verdict gate, a follow-up triage and an interview all leave a PENDING approval on the step, and
the engine refuses the generic verbs on every one of them (`assertNotIterativeGate`). A projection
that read "pending approval ⇒ approval-gate" would therefore have offered a well-behaved integration
a route the engine answers with a 409, forever — the A0 defect wearing different clothes. The fix was
to extract the engine's own list as `dedicatedParkSurface` (`orchestration/.../step-park.logic.ts`)
and have BOTH the refusal and the projection read it, so what the API offers and what the engine
accepts cannot drift. A conformance test pins it. **A new park that rides `step.approval` adds itself
there**, and the `WRONG_SURFACE_MESSAGES` record fails to compile until it does.

**Left behind, deliberately:** the SPA's `dedicatedParkView` (`utils/pipelineRender.ts`) still
carries its own copy of the shared cases, because it answers the adjacent question of which OVERLAY a
step click opens and it cannot import the classifier — the built-in gate kinds live in
`orchestration` (`HUMAN_TEST_AGENT_KIND`) where the frontend cannot see them. Converging the two
means moving those constants into `@cat-factory/contracts` first, which is a change worth making on
its own rather than smuggled in behind this one.

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
- **`PUT`'s `url` became optional so keep-on-omit is uniform.** Publishing the endpoint is what
  forced the question: three separate places in the first draft described the rule as covering every
  field, because that is the mental model a partial `PUT` creates, while the schema required `url`.
  Rather than trim the docs to the accident, the schema moved. A mandatory re-send made the routine
  edit carry a value the caller never meant to change, and a client re-sending a URL cached before
  someone else rotated the receiver would redirect every future delivery while looking like it only
  added a subscription. The first `PUT` on an empty workspace still needs one
  (`reason: 'webhook_url_required'`). Worth doing BEFORE the version shipped: relaxing a required
  field stays legal afterwards, but the false doc would have been baked into four published SDKs.

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

### D2: Requirements documents on task creation ✅

The other half of D1, and the same class of gap: an input the app has and the API did not.
`POST /api/v1/services/:serviceId/tasks` now takes an optional ordered `documents` list, each entry
either a page NAMED in a connected document source (imported and attached, as D1 does for a ticket)
or an `upload` CARRYING the text.

Worth reading before extending it, because the shape was not obvious:

- **The gap was never "documents are missing", it was SIZE.** `description` caps at 2,000
  characters because it is a task's own framing, echoed into every prompt; the `POST /jobs` brief
  takes 50,000 but drives inline pipelines that never touch a repository. So a headless caller
  holding a PRD had no way to get it in front of a run that opens a pull request. That is why the
  `upload` variant is the load-bearing half rather than a convenience: naming a Confluence page
  only helps a caller whose spec is already on a wiki.
- **`upload` is a `DocumentOrigin`, NOT a `DocumentSourceKind`, and the split is the design.**
  Everything a provider does (connect, search, import a ref, `probeVersion` a stored copy against
  the live page) is defined only for a connectable source, and there is no `upload` provider to
  ask. Keeping the narrow union on those surfaces is what makes the absence a compile error rather
  than an `undefined` at whichever call site reaches for the missing provider first; the wide union
  covers only the stored row and its block/role links, where the origin is a label. A future
  origin with no provider (a pasted-in artifact, a generated brief) copies this rather than
  widening `DocumentSourceKind`.
- **The readability refusal at the boundary is STRICTER than the run-time one, on purpose.**
  `hasReadableContent` passes anything with a non-empty raw body, because a container agent opens
  the materialised markdown and can at least see what is in it; only the excerpt-only inline
  readers refuse a body that renders to nothing. `assertUploadReadable` refuses it for everyone,
  because here the bytes are in hand and the caller can fix them, where the run-time refusal costs
  a step already paid for. The run-time refusal stays: it is the one that covers a page whose
  SOURCE went empty after import.
- **An uploaded document has no URL, and every reader had to be taught the difference between
  "no origin" and "a broken one".** `originSuffix` / `originHeaderLine` (kernel) are what the
  prompt index, the inline injection and the `.cat-context/` file header all render through, so
  none of them can emit `Title ()` or a bare `Source:` line. The SPA does the same by rendering a
  non-anchor row.
- **A `201` means the task carries every document named**, so an attachment that fails after the
  block exists takes the task back off the board, exactly as a lost ticket claim does. The
  documents themselves stay (a projected document is what a plain import produces anyway), so a
  retry re-imports rather than accumulating half-written state. The attach runs BEFORE the ticket
  claim on purpose: a block removed after a successful claim would leave the ticket pointing at a
  task nobody can open, which then refuses every future filing of it.
- **The rollback detaches by BLOCK, never by the refs it resolved.** A rollback can be running
  BECAUSE the attach was refused (a named document belongs to another task), and clearing that
  document by ref would strip the task that legitimately holds it — the same silent loss the guard
  just refused, committed by the cleanup path. Asking "what is attached to the block being removed"
  can only ever clear links this creation made.
- **The uploads are WRITTEN LAST, after the whole list resolves.** An import is idempotent on its
  `(source, externalId)` key, so a retry lands on the same row; every upload mints a fresh id, so
  an eagerly-written one leaves an unreachable copy behind on each attempt. Writing them after the
  refusable half means an integration retrying in a loop cannot fill a workspace with orphans.
  Anything added here that MINTS rather than keys must go in the same pass.
- **The corpus bound was deliberately NOT duplicated.** The contract caps one document
  (100,000 characters) and the list (10 entries); the ~256 KB materialised-context budget is
  enforced where it always was, at the first dispatch, because it also sizes in linked tracker
  issues this endpoint cannot see. A second, partial "too much context" rule here would disagree
  with it and read as an all-clear.

Same mothership caveat as D1, and for the same reason: `documentRepository.upsert` / `linkBlock`
are `pending` on the persistence allow-list, so naming `documents` on a node with no main database
answers `unknown_method`. A document-less create is unaffected. Moving the document write surface
is one slice of the mothership tracker, not this one.

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
- **A park that rides `step.approval` is classified through `dedicatedParkSurface`, never re-listed.**
  Offering a caller the generic approve verbs on a park the engine refuses them for is a 409 loop, and
  a second copy of the list is how that arrives (see A1–A6 above).
- **Two SDK-generation rules bite the CONTRACT, not the emitter.** A REQUEST body field may not carry
  a valibot `default` (`v.optional(x, y)`): a default means "always present" outbound and "may be
  omitted" inbound, and the emitters read the former, so four published clients would insist on a
  value the API does not need. Apply the fallback at the call site instead and document it on the
  field. And an enum reused by more than one DTO is DEDUPED by value-set into a single named type,
  whose name is taken from whichever DTO the walk reaches first — so reusing a picklist an existing
  DTO already published silently RENAMES a released type. Pin it in `INLINE_ENUM_NAMES`
  (`scripts/sdk/ir.mjs`) to the name that shipped.
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
