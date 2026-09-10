---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Watch a run that works in chunks: an SSE decision channel, bug-fishing verbs, and a step-boundary
webhook event

Three of the platform's longest operations work in CHUNKS. A PR deep review slices a diff, reviews
the slices in parallel and aggregates. A bug-fishing expedition dispatches one read-only pass per
angle per territory, recording each catch as it lands. A requirements review iterates. Each runs for
minutes to tens of minutes, and none of it reached the stream: an SSE frame is emitted when the RUN
projection changes, and what those operations move through lives on step state the projection does
not carry. A seventeen-minute review produced no frame at all and then one `decision` at the park,
while the public-API guide told a caller to poll the decisions endpoint for exactly the progress the
stream could not give it.

Both `/events` endpoints now take `?decisions=true`, which adds a `decision-state` frame carrying
the run's whole decision list whenever it changes: the same payload
`GET /api/v1/runs/{runId}/decisions` answers, so a slice reporting, a challenge verdict landing or an
expedition's angle settling arrives by push. Opt-in because a decision list is not derivable from
the run in hand and costs point reads per tick; a new event name rather than a richer `decision`,
which is published and announces a park; and the WHOLE list rather than the free step-derived part,
because an empty list that means "I did not ask" and one that means "nothing is being asked" are
opposite facts rendered identically. An unrecognised `?decisions=` value is refused rather than read as
"off", since the channel is silent by nature and a typo served as a working stream reads as a quiet
run.

`bug-fishing` joins the decision surface as a fourteenth kind, with the three verbs the app already
drives: mark findings to be addressed (one bug-fix task per mark), dismiss one, finish triaging. A
parked expedition used to arrive in `unanswerable[]` as a `curation_gate` saying the marking had to
happen in the app, while the step's own approval gate WAS offered, so a `decide` key could end an
expedition with everything it caught unacted on but could not act on any of it. Both shipped curating
kinds are now answerable; `curation_gate` keeps a narrower population, a curating kind a deployment
registered itself.

The outbound webhook's `runEvents` family gains `run.step_completed`, one delivery per step
BOUNDARY, opt-in per event like the rest. This is the narrowing of the per-step feed ADR 0030
rejected, not a reversal: that rejection was about a progress feed the engine emits on every
container poll, where this fires ten times over a ten-step pipeline. Its `deliveryId` carries the
step index, because it is the one event a single run emits repeatedly and the family's two-part key
would collapse a whole pipeline onto its first step; and `step.outcome` distinguishes `skipped` from
`completed`, because the engine skips a gated step by marking it done with no output.

The `/api/v1` spec moves to 1.74.0 and the change is additive throughout. One thing to watch on the
generated clients: bug-fishing's `confidence` vocabulary is `high|medium|low` and a reviewer
finding's `severity` is `low|medium|high`, and the SDK emitter's enum signature is value-sorted, so
the two collapse onto one type whose name and member order come from whichever walks first. Left
alone that deleted `PublicReviewFindingSeverity` from four released SDKs. It is pinned, and the pin
mechanism now fixes member order as well as the name.
