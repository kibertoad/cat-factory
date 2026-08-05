# Initiative: public API additions (completing the parked-decision surface)

**Status:** A0, C1, D1, D2, **E1 and E2** landed; **A1–A6 landed together**; **A7 (follow-up
triage) and A8 (interview gates) landed together**; **B1 and B2 landed together, with the
unanswerable-park report beside them**; the start-path scope question settled by
[ADR 0034](../../backend/docs/adr/0034-public-api-stability.md); C2 and F1 not started ·
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
| `human-review` gate       | `step.gate`          | ❌ unanswerable by construction, but now NAMED   |
| follow-up triage          | `step.followUps`     | ✅ `…/decisions/follow-ups/items/:itemId/*`      |
| interview gate            | interview modules    | ✅ `/runs/:runId/decisions/interview/*`          |

**The last two rows were not in the original investigation**, and the table's own warning is why
they are here rather than in a revised count: this enumeration is what was found, not a proof of
exhaustiveness. Both surfaced from the same place, `assertNotIterativeGate` — the engine's list of
parks that ride `step.approval` but refuse the generic approve. A7/A8 below built them, so the
table's ❌ column is now `human-review` alone.

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

**Where this stands:** A1–A6 landed as one change and A7/A8 finished the table, so the asymmetry
the tracker was opened for is closed: of the surfaces a pipeline can park on, `human-review` is the
only one a `decide` key can start and not answer, and it is unanswerable by construction rather than
unbuilt. E1/E2 then closed the other half of "what can a headless consumer NOT do here": read what a
run PROVED, and get a key without a browser. B1/B2 closed the discovery half (what is my key, what
is this API), and B3 beside them turned the one remaining ❌ from silence into a named report: a run
stopped on `human-review` now SAYS so, which is as close to answering it as this surface can get.
What remains is C2 (step output), which is not a park, plus the ONE admission gap A8 surfaced and
did not close (a deployment's own unbounded-wait gate, ranked as F1 — B3 reports such a gate at run
time but deliberately does not classify it). The former [open question](#open-question-for-the-maintainer-settled) about the
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

### A7 follow-up triage / A8 interview gates ✅ (landed together)

The two rows the A1–A6 investigation added to the table, and the reason they landed as one change is
the reason A1–A6 did: past the shared plumbing they are the same shape. Ranking them was left open
above; what settled it is that they were the last two ❌ rows with something to build, so leaving
them meant the table stayed a list of known holes rather than a record of a finished surface.

- **A7 follow-up triage**: `…/decisions/follow-ups/items/:itemId/{file,send-back,answer,dismiss}`,
  projected as `follow-ups`. The verb set is per ITEM because that is the unit of the decision, and
  it is addressed by item id for the reason the approval routes take `approvalId`: a pipeline may
  carry more than one follow-up-enabled Coder step and the engine routes each item to the step that
  surfaced it. `send-back` is named for what it does rather than for the `queued` status it records;
  the projection's `status` is what a caller reads back, so the two words never have to agree.
- **A8 interview gates**: `/runs/:runId/decisions/interview/{answer,continue,proceed}`, projected as
  `interview`. ONE route set for every interview gate rather than one per gate, keyed by RUN alone:
  which interviewer is asking is a property of the parked step, so the server resolves it instead of
  making the caller name a gate it read out of the same projection a moment earlier.

Six things worth reading before extending either:

- **A7 is the first decision that is NOT a park.** Follow-up items accrue live while the Coder is
  still running and can be decided before it finishes, so the projection lists them whenever any item
  is `pending` rather than once the run is `blocked`. Every other `isLive*` predicate here is "the
  park plus the in-flight states either side"; this one is "is anything undecided". An integration
  that triages as items arrive never sees the run stop, which is the whole point of the companion.
- **A8 needed a new seam, and it is a VIEW rather than an entity.** The two interview gates store
  their Q&A on entities that belong to their own features (an `initiatives` row, a
  `doc_interview_sessions` row) and the controller spine is generic over that entity, so there was
  nothing kind-agnostic to project. `InterviewGateKind.view` + `InterviewGateController.getView` add
  it: the shared `InterviewView` carries the loop (questions, round budget) and deliberately NOT the
  product each gate converges on (an authoring brief; a goal / constraints / non-goals), because
  that is the part that genuinely differs and the part nobody answers. A third interviewer
  implements `view` and needs no route, projection or decision kind of its own.
- **What a third interviewer DOES still need, because the two halves have different reach.**
  Admission reads the `interview-gate` trait off the agent-kind registry, so a deployment's own
  interviewer counts as a park the moment it is REGISTERED. Answering it needs its controller WIRED
  as well: `ExecutionService.wiredInterviewGates` is a hand-kept list of the controllers this
  deployment built, because an interview gate is not registry-constructed the way an agent kind is
  (it needs its feature's store and service). Registered-but-unwired is therefore a real state, and
  it is reported honestly rather than papered over: admission refuses a plain `write` key, the
  projection lists nothing, and the routes 503 naming the kind. Closing that gap means giving
  interview gates a registration seam of their own, which is a bigger change than this slice and is
  not blocking anyone today (both built-ins are wired by both facades).
- **A question's `status` is DERIVED, not read.** The planning interviewer keeps an explicit
  `open`/`dismissed` marker beside the answer; the document interviewer has only the answer. One
  derivation (`dismissed` → dismissed, else non-empty answer → `answered`) is what lets a caller
  read both through one shape, and it is the platform-computes rule: neither entity stores the
  three-way value the wire carries.
- **`questionId` is nullable and that is load-bearing.** Both Q&A schemas make the id optional so a
  hand-authored or imported exchange still parses. Such a question cannot be answered individually,
  and projecting the null says so, where omitting the exchange would read as a response that lost a
  question.
- **The refusals split three ways and each says something different**: no parked interview → 404
  (`no_interview`), an interviewer this deployment never wired → 503 naming the kind, and a run the
  key cannot see → the shared 404 `not_found`. Collapsing the first two would tell an operator
  staring at a stopped run that it is not stopped.

**The admission half, which is where this got interesting.** The gotcha list says a slice adds its
surface to `PUBLICLY_ANSWERABLE_PARK_SURFACES`; for these two that raised the prior question of
whether `parkSurfacesOf` can see them at all, and the two answers came out opposite:

- **Interview gates ARE now enumerated**, as a fourth park mechanism read off the `interview-gate`
  TRAIT. This closes a hole worse than the `human-review` one it rhymes with: an interviewer is an
  INLINE step, so a pipeline built out of interview steps satisfied the inline-only rule and was
  reported `headlessStartable` (the flag that tells a caller a `write` key can drive it end to end)
  while every run of it stopped on the first batch of questions. No shipped preset changes hands
  (`pl_initiative` and `pl_document` both carry a later human gate and were already admitted as
  parking on that), so this is a refusal getting more accurate, not capability moving.
- **Follow-up triage is deliberately NOT enumerated**, and this is the decision to re-read before
  "fixing" it. The companion is seeded on every Coder step unless a pipeline turns it off, so
  counting it would make `pl_simple` and `pl_build` (the presets whose selling point is that they
  never pause) `decide`-only, and take board starts away from every live `write` key at once. That
  is a bigger break than the gap it closes, and the gap is no longer the one admission exists to
  prevent: the park has an answer path now, so a run that stops there is recoverable with a `decide`
  key instead of being app-only. Revisit if the companion's default ever flips off. The
  asymmetry is STATED in `public-api.md`'s scope section rather than left for an operator to
  discover, which is the same honesty rule A0 established for the refusal message.

### B1: `GET /api/v1/me` (key introspection) ✅

`{ keyId, accountId, workspaceId, scope, label, createdAt }` at `read` scope. Two departures from
the plan, both about where the answer comes from:

- **It costs NO read**, where the plan budgeted one. `PublicApiKeyService.authenticate` already
  loads the row to verify the secret, so the two extra facts ride out on `PublicApiKeyAuth` rather
  than being fetched again. Anything else `/me` grows should come from there for the same reason,
  or it turns the cheapest call on the surface into two round trips.
- **It is its OWN small resource, not the `publicApiKey` row `/api/v1/keys` lists.** This answers
  "who am I", which must stay answerable to every key including a `read` one, where listing keys is
  an `admin` operation. Reusing the row would also have published a shape whose audience is key
  ADMINISTRATION — revocation, provenance — in the one call an integration makes before it does
  anything.

### B2: `GET /api/v1/openapi.json` ✅

ADR 0030 called this "trivial once wanted: the spec already ships as a repo file, so an endpoint is
only packaging", and packaging is exactly where the work was:

- **The facades cannot read the repo file.** The Worker is a bundle with no filesystem and the
  published `@cat-factory/server` ships `dist` alone, so `pnpm gen:openapi` now writes a SECOND
  artifact, `server/src/modules/publicApi/openapiDocument.generated.ts`, holding the document as
  one JSON string. The `.generated.ts` suffix is load-bearing (it is what the formatter and linter
  already exempt; a reflowed file would sit permanently at odds with its own drift guard), and a
  string rather than an object literal because the endpoint answers with bytes (so nothing
  re-serialises it, and the served and committed copies cannot differ) where a 360 KB object
  literal would cost every `tsc` run a structural check for nothing. `check:openapi`
  diffs BOTH copies, and reports both before exiting so one regeneration does not look like a
  partial fix.
- **It is deliberately NOT an operation in the spec it serves.** Its response schema is "any JSON
  object", which would mint an untyped method in four generated clients and an MCP tool that pours
  the whole schema into a model's context to describe tools it already has. Hand-mounted like
  `POST /api/v1/mcp`, with the same obligation: it is public surface under the stability
  commitment, and `backend/docs/public-api.md` carries that in the spec's place.
- **Authenticated**, at `read`. The document leaks no workspace state, but an anonymous route here
  would be the one endpoint a probe could confirm without a key, and the spec is the map of
  everything else.
- **It puts the spec on every future addition's growth path**, which is worth naming before someone
  hits it under pressure. Both facades bundle that string, and Cloudflare's limit is on the
  COMPRESSED bundle, where a JSON spec does very well, so there is no problem today and no reason to
  pre-optimise. The escape hatch when there is one is to gzip at generate time and inflate through a
  `DecompressionStream` in the handler, which both runtimes have: that keeps the endpoint answering
  with bytes and the drift guard diffing one artifact, where a runtime read of `docs/openapi.json`
  (the obvious alternative) is the thing neither facade can do. Recorded so the first person to see
  a bundle warning does not re-litigate the generated-module decision.

### B3: name the parks the decision list cannot model ✅

Not in the original ranking, and it is the other half of what A0 started: A0 stopped the REFUSAL
advertising unanswerable parks, and this stops the RUN reporting one as silence.

`publicDecisionList` gained `unanswerable[]`, each entry naming a wait this surface cannot answer
with a closed `reason`, the `stepKind`/`stepIndex` holding the run, and prose saying where the
answer lives. Three causes: `human_wait_gate` (a shipped rearming gate — `human-review`),
`unclassified_gate` (a gate the DEPLOYMENT registered, whose `pollExhaustion` F1 explains is
unreadable at request time) and `unwired_interview_gate` (the registered-but-unwired state A8
recorded and left reported as nothing).

Four things worth reading before extending it:

- **The riddle's worst form was not `parked: true`.** An unbounded wait gate re-arms and leaves the
  run `running` between polls (the honest state — the engine is still probing), so the case a
  caller actually hit was a run that read as WORKING and never moved. `unanswerable` is therefore
  not gated on `parked`, and this tracker's own prose describing the symptom as "`parked: true`
  with an empty list" was half the picture.
- **A BOUNDED built-in gate is never listed.** `ci` looping through its fixer is the gate doing its
  job; reporting it would read as a demand for a human nobody has to meet, which is the same
  misreport in the other direction (a caller escalating a run that was going to resolve itself).
  Telling the two apart needed a second shared constant, `BUILTIN_GATE_KINDS`, pinned by the same
  drift guard as `HUMAN_WAIT_GATE_KINDS` and read for its NEGATIVE.
- **"Unanswerable" is a claim about THIS response, and about a run that is still going.** Two more
  exclusions belong to that same misreport-in-the-other-direction family, and neither is visible
  from the step chain alone, which is why both are passed IN rather than re-derived:
  - A run that has ENDED lists nothing. `failRun` records the failure and stops; it never walks the
    chain settling steps, so a stopped run keeps its in-flight gate step exactly as it stood. Read
    off the steps alone, the surface answered someone who had just cancelled a run with "a reviewer
    must approve the pull request" and offered them the stop call they had already made.
  - A wait the SAME payload answers is not listed. A deployment gate that exhausts hands off to
    `onExhausted`, which raises an ordinary step approval: a `decisions[]` entry. The gate state
    stays on the step, so both halves of one response described it, and only one of them was true.
    The excluded set is derived from the assembled decisions (every kind carrying a `stepIndex`)
    rather than re-deduced, so a new step-anchored decision kind joins it with no second edit.
- **It does not close F1, and must not look like it.** Naming a custom gate is not classifying it:
  the surface says "the run is on this gate, and whether it ever ends is declared where the gate
  was built". A future `pollExhaustion`-at-registration (F1's shape) would let this promote such a
  gate to `human_wait_gate`, and until then over-reporting is the safe direction, because the
  alternative is silence about a run that may never move.
- **The prose `detail` is a `reason` first.** The vocabulary is what an integration branches on;
  the sentence is for the human reading the alert it raised.

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

### E1: Run EVIDENCE, the verification report + artifacts ✅

`GET /api/v1/runs/:runId/report`, `GET /api/v1/runs/:runId/artifacts` and
`GET /api/v1/artifacts/:artifactId/blob`, all `read` scope. The gap: everything the platform
CAPTURED about a run was reachable only from a browser session, so a consumer whose job is to judge
a run (a trial harness deciding whether to accept a change, an evaluation pipeline scoring a fleet)
had to scrape the fenced JSON block out of a pull-request body for the report and could not reach
the captured screenshots at all: the caveat A6 recorded against the visual-confirmation gate
("approving screenshots it has not seen") was the same hole seen from the other side.

Decisions worth keeping:

- **The report is served VERBATIM**, the engine's own `PrVerificationReport`, composed on read by
  the same code that writes the PR section (`PrVerificationReportController.composeForRun`). A
  second, API-shaped projection of the same facts is how two surfaces start disagreeing about what
  a run proved. The consequence is real and is now stated on the schema: the report shape is part
  of the STABLE surface from here on, so it grows additively.
- **The read differs from the publish in three ways, all about audience**: it answers for a run
  with NO pull request (a headless job, a run that failed before it pushed: the exact set a
  PR-scraping consumer could never see), it does not consult the per-workspace
  `publishPrVerificationReport` opt-out (that is a statement about writing onto someone's PR, not
  about reading your own evidence back), and it does not swallow its failures.
- **The run-scoped reads take `loadScopedRun`, NOT the debug surface's workspace rule**, even
  though a `read` key already reaches far more through `/api/v1/debug/*`. What decides it is the
  PATH: `debug-api.md` records "two access semantics behind one name" as the reason the debug reads
  are not under `/api/v1/runs/:id/…`, and that reason binds whoever mounts there next. The
  excluded set (frame/module-anchored runs) has no task and no PR, so no verification story.
- **The BYTES needed a binary response the SDK chain could not express.** An operation whose
  success media type was neither JSON nor SSE fell through to `result: null`, which every emitter
  renders as a method returning NOTHING: a published client that reaches the endpoint and
  discards its body. The IR now marks `binary` alongside `stream`, each of the four transports
  hands the bytes back in its own idiom, and an UNKNOWN media type fails generation rather than
  falling through. The MCP facade omits it with a stated reason (a tool result has no shape for an
  arbitrary byte stream), and the omission expectation is now derived from the spec's media types
  rather than a pinned list.
- **`503`, never an empty list**, when the account configured no blob backend: "this deployment
  stores no artifacts" and "this run captured none" are different facts, and only one is about the
  run. Same reason the artifact list 404s an unknown run rather than answering `[]`.
- **A wiring bug this surfaced, fixed on both facades**: each container built the HTTP layer's
  `resolveBinaryArtifactStore` from account settings while the ENGINE got the (overridable) one
  from `CoreDependencies`, so an override reached one side of the app and not the other. The
  container now reads it off `dependencies`.

### E2: Headless key provisioning ✅

`GET|POST|DELETE /api/v1/keys` at `admin` scope, delegating to the same `PublicApiKeyService` the
session panel calls. Same class of gap as C1: a deployment whose operator is headless could drive
every part of this API except the act of GETTING a key.

The security argument is two enforced bounds, not advice:

- **A minted key can never reach the rung minting requires.** `HEADLESS_MINTABLE_SCOPES` is derived
  from `HEADLESS_KEY_MINT_SCOPE` (`admin`) rather than listed, so the mint chain is exactly one
  link long and a rung inserted later cannot silently widen it. Refused by the contract's own
  picklist, so there is deliberately no hand-written second copy of the rule to drift.
- **Revocation cascades.** Revoking a key revokes what it minted, on both surfaces. Without it a
  leaked provisioning key would survive its own cleanup: the operator kills the credential they can
  see and the ones an attacker made keep working. This needed a new `created_by_key_id` column
  (D1 ⇄ Drizzle, with its own index) and a `revokeMintedBy` repository method issuing ONE statement
  rather than a read-then-loop a concurrent mint could slip through.

`createdByKeyId` is also provenance the app renders: a headless mint stores a null user, so without
a branch in the key panel it would read exactly like a key predating the audit column: "nobody
knows who made this" shown for the one case the platform knows precisely.

### F1: a deployment-registered wait gate is invisible to admission ⬜

Not a park surface to build: a hole in the enumeration that decides which key may start a run, found
while adding the interview mechanism beside it and recorded here rather than left as a comment.

`parkSurfacesOf`'s human-wait case reads `HUMAN_WAIT_GATE_KINDS`, a constant in
`@cat-factory/contracts` naming the BUILT-IN gates that declare `pollExhaustion: 'rearm'` (today just
`human-review`), pinned by a drift guard in `@cat-factory/gates`. A deployment that registers its own
unbounded-wait gate through the public `GateRegistry` seam is not in it, so such a pipeline is
admitted for a plain `write` key and then parks with nothing on this surface able to name it: the
`human-review` defect, one layer out.

Why it was not closed here: a gate's `pollExhaustion` is declared on the object its FACTORY builds
from an engine context, so reading it at HTTP request time means standing a fake context up per
admission call, which is a shortcut rather than a design (the same reasoning
`human-wait-parity.test.ts` records for why the built-in answer is a shared constant).

**The shape of a real fix, so the next iteration does not re-derive it:** let a gate declare
`pollExhaustion` at REGISTRATION time, beside the factory, and have `parkSurfacesOf` read the
registry. That makes the declaration static for every gate rather than only the built-ins, and it
deletes `HUMAN_WAIT_GATE_KINDS` and its drift guard instead of adding a second mechanism beside them.
It is a change to the `GateRegistry` seam (every registration site, both facades), which is why it is
its own slice. Note what it would NOT change: interview gates and the four inline kinds are already
declaration-derived, so this is the last hand-kept entry in the enumeration.

Until then the gap is documented in three places that a person actually reads: the note on
`HUMAN_WAIT_GATE_KINDS`, `parkSurfacesOf`'s "deliberately not here" list, and the scope section of
`backend/docs/public-api.md`. **And B3 now reports it at RUN time**, as an `unclassified_gate`
entry in the decision list's `unanswerable[]`: a caller no longer discovers such a gate as an
unexplained stall. That is a report, not a classification — the surface says the run is on the gate
and that whether it ever ends is declared where the gate was built — so the fix above still has
work to do, and doing it would let the run-time report promote the gate to `human_wait_gate`
instead of adding a third mechanism.

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
- **Scope placement.** A1–A8 are `decide`. C1 is `admin`. B1/B2 are `read`, and `read` for those two
  is load-bearing rather than a default: a startup self-check gated above the floor is a check that
  itself needs a wider key.
- **Add the surface to `PUBLICLY_ANSWERABLE_PARK_SURFACES`** (`publicApiAdmission.ts`) as part of the
  slice. That set is what the A0 refusal message and its drift-guard test read, so a slice that ships
  an answer path without updating it leaves the API still telling operators the park is unanswerable.
  **First ask whether `parkSurfacesOf` produces the surface at all**: A7/A8 is where that stopped
  being automatic. A surface admission cannot see (follow-up triage, by the decision recorded above)
  has no refusal to correct, so adding it to the set is inert, and adding it to the enumeration to
  make it non-inert is a scope change that has to be weighed on its own.
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
