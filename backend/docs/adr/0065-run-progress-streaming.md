# ADR 0065: Watching a run that works in chunks

- **Status:** Accepted (implemented)
- **Date:** 2026-09-10
- **Context layer:** the `/api/v1` decision + streaming surface (`@cat-factory/server`), the kernel
  run-lifecycle port and its webhook sink, the four `sdk/*` clients.

## Context

Three of this platform's longest operations work in CHUNKS. A PR deep review slices a diff and
reviews the slices in parallel, then aggregates. A bug-fishing expedition dispatches one read-only
pass per angle per territory, recording each pass's catch as it lands. A requirements review
iterates. Each runs for minutes to tens of minutes, and each moves through states a caller has a
real reason to watch.

None of that reached the stream. `GET /api/v1/tasks/{taskId}/events` emits a frame when the RUN
projection changes, and the projection is `{agentKind, state, progress, subtasks, output, data}` per
step, where `data` is `step.custom`. What a chunked operation moves through lives on other step
fields: `step.prReview` carries the slice count, the challenge verdicts and the post report;
`step.bugFishing` carries the angles and the catch; `step.humanTest`, `step.followUps` and
`step.judge` carry theirs. So a seventeen-minute review produced no frame at all for its whole
duration and then one `decision` frame at the park, whose payload was the run rather than the
decision. `backend/docs/public-api.md` told a caller to poll `/runs/{runId}/decisions` for the
progress the stream could not give it, which is the surface documenting its own gap.

Two adjacent holes fell out of the same investigation.

**A bug-fishing expedition could be started, watched and only ENDED.** It parks so a person can mark
which findings are worth fixing, and marking had no route here, so the decision surface reported it
in `unanswerable[]` as a `curation_gate` saying the choice had to be made in the app. The step's own
approval gate WAS offered, and resolving it advances the run with everything the expedition caught
unacted on: an exit presented beside no answer. The same fact refused a `decide` key at the start
surface with "this API cannot answer it yet".

**A run that works for hours announced nothing between its edges.** `run.started` and the terminal
pair are the only outbound events, and [ADR 0030](./0030-public-api-surface.md) rejected per-step
events as a firehose because the engine emits on every container poll. That is true of a PROGRESS
feed and says nothing about a step BOUNDARY, which fires ten times over a ten-step pipeline.

## Decision

Three additions, all additive, shipped together at spec version 1.74.0.

### 1. A decision STREAM, beside the decision list it pushes

`GET /api/v1/runs/{runId}/decision-events`: a `decision-state` frame carrying the run's whole
`PublicDecisionList` whenever the serialized payload changes, then a terminal `done` when the run
settles. The payload is byte-identical to what `GET /api/v1/runs/{runId}/decisions` answers.

**Its own endpoint rather than a `?decisions=true` flag on the two run streams, and the SDKs are
what decided it.** The flag was built first, and it broke four released clients: a query parameter
added to an existing operation is emitted as a positional argument ahead of the trailing options
bag, so `client.tasks.stream(taskId, options)` became `client.tasks.stream(taskId, query, options)`
and Go's `Stream(ctx, taskID)` grew an argument. CI caught it as a compile failure in the Go
smoketest; a TypeScript caller passing `{ headers }` would have gone on compiling against the wrong
parameter. There is no position that fixes it, because Go has no optional trailing argument, so any
new input to those operations is an arity change.

A new operation is the additive shape, and it turns out to be the better design. It is keyed by RUN
like the list it streams, so one route serves a board task and a headless job where the flag needed
adding to two; and the run streams stay what they are, which is progress channels. The cost is one
more connection for a caller that wants both, which the run streams' own `decision` frame already
makes unnecessary for anyone who only needs to know that a park happened.

**The frame is the WHOLE list, never a subset.** The cheap version of this feature was to ride only
the step-derived decisions, which are pure over the instance the loop already holds and cost nothing.
It was rejected: `decisions: []` from a run holding a live requirements review is byte-for-byte the
answer a run with nothing to ask gives, and telling those apart is the entire job of the
`unanswerable[]` field beside it.

**What a frame does reduce is the PROSE, and it says so.** The list is re-sent whenever any part of
it moves, and what it carries is model-authored text in quantity: a deep review parks with one
finding per issue, each with a detail, an evidence quote and a suggested fix. Over-long strings are
clipped to a preview and `truncated: true` reports the clip, mirroring `publicRunStep.truncated` on
the run streams and the point read that serves the whole thing. The reduction is kind-AGNOSTIC (it
clips by length wherever text sits), for the reason the frame's change detector compares the
serialized payload rather than a field of it: a rule written per decision kind is one the fifteenth
kind escapes silently.

**And a tick only issues the reads the run's own step chain can need.** The loop polls once a second
for up to five minutes, and the decision projection is the body of that poll. Every separately-stored
park is gated on a step that could produce it: the dialogue reads on the review-gate kinds, the fork
read on a step actually carrying `forkDecision`, the interview read on the run being parked on one.
An ordinary `coder → ci → merger` run therefore pays one read per tick instead of four.

**`read` scope, matching the point read.** Watching what a run is waiting on is a monitoring
concern; answering is what needs `decide`.

### 2. `bug-fishing` joins the decision surface

A fourteenth `publicDecisionKind`, with the three verbs the app already drives through the same
service methods: `…/bug-fishing/address` (one bug-fix task per marked finding), per-finding
`…/dismiss`, and `…/resolve` to finish triaging. Adding `bug-fisher` to
`PUBLICLY_ANSWERABLE_PARK_SURFACES` is what makes the start-surface refusal, the wait report and the
decision list agree at once, because all three read that one map.

The projection publishes what a triaging caller has to weigh and not the platform's own sizing:
`plan.unfished` names the angle-by-territory cells the pass budget cut, `plan.surveyUnavailableReason`
distinguishes a fallback single territory from a genuinely small codebase, and each phase carries its
SELF-REPORTED coverage share so "found nothing here" can be told from "did not look". The territory
DESCRIPTORS are withheld: root paths, subtree shas and a token estimate describe how the hunt was
sized, and every finding and unfished cell already carries the label it was recorded under.

`curation_gate` survives with a narrower population: a curating kind a DEPLOYMENT registered, whose
marking lives wherever that deployment surfaced it. Both shipped curating kinds are now answerable.

### 3. `run.step_completed`, on the step boundary

A fourth member of the `runEvents` family, opt-in per event like the rest of it, carrying
`{ index, agentKind, outcome, final }`.

**One seam, not a hook per site.** Every path that finishes a step and moves the run's cursor funnels
through `RunStateMachine.settleStepAndAdvance` or `settleAdvancedGate`; twelve callers reach the
boundary through those two. This is the lesson the terminal edge already learned (a run reaches
`done` from four sites, so the emit hangs off the emit funnel), applied one level down.

**Published LAST at each seam, after the run's own state is durable.** The two settle methods and
the one-shot path all announce the boundary after their compare-and-swap write and after any run
edge the same settle pushes. Announcing first is a delivery for an advance that can still lose its
CAS, and on a final step it is the run's last step reported complete while the run still reads
running. The block read the projection needs is best-effort and its failure publishes nothing, so a
notification concern cannot derail the advance that called it.

**`deliveryId` carries the step index AND its attempt.** The family's contract is `<runId>:<event>`,
and this is the one event a single run emits repeatedly, along two axes. On the two-part key a
receiver following the documented dedupe rule sees step 0 and nothing else for the rest of the
pipeline. On the three-part key it sees each step once and every RE-RUN of one discarded, which is
not an edge case: a companion bounces its producer for rework, a human-test gate rewinds to its
upstream `deployer`, a `request-changes` loops a range, and a three-cycle rework loop then arrives
as one boundary. `step.attempt` is the step's own start count, so a durable REPLAY of one settle
still reports the same number and still collapses.

**`outcome` distinguishes `skipped` from `completed`.** The engine skips a gated step by marking it
done with no output, which is byte-for-byte a step that ran and reported nothing. It says WHETHER and
not WHY, matching `publicRunStep.skipped`: which axis skipped a step is a vocabulary the engine grows.

**Every boundary is delivered, the skipped tail included.** A `bug-intake` step that finds no issue
to work ends the run early, marking every remaining step `skipped` and finalizing without touching
either settle method. It publishes its own boundaries (the step that decided, then one per skipped
step), because the alternative is a `run.completed` with no boundary at all for the run, which reads
as a pipeline that never had steps rather than as one whose tail was cut.

**The member is APPENDED to `runEvents`, not slotted in beside the edge it belongs with.** The
vocabulary's ORDER is published: Java emits it as an enum whose `ordinal()` an integration may have
persisted, and three more clients expose a `*_VALUES` array in the same sequence. Inserting
re-sequences all four, as a diff that reads like generated churn.

## Rationale

The shape of all three is the same: the platform already knew the thing, and the surface had no way
to say it. None of them needed new state, a new store or a new engine concept. What each needed was a
seam that could not lie by omission, which is why the three rejected shortcuts are worth recording.

**A partial decision payload on the stream** would have been free and would have been wrong in the
one direction this surface spends most of its design on: an empty list that means "I did not ask" and
an empty list that means "nothing is being asked" are opposite facts rendered identically.

**A `?decisions=true` flag on the run streams** was the obvious shape and is the one that shipped
first. It reads well in `curl` and it breaks four SDKs, which is the trade this surface does not
make. Recorded because the reasoning generalises: any input added to an operation four generated
clients already expose is a signature change, and the additive move is a new operation.

**A `run.stepChanged` event driven off the emit funnel** would have been simpler than finding the two
settle seams, and it is the firehose ADR 0030 rejected: the funnel fires on every container poll, so
a single coder step would deliver hundreds of events.

## Consequences

- **`/api/v1` moves to 1.74.0**, additive on every count: a query parameter, a decision kind, three
  routes, one event. `backend/docs/public-api-versions.md` carries the entry.
- **A pinned enum now pins member ORDER too.** Bug-fishing's `confidence` is `high|medium|low` and a
  reviewer finding's `severity` is `low|medium|high`; the SDK IR's enum signature is value-SORTED, so
  the two collapse onto one emitted type, and `PublicBugFishing…` walks first alphabetically. Left
  alone this deleted `PublicReviewFindingSeverity` from four released SDKs and retyped
  `PublicReviewFinding.severity`. `INLINE_ENUM_NAMES` already existed for exactly this and had bitten
  three times before; it now accepts `{ name, values }`, because a pin that fixes the name and lets
  the members be re-declared in the other vocabulary's order is half a pin (a Java `ordinal()` shift
  and a re-sequenced `*_VALUES` array in three more languages, arriving as generated churn). A pin's
  `values` is checked to be a permutation of the real set, because `define` stores it verbatim: a
  typo would emit an enum missing a value the API sends AND re-register it under a signature nothing
  looks it up by, both as ordinary generated churn.
- **Sharing an emitted enum is now a decision with two answers**, and `DISTINCT_ENUM_TYPES` is the
  second. A shared type is right when two surfaces publish the same closed SET; it is wrong when the
  words merely coincide, because the type NAME asserts what the field means. Bug-fishing's
  `confidence` is the agent's own judgement of how sure it is, sitting two fields from a real
  `severity`, so it is emitted as `PublicBugFishingConfidence` rather than borrowing a reviewer
  finding's severity type. Keyed by the property HINT, since separating two vocabularies is exactly
  what one signature cannot do.
- **A deployment with the webhook module wired pays one block read per step boundary**, guarded on
  the sink being present so a deployment without it pays nothing. A step boundary is once per step
  against a run that has just spent minutes in a container.
- **Two splits, both because the change pushed a file past its ceiling**: the SSE loops moved out of
  `PublicApiController` into `publicApiStreamRoutes.ts` with the run projections they share in
  `runProjection.ts`, and the hand-documented (non-contract) spec routes moved out of
  `generate-openapi.mjs` into `scripts/openapi/`. Each is the concern the change touched, extracted
  rather than the budget raised.
- **`sdk/gatekeeper-worker` holds an exhaustive `Record<PublicDecisionKind, DecisionAnswerer>`**, so
  a new decision kind fails its build until it has verbs. Its `DecisionField` gained `shape`,
  declaring that a field takes a LIST: the two finding selections are the only ones that do, and
  neither reader can infer it (a gadget would render a single-value box, and the argument suite
  composes an answer the verb refuses outright).
- **A new curating agent kind still has a decision to make**, and the wait report is what states it:
  register its verbs on `PUBLICLY_ANSWERABLE_PARK_SURFACES` or a run parked on it is reported as a
  `curation_gate` nobody here can answer. That is the honest default, and it is now the only way to
  reach that reason code.
- **The website's Public API page describes the SSE event names and the webhook families**, so it
  needs the three additions. Neither repo's CI can see the other, so that is a separate PR against
  the website; this one names it.
