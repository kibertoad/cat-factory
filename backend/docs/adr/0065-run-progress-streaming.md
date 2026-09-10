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

### 1. A `decision-state` SSE frame, opt-in with `?decisions=true`

Both stream loops take a query flag. When set, each tick projects the run's whole
`PublicDecisionList` and writes a `decision-state` frame whenever the serialized payload changed.
The payload is byte-identical to what `GET /api/v1/runs/{runId}/decisions` answers.

**Opt-in, because a decision list is not derivable from the run in hand.** The three iterative
reviews, the fork and an interview each live in their own store, so projecting one costs point reads
that the run poll does not already pay. Making every existing consumer pay several reads per second
for a channel it never reads would be a regression shipped as a feature.

**A NEW event name, not a richer `decision`.** `decision` is published: it announces a park once and
carries the run. Re-pointing its payload at a different resource is exactly the kind of in-place
re-type `/api/v1` does not do.

**The frame is the WHOLE list, never a subset.** The cheap version of this feature was to ride only
the step-derived decisions, which are pure over the instance the loop already holds and cost nothing.
It was rejected: `decisions: []` from a run holding a live requirements review is byte-for-byte the
answer a run with nothing to ask gives, and telling the two apart is the entire job of the
`unanswerable[]` field beside it. A stream may choose whether to ASK, never how much of the answer to
believe. That is why the choice is a flag on the request rather than a narrowing of the payload.

**An unrecognised `?decisions=` value is refused**, not read as "off". The channel is silent on a
run with nothing to ask, so a typo'd `?decisions=yes` served as a working stream is
indistinguishable from a quiet one and the caller concludes the run never parked. It throws a
`ValidationError` like every other refusal on this API rather than hand-building a body, because a
literal envelope structurally cannot carry the `details.reason` a client branches on.

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

**`deliveryId` carries the step index.** The family's contract is `<runId>:<event>`, and this is the
one event a single run emits repeatedly: on the two-part key a receiver following the documented
dedupe rule would see step 0 and nothing else for the rest of the pipeline.

**`outcome` distinguishes `skipped` from `completed`.** The engine skips a gated step by marking it
done with no output, which is byte-for-byte a step that ran and reported nothing. It says WHETHER and
not WHY, matching `publicRunStep.skipped`: which axis skipped a step is a vocabulary the engine grows.

## Rationale

The shape of all three is the same: the platform already knew the thing, and the surface had no way
to say it. None of them needed new state, a new store or a new engine concept. What each needed was a
seam that could not lie by omission, which is why the two rejected shortcuts are worth recording.

**A partial decision payload on the stream** would have been free and would have been wrong in the
one direction this surface spends most of its design on: an empty list that means "I did not ask" and
an empty list that means "nothing is being asked" are opposite facts rendered identically.

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
  and a re-sequenced `*_VALUES` array in three more languages, arriving as generated churn).
- **A deployment with the webhook module wired pays one block read per step boundary**, guarded on
  the sink being present so a deployment without it pays nothing. A step boundary is once per step
  against a run that has just spent minutes in a container.
- **The SSE loops moved out of `PublicApiController`** into `publicApiStreamRoutes.ts`, with the two
  run projections they share in `runProjection.ts`. The controller was 40 lines under the size
  ceiling; the split is the concern this change touched, extracted rather than the budget raised.
- **A new curating agent kind still has a decision to make**, and the wait report is what states it:
  register its verbs on `PUBLICLY_ANSWERABLE_PARK_SURFACES` or a run parked on it is reported as a
  `curation_gate` nobody here can answer. That is the honest default, and it is now the only way to
  reach that reason code.
- **The website's Public API page describes the SSE event names and the webhook families**, so it
  needs the three additions. Neither repo's CI can see the other, so that is a separate PR against
  the website; this one names it.
