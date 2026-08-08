# ADR 0043: A `decide` key can answer every park it can start

- **Status:** Accepted (implemented)
- **Date:** 2026-08-07
- **Context layer:** backend (`@cat-factory/contracts`, `@cat-factory/orchestration`,
  `@cat-factory/server`) + the four SDKs and the MCP facade

Supersedes the `public-api-additions` initiative tracker, whose committed scope is complete. Builds
on [ADR 0030](./0030-public-api-surface.md) (the `/api/v1` surface) and
[ADR 0034](./0034-public-api-stability.md) (the stability commitment, which settled this work's one
open question). The usage guide is [`public-api.md`](../public-api.md).

## Context

`/api/v1` covered the task lifecycle end to end **except when a run parks on a human**. The public
decision surface answered three park types (`requirements-review`, the implementation fork, a judge
verdict) and the engine had at least a dozen more. The headline finding was not "an endpoint is
missing" but an **asymmetry between what admission lets a key START and what the decision surface
lets it ANSWER**: a caller could put a run into a state only the browser could get it out of, and
the only public exit was cancelling the run.

Two independent paths led into it.

**The initiative surface admitted parks it could not answer.** `PARKING_INLINE_KINDS` listed four
kinds and admitting any of them was what the `decide` scope BOUGHT. Only `requirements-review` was
answerable; clarity and the two brainstorms are separate orchestration modules with their own
repositories, so the projection's single `container.requirements` read could not see them.

**`POST /api/v1/tasks/:taskId/start` applied no pipeline admission at all**, so a plain `write` key
could start any board pipeline, including one carrying an approval gate on an enabled step, and
park it.

Worse than either, the REFUSAL a `write` key received advertised the parks the surface could not
answer: it named all five and told the operator a `decide` key "can answer the park through
`/api/v1/runs/:runId/decisions`". For four of the five that was false, so the refusal was selling a
scope upgrade that buys a run whose only exit is cancel. That is the platform's degrade-loudly rule
inverted: not an incomplete surface reporting itself honestly, but one describing a capability it
does not have.

## Decision

**Close the asymmetry rather than narrow admission**: build the answer path for every park a
pipeline can carry, and make the two halves read the same machine-readable sets so they cannot
drift.

- **Every park type gained routes**, each the external counterpart of the SAME service method the
  SPA controller calls: approval gates (four verbs, because a companion at its rework cap parks on
  the same approval and refuses the generic approve), agent-raised decisions, clarity, both
  brainstorms, PR deep review, the two human-verdict gates, follow-up triage per ITEM, and
  interview gates as ONE route set keyed by run. The surface lives in `publicApi/decisions/`, one
  route module per park family.
- **A park riding `step.approval` is classified through the engine's own
  `dedicatedParkSurface`** (`orchestration/.../step-park.logic.ts`), read by BOTH the refusal
  message and the projection. `step.approval` is the engine's GENERIC parking mechanism and it
  refuses the generic verbs on most of what leaves one, so a projection reading "pending approval
  implies approval-gate" would have offered a well-behaved integration a route the engine answers
  with a 409, forever.
- **`PUBLICLY_ANSWERABLE_PARK_SURFACES` is held DELIBERATELY apart from what admission admits**, so
  the asymmetry is machine-readable rather than prose-only and the refusal message and its drift
  guard update themselves as slices land.
- **`POST /tasks/:taskId/start` now applies the same `canParkOnHuman` scope rule as the jobs
  surface.** (The inline-only rule stays jobs-only on purpose: it exists to keep headless jobs off
  GitHub, not to constrain board work.)
- **What the surface still cannot answer is NAMED at run time**, not left as silence. The decision
  list carries `unanswerable[]`, each entry a closed `reason`, the step holding the run, and prose
  saying where the answer lives: `human_wait_gate`, `unclassified_gate`, `unwired_interview_gate`.
- **The other half of "what can a headless consumer not do here" closed too**: run EVIDENCE
  (`/runs/:runId/report`, `/artifacts`, the artifact blob), key introspection (`/me`), the served
  spec (`/openapi.json`), notification-webhook management, headless key provisioning, and ticket +
  document context on task creation.

## Rationale

**Why the six park types landed as one change rather than six.** They were sliced apart expecting
six PRs of engine work. Past the first they are the SAME shape (gate the run, delegate to the
service method the SPA calls, return the re-read decision list), so splitting them would have meant
six rounds of shared plumbing rather than six independent risks.

**Why the start-path rule was TIGHTENED against this work's own recommendation.** The tracker
recommended landing the answer paths first and leaving the permissive rule alone until then. ADR
0034 closed that window: under the stability commitment, taking capability away from a live `write`
key later would itself be a breaking change needing a migration path, so the permissive rule would
have become permanent. The stricter rule can still be RELAXED later without breaking anyone, which
is the direction the commitment permits.

**Why `human-review` is unranked rather than unbuilt.** It is a polling GATE rather than a
step-state park, so it lives on `step.gate` beside CI and conflicts; what makes it a park is its
`pollExhaustion: 'rearm'`, which says there is no deadline because a person is the gate. There is
nothing to build, because the answer is a human approving the pull request on GitHub, not an API
call this surface could offer. So admission refuses it and the refusal says so, which is the whole
of the fix.

**Why follow-up triage is deliberately NOT enumerated by admission, where interview gates are.**
The follow-up companion is seeded on every Coder step unless a pipeline turns it off, so counting
it would make `pl_simple` and `pl_build` (the presets whose selling point is that they never pause)
`decide`-only and take board starts away from every live `write` key at once: a bigger break than
the gap it closes, and the gap is no longer the one admission exists to prevent now that the park
has an answer path. An interviewer is the opposite case: it is an INLINE step, so a pipeline built
out of interview steps satisfied the inline-only rule and was reported `headlessStartable` while
every run of it stopped on the first batch of questions. The asymmetry is STATED in `public-api.md`
rather than left for an operator to discover.

**Why `unanswerable[]` is not gated on `parked`.** The riddle's worst form was never `parked: true`
with an empty list. An unbounded wait gate re-arms and leaves the run `running` between polls (the
honest state: the engine is still probing), so what a caller actually hit was a run that read as
WORKING and never moved.

**Why a BOUNDED built-in gate is never listed there.** `ci` looping through its fixer is the gate
doing its job; reporting it would read as a demand for a human nobody has to meet, which is the
same misreport in the other direction. Two more exclusions belong to that family and neither is
visible from the step chain alone, which is why both are passed in rather than re-derived: a run
that has ENDED lists nothing (nothing walks the chain settling steps on a failure, so a stopped run
keeps its in-flight gate step exactly as it stood), and a wait the same payload already answers as
a `decisions[]` entry is excluded by deriving the set from the assembled decisions.

**Why the verification report is served VERBATIM.** A second, API-shaped projection of the same
facts is how two surfaces start disagreeing about what a run proved. The consequence is accepted
and stated on the schema: the report shape is part of the stable surface from here on and grows
additively. The read differs from the PUBLISH in three ways, all about audience: it answers for a
run with no pull request (a headless job, a run that failed before it pushed, which is exactly the
set a PR-scraping consumer could never see), it does not consult the per-workspace publish opt-out
(that is a statement about writing onto someone's PR, not about reading your own evidence back),
and it does not swallow its failures.

**Why headless key provisioning is safe.** Two enforced bounds, not advice. A minted key can never
reach the rung minting requires: `HEADLESS_MINTABLE_SCOPES` is DERIVED from the mint scope rather
than listed, so the chain is exactly one link long and a rung inserted later cannot silently widen
it. And revocation CASCADES through a `created_by_key_id` column, because without it a leaked
provisioning key would survive its own cleanup: the operator kills the credential they can see and
the ones an attacker made keep working.

## Consequences

**No parallel logic, ever.** Every action delegates to the same service method the SPA calls, so
the park's CAS and approval-id arbitration apply identically whichever surface answers first.
Racing surfaces are already arbitrated; do not add locking.

**Every response is the run's whole decision list**, not the one entity touched: the interesting
outcome is what the run is NOW asking. Re-read the run AFTER acting.

**Carry the RUN's initiator, not the caller's.** These routes accept a board task run, very likely
started by a real user whose PAT the resumed container work needs. "A headless caller has no user,
so skip it" is wrong.

**A parked run waits forever.** There is no decision timeout; do not design against one expiring.

**A new park adds itself to `dedicatedParkSurface`** (the `WRONG_SURFACE_MESSAGES` record fails to
compile until it does) and to `PUBLICLY_ANSWERABLE_PARK_SURFACES`. First ask whether
`parkSurfacesOf` produces the surface at all: a surface admission cannot see has no refusal to
correct, so adding it to the set is inert, and adding it to the enumeration to make it non-inert is
a scope change to weigh on its own.

**Whenever a mechanism is enumerated by hand, ask what the enumeration is derived FROM.** The scope
rule had been written against the two park mechanisms anyone would think of (a flag on a step, a
kind that blocks) and missed the third (a gate that never stops polling), which is exactly the one
carried by `pl_full`, the preset most board tasks run. The first answer was a pair of hand-kept
constants (`HUMAN_WAIT_GATE_KINDS`, `BUILTIN_GATE_KINDS`) with drift guards deriving their
expectation from the gate registry; [ADR 0050](./0050-public-api-headless-completeness.md) then
deleted both, moving `pollExhaustion` onto the registration itself so admission reads the registry
directly and a deployment's own gate is seen for free. The lesson outlived the mechanism: a guard
over a hand-kept list is a second-best to not keeping one.

**Two SDK-generation rules bite the CONTRACT, not the emitter.** A request-body field may not carry
a valibot `default`: the emitters read it as "always present" outbound, so four published clients
would insist on a value the API does not need. And an enum reused by more than one DTO is deduped
by value-set into a single named type whose name comes from whichever DTO the walk reaches first,
so reusing a picklist an existing DTO already published silently RENAMES a released type; pin it in
`INLINE_ENUM_NAMES`.

**`PublicDecisionController` keeps hand-built error envelopes on purpose**: failures are DATA there,
so the contract handlers stay typed against their declared response schemas.

**Two creation inputs do not work in mothership mode yet**, and not because of anything this work
did: naming a `ticket` or `documents` reads and upserts through repository methods still `pending`
on the persistence allow-list, so a node with no main database answers `unknown_method`. A
ticket-less, document-less create is unaffected. Moving those write surfaces is a slice of the
mothership tracker.

**Two things are deliberately left open**, each recorded so they are not re-derived. Both were
carried, with the rest of the headless-completeness gaps a later sweep found, into
[ADR 0050](./0050-public-api-headless-completeness.md), **which has since closed both**; the
statements below are the reasoning as it stood, not the current surface:

- **A deployment-registered unbounded-wait gate is invisible to admission.** `parkSurfacesOf` reads
  a constant naming the BUILT-IN rearming gates, so a deployment's own is admitted for a plain
  `write` key. The real fix is to let a gate declare `pollExhaustion` at REGISTRATION time and have
  `parkSurfacesOf` read the registry, which makes the declaration static for every gate and DELETES
  the constant and its drift guard rather than adding a second mechanism beside them. It is a
  change to the `GateRegistry` seam (every registration site, both facades), which is why it is its
  own slice. Reading it at HTTP request time instead would mean standing a fake engine context up
  per admission call, which is a shortcut rather than a design. Until then the run-time report names
  such a gate as `unclassified_gate`, which is a report and not a classification.
- **Step output on `GET /api/v1/tasks/:taskId/run`.** `publicJob` carries a `result`; `publicRun`
  carries step states, the PR and the error, but no step output, so a board task running an
  inline-only pipeline produces a deliverable the API cannot read. Lowest priority of the set (the
  container pipelines that dominate board work deliver through the PR), worth doing if a consumer
  asks for inline board work.

**Recorded as NOT recommended**, so they are not re-proposed: `since` / incremental polling on the
task list (`blocks` carries no timestamp column, and adding one to the hottest table in the system
stays unbundled until a consumer asks), the fork-decision CHAT (an interactive deliberation
affordance; a headless caller already receives each fork's full approach / trade-offs / risk text),
recurring-pipeline schedules (a headless caller has its own scheduler), `POST /bootstrap` (it
force-pushes to GitHub, breaking the "public runs never touch GitHub" invariant), and per-step
lifecycle webhook events (a firehose the SSE endpoints already serve, bounded by the caller's own
poll).
